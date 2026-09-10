#!/bin/sh
set -eu
# Arguments: original Kenney WAV directory, cleared trio directory, output directory.
source_dir=${1:?Pass original Kenney WAV directory}
trio_dir=${2:?Pass cleared trio directory}
output_dir=${3:?Pass output directory}
mkdir -p "$output_dir"
for number in 29 13; do
  cp "$trio_dir/rocker-${number}-toggle.wav" "$output_dir/rocker-${number}-toggle-on.wav"
  cp "$trio_dir/rocker-${number}-ptt-down.wav" "$output_dir/rocker-${number}-ptt-down.wav"
  cp "$trio_dir/rocker-${number}-ptt-up.wav" "$output_dir/rocker-${number}-ptt-up.wav"
  sox -D "$source_dir/switch${number}.wav" -b 16 "$output_dir/rocker-${number}-toggle-off.wav" remix - silence 1 0.0001 -45d reverse silence 1 0.001 -60d reverse speed 1.08 rate 48000 gain -n -9 pad 0.002 0.008
done
cp "$trio_dir/LICENSE.txt" "$output_dir/LICENSE.txt"
