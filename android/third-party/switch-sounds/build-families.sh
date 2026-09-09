#!/bin/sh
set -eu
# Usage: sh build-families.sh /path/to/pinned/kenney-ui-audio /tmp/output-families
source_root=${1:?Supply the pinned Kenney mirror checkout (see README)}
output_root=${2:?Supply a disposable output directory}
[ "$(git -C "$source_root" rev-parse HEAD)" = "8c3d81b9159d058c444f89d12d518276b0b09345" ] || exit 1
mkdir -p "$output_root"
# Trim only near-silent margins; keep the transient and its natural decay.
# Output mono PCM16, 48 kHz, with a -6 dBFS peak ceiling.
for number in 29 13; do
  source_file="$source_root/addons/kenney_ui_audio/switch${number}.wav"
  sox -D "$source_file" -b 16 "$output_root/rocker-${number}-toggle.wav" remix - silence 1 0.0001 -45d reverse silence 1 0.001 -60d reverse rate 48000 gain -n -6 pad 0.002 0.008
  sox -D "$source_file" -b 16 "$output_root/rocker-${number}-ptt-down.wav" remix - silence 1 0.0001 -45d reverse silence 1 0.001 -60d reverse speed 0.90 rate 48000 gain -n -6 pad 0.002 0.008
  sox -D "$source_file" -b 16 "$output_root/rocker-${number}-ptt-up.wav" remix - silence 1 0.0001 -45d reverse silence 1 0.001 -60d reverse speed 1.12 rate 48000 gain -n -8 pad 0.002 0.008
done
