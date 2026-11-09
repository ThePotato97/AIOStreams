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
import {
  BinauralConverter,
  type OutputPlan,
  type RendererExports,
} from './convert';
import { eac3Core, type LibAVSync } from './eac3-core';

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
const libavDir = join(__dirname, 'libav');
const haveLibav = existsSync(join(libavDir, 'libav.wasm'));
/** An E-AC-3 stream with Atmos (JOC), to compare with the native renderer; not in the repository. */
const atmosEac3 = process.env.EAC3_ATMOS;

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

/** Binaural only, the stream's modes: what the transcoder's renderer makes. */
const BINAURAL: OutputPlan = {
  modes: 0,
  layout: 'stereo',
  contents: 'binaural',
};

/** Decodes an MP4 file to interleaved f32, every channel. */
const decodeAll = (path: string) => {
  const out = execFileSync(
    'ffmpeg',
    ['-v', 'error', '-i', path, '-f', 'f32le', '-'],
    {
      maxBuffer: 1 << 28,
    }
  );
  return new Float32Array(out.buffer, out.byteOffset, out.byteLength / 4);
};
/** The transcoder's decode of a source for speakers (media.mjs: aresample to the layout). */
const transcoderSpeakers = (
  source: string,
  layout: string,
  channels: number
) => {
  const out = execFileSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-i',
      source,
      '-map',
      '0:a',
      '-af',
      `aresample=async=1:ochl=${layout}:rematrix_maxval=1`,
      '-ac',
      String(channels),
      '-f',
      'f32le',
      '-',
    ],
    { maxBuffer: 1 << 28 }
  );
  return new Float32Array(out.buffer, out.byteOffset, out.byteLength / 4);
};
/** The largest difference between channels `from`.. of `got` (`stride` interleaved) and `want`. */
function channelDiff(
  got: Float32Array,
  stride: number,
  from: number,
  want: Float32Array,
  channels: number
) {
  const frames = got.length / stride;
  expect(want.length / channels).toBeGreaterThanOrEqual(frames);
  let max = 0;
  for (let f = 0; f < frames; f++)
    for (let c = 0; c < channels; c++)
      max = Math.max(
        max,
        Math.abs(got[f * stride + from + c] - want[f * channels + c])
      );
  return max;
}

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
      const conv = new BinauralConverter(await renderer(), BINAURAL);
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

    it("keeps the renderer's scene, at the stream's time, for the debug view", async () => {
      const { init, chunks } = segments();
      const conv = new BinauralConverter(await renderer(), BINAURAL);
      conv.init(init);
      conv.segment(chunks[0]);
      const first = conv.takeSnapshots();
      // about 47 a second over the first 4 s, from the start
      expect(first.length).toBeGreaterThan(180);
      expect(first[0].time).toBe(0);
      expect(first[1].time).toBeCloseTo(1024 / 48000, 9);
      // 5.1 without Atmos: its channels as beds and the LFE
      const last = first.at(-1)!;
      expect(last.elements.map((e) => e.kind).sort()).toEqual([
        'bed',
        'bed',
        'bed',
        'bed',
        'bed',
        'lfe',
      ]);
      const left = last.elements.find((e) => e.bed === 1)!;
      expect(left.pos).toEqual([0, 0, 0]);
      expect(left.active).toBe(true);
      // a 0.3 sine, after the renderer's input headroom (-3 dB): one block holds about a cycle of
      // it, so its power is averaged over the segment
      const power =
        first.reduce(
          (n, snap) => n + snap.elements.find((e) => e.bed === 1)!.level ** 2,
          0
        ) / first.length;
      expect(Math.sqrt(power)).toBeCloseTo((0.3 / Math.SQRT2) * 0.70794576, 3);
      expect(last.elements.find((e) => e.kind === 'lfe')!.pos).toBeNull();
      // after a seek, the new session's time
      conv.segment(chunks[2]);
      expect(conv.takeSnapshots()[0].time).toBeCloseTo(8, 3);
    });

    it('carries the speaker version with the binaural render, as the transcoder decodes it', async () => {
      const { init, chunks } = segments();
      const convert = async (plan: OutputPlan, name: string) => {
        const conv = new BinauralConverter(await renderer(), plan);
        const file = join(dir, name);
        writeFileSync(
          file,
          Buffer.concat([
            conv.init(init),
            ...chunks.map((c) => conv.segment(c)),
          ])
        );
        expect(probe(file).streams[0].channels).toBe(conv.channels);
        return decodeAll(file);
      };
      const binaural = await convert(BINAURAL, 'only-binaural.mp4');
      const src = join(dir, 'src.mkv');
      // a stereo output: binaural, then the transcoder's stereo downmix
      const stereo = await convert(
        { modes: 0, layout: 'stereo', contents: 'both' },
        'both-stereo.mp4'
      );
      expect(stereo.length / 4).toBe(binaural.length / 2);
      expect(channelDiff(stereo, 4, 0, binaural, 2)).toBe(0);
      // 24-bit: within a step of FFmpeg's float mix
      const lsb = 1 / 2 ** 23;
      expect(
        channelDiff(stereo, 4, 2, transcoderSpeakers(src, 'stereo', 2), 2)
      ).toBeLessThan(2 * lsb);
      // a surround output: binaural, then 5.1 as the transcoder sends it
      const surround = await convert(
        { modes: 0, layout: '5.1', contents: 'both' },
        'both-5.1.mp4'
      );
      expect(channelDiff(surround, 8, 0, binaural, 2)).toBe(0);
      const five = transcoderSpeakers(src, '5.1', 6);
      expect(channelDiff(surround, 8, 2, five, 6)).toBeLessThan(2 * lsb);
      // the speaker version alone, at the same timing
      const speakers = await convert(
        { modes: 0, layout: '5.1', contents: 'speakers' },
        'speakers-5.1.mp4'
      );
      expect(speakers.length / 6).toBe(binaural.length / 2);
      expect(channelDiff(speakers, 6, 0, five, 6)).toBeLessThan(2 * lsb);
    }, 60000);

    it('renders in the mode asked for', async () => {
      const { init, chunks } = segments();
      const render = async (modes: number) => {
        const conv = new BinauralConverter(await renderer(), {
          ...BINAURAL,
          modes,
        });
        conv.init(init);
        conv.segment(chunks[0]);
        return conv.takeSnapshots().at(-1)!.elements;
      };
      // a 5.1 channel presentation: Mid as mixed, Near as Windows renders, Far
      const modes = async (m: number) =>
        new Set(
          (await render(m)).filter((e) => e.kind === 'bed').map((e) => e.mode)
        );
      expect([...(await modes(0))]).toEqual(['mid']);
      expect([...(await modes(1))]).toEqual(['near']);
      expect([...(await modes(2))]).toEqual(['far']);
    });

    it('starts again where a segment that does not follow the last one starts', async () => {
      const { init, chunks } = segments();
      const conv = new BinauralConverter(await renderer(), BINAURAL);
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

const libav = async (): Promise<LibAVSync> => {
  const { default: LibAV } = await import(
    /* @vite-ignore */ join(libavDir, 'libav.mjs')
  );
  const { default: factory } = await import(
    /* @vite-ignore */ join(libavDir, 'libav.factory.mjs')
  );
  return LibAV.LibAV({
    noworker: true,
    factory,
    wasmurl: join(libavDir, 'libav.wasm'),
  });
};

/** An E-AC-3 source's audio as the transcoder copies it into DASH: its init and media segments. */
function eac3Dash(source: string, name: string) {
  const out = join(dir, name);
  execFileSync('mkdir', ['-p', out]);
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-i',
    source,
    '-map',
    '0:a',
    '-c',
    'copy',
    '-f',
    'dash',
    '-dash_segment_type',
    'mp4',
    '-seg_duration',
    '4',
    join(out, 'manifest.mpd'),
  ]);
  expect(readFileSync(join(out, 'manifest.mpd'), 'utf8')).toContain(
    'codecs="ec-3"'
  );
  const files = readdirSync(out);
  const init = readFileSync(
    join(
      out,
      files.find((f) => f.startsWith('init-'))!
    )
  );
  const chunks = files
    .filter((f) => f.startsWith('chunk-'))
    .sort()
    .map((f) => readFileSync(join(out, f)));
  return { out, init, chunks };
}

/** Renders an E-AC-3 stream through DASH in the browser's way, and natively, and compares. */
async function compareEac3(
  source: string,
  name: string,
  tolerance: number,
  atmos = false
) {
  const { out, init, chunks } = eac3Dash(source, name);
  const lib = await libav();
  const conv = new BinauralConverter(await renderer(), BINAURAL, {
    render: () => eac3Core(lib),
    speakers: () => eac3Core(lib, []),
  });
  const file = join(out, 'binaural.mp4');
  writeFileSync(
    file,
    Buffer.concat([conv.init(init), ...chunks.map((c) => conv.segment(c))])
  );
  const scene = conv.takeSnapshots();
  conv.close();
  // the debug view's scene: with Atmos, objects JOC rebuilt, placed and moving
  const objects = scene.flatMap((snap) =>
    snap.elements.filter((e) => e.kind === 'object')
  );
  if (atmos) {
    expect(objects.length).toBeGreaterThan(0);
    expect(new Set(objects.map((o) => o.pos!.join())).size).toBeGreaterThan(1);
    if (process.env.SHOW_DIFF)
      console.log(
        name,
        'elements',
        scene
          .at(-1)!
          .elements.map((e) => e.kind)
          .join(' ')
      );
  } else expect(objects).toHaveLength(0);
  expect(probe(file).streams[0].codec_name).toBe('flac');
  const got = decode(file);
  const raw = join(out, 'src.ec3');
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-i',
    source,
    '-map',
    '0:a',
    '-c',
    'copy',
    '-f',
    'eac3',
    raw,
  ]);
  const native = execFileSync(nativePath, ['--format', 'eac3'], {
    input: readFileSync(raw),
    maxBuffer: 1 << 30,
  });
  const ref = new Float32Array(
    native.buffer,
    native.byteOffset,
    native.byteLength / 4
  );
  // all of it but the renderer's latency at the end (no flush here)
  expect(ref.length - got.length).toBeGreaterThanOrEqual(0);
  expect(ref.length - got.length).toBeLessThan(2 * 4096);
  let max = 0;
  for (let i = 0; i < got.length; i++)
    max = Math.max(max, Math.abs(got[i] - ref[i]));
  if (process.env.SHOW_DIFF)
    console.log(
      name,
      'max diff',
      max,
      'frames',
      got.length / 2,
      'of',
      ref.length / 2
    );
  expect(max).toBeLessThan(tolerance);
}

describe.skipIf(!ffmpeg || !haveWasm || !haveLibav || !existsSync(nativePath))(
  'E-AC-3 with the libav.js core decoder',
  () => {
    it('renders 5.1 E-AC-3 as the native renderer does', async () => {
      // quiet enough that the output stays under the limiters with the Movie profile's volmax:
      // their attack would magnify the two decoders' last-bit differences
      const tones = [220, 330, 440, 550, 60, 770]
        .map((f) => `0.05*sin(2*PI*${f}*t)`)
        .join('|');
      const src = join(dir, 'src-eac3.mkv');
      execFileSync('ffmpeg', [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        `aevalsrc=${tones}:c=5.1(side):s=48000`,
        '-t',
        '12',
        '-c:a',
        'eac3',
        '-b:a',
        '640k',
        src,
      ]);
      // 24-bit FLAC; the core from FFmpeg 9.0 (libav.js) against this host's FFmpeg
      await compareEac3(src, 'eac3-51', 1 / 2 ** 20);
    });
    it('carries the speaker version FFmpeg decodes with its default options', async () => {
      const tones = [220, 330, 440, 550, 60, 770]
        .map((f) => `0.3*sin(2*PI*${f}*t)`)
        .join('|');
      const src = join(dir, 'src-eac3-dn24.mkv');
      // dialnorm -24: the renderer's decoder (target level -31) puts it 7 dB lower than FFmpeg's
      // defaults do, so the speaker version shows which options decoded it
      execFileSync('ffmpeg', [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        `aevalsrc=${tones}:c=5.1(side):s=48000`,
        '-t',
        '12',
        '-c:a',
        'eac3',
        '-b:a',
        '640k',
        '-dialnorm',
        '-24',
        src,
      ]);
      const { out, init, chunks } = eac3Dash(src, 'eac3-speakers');
      const lib = await libav();
      const convert = async (plan: OutputPlan, name: string) => {
        const conv = new BinauralConverter(await renderer(), plan, {
          render: () => eac3Core(lib),
          speakers: () => eac3Core(lib, []),
        });
        const file = join(out, name);
        writeFileSync(
          file,
          Buffer.concat([
            conv.init(init),
            ...chunks.map((c) => conv.segment(c)),
          ])
        );
        conv.close();
        return decodeAll(file);
      };
      const binaural = await convert(BINAURAL, 'binaural.mp4');
      const both = await convert(
        { modes: 0, layout: 'stereo', contents: 'both' },
        'both.mp4'
      );
      expect(both.length / 4).toBe(binaural.length / 2);
      expect(channelDiff(both, 4, 0, binaural, 2)).toBe(0);
      // the core from FFmpeg 9.0 (libav.js) against this host's FFmpeg, as above
      const want = transcoderSpeakers(src, 'stereo', 2);
      expect(channelDiff(both, 4, 2, want, 2)).toBeLessThan(1 / 2 ** 20);
      // and not the renderer's decode: 7 dB apart
      const quieter = want.map((v) => v * 2 ** (-7 / 6));
      expect(channelDiff(both, 4, 2, quieter, 2)).toBeGreaterThan(0.01);
    }, 120_000);
    it.skipIf(!atmosEac3 || !existsSync(atmosEac3))(
      'renders E-AC-3 with Atmos (JOC) as the native renderer does',
      async () => {
        await compareEac3(atmosEac3!, 'eac3-joc', 1 / 2 ** 20, true);
      },
      900_000
    );
  }
);
