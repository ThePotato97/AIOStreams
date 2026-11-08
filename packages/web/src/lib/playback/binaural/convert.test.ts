/* eslint-disable lingui/no-unlocalized-strings -- test data, not UI text. */
// The binaural conversion against real streams: FFmpeg makes a TrueHD DASH stream and checks
// the FLAC that comes out; the renderer is the WebAssembly build (scripts/build-atmos-wasm.sh)
// and, for comparison, the native one. Skipped where those aren't available.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { flacFrame } from './flac';
import { flacFragment, flacInit, initTimescale, readFragments } from './fmp4';
import { BinauralConverter, type RendererExports } from './convert';

const has = (cmd: string) => {
  try {
    execFileSync(cmd, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};
const ffmpeg = has('ffmpeg') && has('ffprobe');
const wasmPath = join(__dirname, 'atmos_render.wasm');
const nativePath = join(
  __dirname,
  '../../../../../../services/atmos-render/target/release/atmos-render'
);
const haveWasm = existsSync(wasmPath);

let dir = '';
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'binaural-'));
  if (!ffmpeg) return;
  // 12 s of 5.1 TrueHD, each channel its own tone, as the transcoder copies it into DASH.
  const tones = [220, 330, 440, 550, 60, 770]
    .map((f) => `0.3*sin(2*PI*${f}*t)`)
    .join('|');
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    `aevalsrc=${tones}:c=5.1:s=48000`,
    '-t',
    '12',
    '-c:a',
    'truehd',
    '-strict',
    '-2',
    join(dir, 'src.mkv'),
  ]);
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-i',
    join(dir, 'src.mkv'),
    '-map',
    '0:a',
    '-c',
    'copy',
    '-strict',
    'experimental',
    '-f',
    'dash',
    '-dash_segment_type',
    'mp4',
    '-seg_duration',
    '4',
    join(dir, 'manifest.mpd'),
  ]);
  execFileSync('ffmpeg', [
    '-v',
    'fatal',
    '-i',
    join(dir, 'src.mkv'),
    '-c',
    'copy',
    '-f',
    'truehd',
    join(dir, 'src.thd'),
  ]);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const segments = () => {
  const files = readdirSync(dir);
  const init = files.find((f) => f.startsWith('init-'))!;
  const chunks = files.filter((f) => f.startsWith('chunk-')).sort();
  return {
    init: readFileSync(join(dir, init)),
    chunks: chunks.map((f) => readFileSync(join(dir, f))),
  };
};
/** Decodes an MP4 file to interleaved stereo f32. */
const decode = (path: string) => {
  const out = execFileSync(
    'ffmpeg',
    ['-v', 'error', '-i', path, '-f', 'f32le', '-ac', '2', '-'],
    { maxBuffer: 1 << 28 }
  );
  return new Float32Array(out.buffer, out.byteOffset, out.byteLength / 4);
};
const probe = (path: string) =>
  JSON.parse(
    execFileSync('ffprobe', [
      '-v',
      'error',
      '-show_streams',
      '-show_entries',
      'packet=pts_time',
      '-read_intervals',
      '%+#1',
      '-of',
      'json',
      path,
    ]).toString()
  );

describe.skipIf(!ffmpeg)('FLAC in fragmented MP4', () => {
  it('decodes to the samples written, at the start time given', () => {
    const n = 10000;
    const pcm = new Float32Array(2 * n);
    for (let i = 0; i < n; i++) {
      pcm[2 * i] = 0.5 * Math.sin(i * 0.01);
      pcm[2 * i + 1] = -0.25 * Math.sin(i * 0.02);
    }
    const start = 48000 * 3; // 3 s
    const frames = [];
    for (let at = 0; at < n; at += 4096) {
      const len = Math.min(4096, n - at);
      frames.push({
        data: flacFrame(pcm.subarray(2 * at, 2 * (at + len)), start + at),
        samples: len,
      });
    }
    const file = join(dir, 'flac.mp4');
    const init = flacInit();
    const frag = flacFragment(1, start, frames);
    const out = new Uint8Array(init.length + frag.length);
    out.set(init);
    out.set(frag, init.length);
    writeFileSync(file, out);
    const info = probe(file);
    expect(info.streams[0].codec_name).toBe('flac');
    expect(info.streams[0].channels).toBe(2);
    expect(Number(info.streams[0].sample_rate)).toBe(48000);
    expect(Number(info.packets[0].pts_time)).toBeCloseTo(3, 6);
    const got = decode(file);
    expect(got.length).toBe(pcm.length);
    let max = 0;
    for (let i = 0; i < pcm.length; i++)
      max = Math.max(max, Math.abs(got[i] - pcm[i]));
    // 24-bit
    expect(max).toBeLessThan(1 / 2 ** 22);
  });

  it('reads the TrueHD fragments FFmpeg writes', () => {
    const { init, chunks } = segments();
    expect(initTimescale(init)).toBeGreaterThan(0);
    const ts = initTimescale(init)!;
    let expected = 0;
    for (const c of chunks) {
      const [f] = readFragments(c);
      expect(f.start).toBe(expected);
      expect(f.samples.length).toBeGreaterThan(0);
      // TrueHD access units start with their 4-byte header: length in the low 12 bits
      for (const s of f.samples.slice(0, 3))
        expect(s.data.length).toBeGreaterThan(4);
      expected += f.samples.reduce((n, s) => n + s.duration, 0);
    }
    expect(expected / ts).toBeCloseTo(12, 1);
  });
});

const renderer = async (): Promise<RendererExports> => {
  const { instance } = await WebAssembly.instantiate(
    readFileSync(wasmPath),
    {}
  );
  return instance.exports as unknown as RendererExports;
};

describe.skipIf(!ffmpeg || !haveWasm)(
  'binaural conversion with the WebAssembly renderer',
  () => {
    it('turns the TrueHD segments into binaural FLAC with the source timing', async () => {
      const { init, chunks } = segments();
      const conv = new BinauralConverter(await renderer());
      const parts = [conv.init(init), ...chunks.map((c) => conv.segment(c))];
      const file = join(dir, 'binaural.mp4');
      writeFileSync(file, Buffer.concat(parts));
      const info = probe(file);
      expect(info.streams[0].codec_name).toBe('flac');
      expect(Number(info.packets[0].pts_time)).toBe(0);
      const got = decode(file);
      // the whole stream, less the renderer's latency at the very end (no flush)
      expect(got.length / 2 / 48000).toBeGreaterThan(11.9);
      expect(got.length / 2 / 48000).toBeLessThanOrEqual(12);
      if (!existsSync(nativePath)) return;
      // the same as the native renderer on the same TrueHD, sample for sample
      const native = execFileSync(nativePath, ['--format', 'truehd'], {
        input: readFileSync(join(dir, 'src.thd')),
        maxBuffer: 1 << 28,
      });
      const ref = new Float32Array(
        native.buffer,
        native.byteOffset,
        native.byteLength / 4
      );
      let max = 0;
      for (let i = 0; i < got.length; i++)
        max = Math.max(max, Math.abs(got[i] - ref[i]));
      expect(max).toBeLessThan(1 / 2 ** 21);
    });

    it('starts again where a segment that does not follow the last one starts', async () => {
      const { init, chunks } = segments();
      const conv = new BinauralConverter(await renderer());
      const head = conv.init(init);
      conv.segment(chunks[0]);
      // a seek: the third segment, at 8 s
      const jumped = conv.segment(chunks[2]);
      const file = join(dir, 'seek.mp4');
      writeFileSync(file, Buffer.concat([head, jumped]));
      expect(Number(probe(file).packets[0].pts_time)).toBeCloseTo(8, 3);
    });
  }
);
