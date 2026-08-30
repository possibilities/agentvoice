#!/usr/bin/env bash

set -euo pipefail

readonly CODEX_SOURCE_REPOSITORY="https://github.com/openai/codex"
readonly CODEX_SOURCE_REVISION="430d26b543b219049192de559987b8cf506efacf"
readonly SCRATCH_ROOT="/Volumes/Scratch"

check_only=false
case "${1:-}" in
  "")
    ;;
  --check)
    check_only=true
    ;;
  *)
    printf 'usage: %s [--check]\n' "$0" >&2
    exit 2
    ;;
esac
[[ $# -le 1 ]] || {
  printf 'usage: %s [--check]\n' "$0" >&2
  exit 2
}

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
project_root="$(cd -- "${script_directory}/.." && pwd -P)"
patch_path="${project_root}/patches/codex-client-managed-handoffs.patch"
install_directory="${project_root}/.cache/codex-app-server/${CODEX_SOURCE_REVISION}"

scratch_directory=""
lock_directory=""
staged_binary=""
staged_metadata=""

fail() {
  printf 'build-codex-app-server: %s\n' "$*" >&2
  exit 1
}

sha256_file() {
  local path="$1"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 -- "$path" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum -- "$path" | awk '{print $1}'
  else
    fail "neither shasum nor sha256sum is available"
  fi
}

cleanup() {
  if [[ -n "$staged_binary" && -f "$staged_binary" ]]; then
    rm -f -- "$staged_binary"
  fi
  if [[ -n "$staged_metadata" && -f "$staged_metadata" ]]; then
    rm -f -- "$staged_metadata"
  fi
  if [[ -n "$lock_directory" && -d "$lock_directory" ]]; then
    rmdir -- "$lock_directory"
  fi
  if [[ -n "$scratch_directory" && -d "$scratch_directory" ]]; then
    case "$scratch_directory" in
      "${SCRATCH_ROOT}"/agentvoice-codex-app-server.*)
        rm -rf -- "$scratch_directory"
        ;;
      *)
        printf 'build-codex-app-server: refusing to remove unexpected path: %s\n' \
          "$scratch_directory" >&2
        ;;
    esac
  fi
}
trap cleanup EXIT

for required_command in git cargo mktemp awk date; do
  command -v "$required_command" >/dev/null 2>&1 \
    || fail "required command is unavailable: ${required_command}"
done

[[ -d "$SCRATCH_ROOT" ]] || fail "scratch volume is not mounted: ${SCRATCH_ROOT}"
[[ -w "$SCRATCH_ROOT" ]] || fail "scratch volume is not writable: ${SCRATCH_ROOT}"
[[ -f "$patch_path" ]] || fail "Codex patch is missing: ${patch_path}"

if [[ "$check_only" == false ]]; then
  mkdir -p -- "$install_directory"
  lock_candidate="${install_directory}/.build-lock"
  if mkdir -- "$lock_candidate"; then
    lock_directory="$lock_candidate"
  else
    fail "another build is active (or left a stale lock): ${lock_candidate}"
  fi
fi

scratch_directory="$(mktemp -d "${SCRATCH_ROOT}/agentvoice-codex-app-server.XXXXXX")"
source_directory="${scratch_directory}/source"
target_directory="${scratch_directory}/target"

printf 'Cloning Codex %s into %s\n' "$CODEX_SOURCE_REVISION" "$source_directory"
git clone \
  --filter=blob:none \
  --no-checkout \
  --no-tags \
  --depth 1 \
  "$CODEX_SOURCE_REPOSITORY" \
  "$source_directory"
git -C "$source_directory" fetch \
  --filter=blob:none \
  --no-tags \
  --depth 1 \
  origin \
  "$CODEX_SOURCE_REVISION"
git -C "$source_directory" checkout --detach "$CODEX_SOURCE_REVISION"

actual_revision="$(git -C "$source_directory" rev-parse HEAD)"
[[ "$actual_revision" == "$CODEX_SOURCE_REVISION" ]] \
  || fail "checked out ${actual_revision}, expected ${CODEX_SOURCE_REVISION}"

git -C "$source_directory" apply --check "$patch_path"
git -C "$source_directory" apply "$patch_path"
git -C "$source_directory" diff --check

if [[ "$check_only" == true ]]; then
  printf 'Patch applies cleanly to Codex %s\n' "$CODEX_SOURCE_REVISION"
  exit 0
fi

printf 'Building standalone codex-app-server (release) with target data on Scratch\n'
(
  cd -- "${source_directory}/codex-rs"
  CARGO_BUILD_JOBS=2 \
    CARGO_PROFILE_RELEASE_LTO=false \
    CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1 \
    CARGO_TARGET_DIR="$target_directory" \
    cargo build --locked --release --package codex-app-server --bin codex-app-server
)

built_binary="${target_directory}/release/codex-app-server"
[[ -x "$built_binary" ]] || fail "build did not produce an executable: ${built_binary}"

staged_binary="$(mktemp "${install_directory}/.codex-app-server.XXXXXX")"
cp -- "$built_binary" "$staged_binary"
chmod 0755 "$staged_binary"

binary_version="$("$staged_binary" --version)"
if [[ -z "$binary_version" ]]; then
  fail "built binary returned an empty --version"
fi
case "$binary_version" in
  *$'\n'*|*$'\r'*|*\"*|*\\*)
    fail "built binary returned a --version that cannot be safely recorded as JSON"
    ;;
esac

patch_sha256="$(sha256_file "$patch_path")"
binary_sha256="$(sha256_file "$staged_binary")"
built_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
staged_metadata="$(mktemp "${install_directory}/.metadata.XXXXXX")"
printf '{\n  "schemaVersion": 1,\n  "sourceRevision": "%s",\n  "patchSha256": "%s",\n  "builtAt": "%s",\n  "binarySha256": "%s",\n  "binaryVersion": "%s"\n}\n' \
  "$CODEX_SOURCE_REVISION" \
  "$patch_sha256" \
  "$built_at" \
  "$binary_sha256" \
  "$binary_version" >"$staged_metadata"

destination_binary="${install_directory}/codex-app-server"
destination_metadata="${install_directory}/metadata.json"
mv -f -- "$staged_binary" "$destination_binary"
staged_binary=""
mv -f -- "$staged_metadata" "$destination_metadata"
staged_metadata=""

printf 'Installed %s\n' "$destination_binary"
printf 'Metadata %s\n' "$destination_metadata"
printf 'Binary version: %s\n' "$binary_version"
