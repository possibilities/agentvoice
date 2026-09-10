import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '../../app/src/debug/assets/switch-sounds');
for (const name of readdirSync(root).filter(name => name.endsWith('.wav')).sort()) {
  const bytes = readFileSync(join(root, name));
  let format, pcm;
  for (let p = 12; p + 8 <= bytes.length;) {
    const kind = bytes.toString('ascii', p, p + 4), size = bytes.readUInt32LE(p + 4);
    if (kind === 'fmt ') format = { codec: bytes.readUInt16LE(p+8), channels: bytes.readUInt16LE(p+10), rate: bytes.readUInt32LE(p+12), bits: bytes.readUInt16LE(p+22) };
    if (kind === 'data') pcm = bytes.subarray(p+8, p+8+size);
    p += 8 + size + (size % 2);
  }
  if (format.codec !== 1 || format.channels !== 1 || format.rate !== 48000 || format.bits !== 16 || !pcm?.length) throw Error(`Bad format: ${name}`);
  let peak = 0, first = -1, last = -1;
  for (let p = 0; p < pcm.length; p += 2) {
    const magnitude = Math.abs(pcm.readInt16LE(p)) / 32768;
    peak = Math.max(peak, magnitude);
    if (magnitude > .01) { if (first === -1) first = p / 2; last = p / 2; }
  }
  if (!peak || peak > .502) throw Error(`Unexpected peak: ${name}`);
  console.log(JSON.stringify({ name, durationMs: pcm.length / 2 / 48, peakDbFS: 20*Math.log10(peak), onsetAboveMinus40DbMs: first/48, lastAboveMinus40DbMs: last/48, sha256: createHash('sha256').update(bytes).digest('hex') }));
}
