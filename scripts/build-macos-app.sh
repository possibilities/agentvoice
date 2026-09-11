#!/bin/bash
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo_root"
[ "$(uname -s)" = Darwin ] || { printf 'macOS is required.\n' >&2; exit 1; }

revision=$(git rev-parse HEAD)
version=$(/usr/bin/plutil -extract version raw -o - package.json)
state_directory=${XDG_STATE_HOME:-$HOME/.local/state}/agentvoice
case "$state_directory" in
  /*) ;;
  *) printf 'AgentVoice state directory must be absolute.\n' >&2; exit 1 ;;
esac
build_root="$repo_root/build/macos"
output_root="$repo_root/dist"
mkdir -p "$build_root" "$output_root"
stage=$(mktemp -d "$output_root/.agentvoice-app.XXXXXX")
trap 'rm -rf "$stage"' EXIT

swift build --package-path "$repo_root/macos" --scratch-path "$build_root" -c release --product AgentVoiceApp
app="$stage/AgentVoice.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$build_root/release/AgentVoiceApp" "$app/Contents/MacOS/AgentVoice"
cp "$repo_root/macos/Info.plist" "$app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $version" "$app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :AgentVoiceSourceRevision $revision" "$app/Contents/Info.plist"
/usr/bin/plutil -replace AgentVoiceStateDirectory -string "$state_directory" "$app/Contents/Info.plist"
swift "$repo_root/scripts/macos-icon.swift" "$stage/AgentVoice.iconset"
iconutil -c icns "$stage/AgentVoice.iconset" -o "$app/Contents/Resources/AgentVoice.icns"
codesign --force --sign "${AGENTVOICE_APP_SIGNING_IDENTITY:--}" --options runtime \
  --identifier io.arthack.agentvoice.menu \
  --requirements '=designated => identifier "io.arthack.agentvoice.menu"' "$app"
codesign --verify --strict "$app"

bundle="$output_root/AgentVoice.app"
if [ -e "$bundle" ]; then rm -rf "$bundle"; fi
mv "$app" "$bundle"
printf 'Built %s\n' "$bundle"
