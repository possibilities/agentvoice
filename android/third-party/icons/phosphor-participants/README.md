# Phosphor participant audition assets

These debug Studio assets pair Phosphor `user` with the human/microphone channel
and Phosphor `robot` with the agent/speaker channel. Both Bold and Fill come from
the already-pinned Phosphor Icons revision
`2b75f3ad12b420c9504ef05df8d2564a28f8500e` under MIT. The four files in
`originals/` and `LICENSE.txt` are byte-exact copies of the acquired upstream
files and license. Their hashes are recorded in `SHA256SUMS` and `receipt.json`.

Generated integration copies use the existing Phosphor audition's 256-unit
canvas and 64 dp Android intrinsic size. User geometry is unchanged. Robot is
uniformly reduced to 95% about the canvas center for optical balance. Muted
variants use the repository's common diagonal slash and a true-transparent,
opposite-winding knockout clip; they do not paint with a presumed background
color. Because both User shoulders extend beyond the lower butt terminus, muted
User alone has a second transparent clip at `x+y = 426.666...` that suppresses
the isolated lower-right shoulder-tip fragment. It does not affect the live User
or any Robot geometry. SVG accessibility metadata and Android VectorDrawable
conversion are integration-only additions.

Run from the repository root:

```sh
python3 android/third-party/icons/phosphor-participants/generate.py
```

Generation requires `rsvg-convert` and ImageMagick's `magick`. It emits eight
browser SVGs under `android/configurator/public/icon-previews/`, eight debug
VectorDrawables under `android/app/src/debug/res/drawable/`, and a deterministic
`receipt.json`. It reconstructs each VectorDrawable as SVG and requires exact
raster equality at 96, 24, and 16 pixels. The receipt also records painted
connected components and the smallest component at each size so detached mute
fragments remain auditable. `comparison.png` lays out those three sizes as rows;
columns are Bold User live/muted, Bold Robot live/muted, Fill User live/muted,
then Fill Robot live/muted.

These are audition inputs only. Generation does not select a catalog entry,
change production defaults, or add an asset to a release resource set.
