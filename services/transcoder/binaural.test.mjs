// Binaural conversion: the audio rendered to headphones by atmos-render. The policy and argument
// tests always run; the conversions run where atmos-render is installed (the image has it at
// /usr/local/bin; elsewhere set ATMOS_RENDER to a build).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import {
  playbackSpec,
  modeOf,
  ffmpegArgs,
  demuxArgs,
  rendererArgs,
  firstPacketTime,
  audioCodec,
  withAudioCodec,
} from './media.mjs';

const exec = promisify(execFile);
const renderer = process.env.ATMOS_RENDER ?? 'atmos-render';
const haveRenderer = await exec(renderer, ['--format', 'nonsense'])
  .then(() => true)
  .catch((e) => e.code !== 'ENOENT');

const meta = (codec, extra = {}) => ({
  durationMs: 6000,
  tracks: [
    { index: 0, type: 'video', codec: 'h264' },
    {
      index: 1,
      type: 'audio',
      codec,
      channels: 6,
      sampleRate: 48000,
      default: true,
      ...extra,
    },
  ],
});
const request = (capabilities = {}, extra = {}) => ({
  quality: 'original',
  positionMs: 0,
  capabilities: {
    video: true,
    audio: true,
    container: true,
    hdr: false,
    ...capabilities,
  },
  ...extra,
});

/** Rendered to binaural on the server; copied (for the page, or as it is). */
const rendered = (spec) => spec.audio?.where === 'server-render';
const copied = (spec) =>
  ['server-copy', 'page-original'].includes(spec.audio?.where);

test('binaural: TrueHD, E-AC-3, AC-3 and DTS at 48 kHz, where the player asks', () => {
  const asked = request({ binaural: true });
  for (const codec of ['truehd', 'eac3', 'ac3', 'dts']) {
    const spec = playbackSpec(meta(codec), asked);
    assert.equal(rendered(spec), true, codec);
    // the audio is converted even where the browser plays it
    assert.equal(copied(spec), false, codec);
    assert.equal(spec.audio.reason, 'binaural rendering', codec);
  }
  assert.equal(rendered(playbackSpec(meta('truehd'), request())), false);
  // other surround is virtualised in the page
  assert.equal(rendered(playbackSpec(meta('aac'), asked)), false);
  assert.equal(rendered(playbackSpec(meta('flac'), asked)), false);
  // the renderer is 48 kHz only
  assert.equal(
    rendered(playbackSpec(meta('truehd', { sampleRate: 96000 }), asked)),
    false
  );
});

test('client binaural: a track the player renders is copied, never played directly', () => {
  const asked = request({ binaural: true, clientBinaural: ['truehd'] });
  const spec = playbackSpec(meta('truehd'), asked);
  assert.equal(spec.audio.pageRenders, true);
  assert.equal(rendered(spec), false);
  assert.equal(copied(spec), true);
  assert.equal(spec.audio.reason, null);
  // video and audio both copied: a remux, not the original file
  assert.equal(modeOf(spec), 'remux');
  assert.equal(audioCodec(meta('truehd'), spec), 'mlpa');
  // a codec the player doesn't render itself is rendered here
  const eac3 = playbackSpec(meta('eac3'), asked);
  assert.equal(eac3.audio.pageRenders, false);
  assert.equal(rendered(eac3), true);
  // a retry after failed playback renders it here
  const retry = playbackSpec(meta('truehd'), { ...asked, force: true });
  assert.equal(retry.audio.pageRenders, false);
  assert.equal(rendered(retry), true);
  // FFmpeg's flag for TrueHD in MP4
  const { args } = ffmpegArgs('in', meta('truehd'), asked, 'out');
  assert.equal(args[args.indexOf('-strict') + 1], 'experimental');
  assert.equal(args[args.lastIndexOf('-c:a') + 1], 'copy');
});

test('client binaural: AC-3 and DTS are copied for the player as E-AC-3 is', () => {
  const asked = request({
    audio: false,
    binaural: true,
    clientBinaural: ['eac3', 'ac3', 'dts'],
  });
  for (const codec of ['eac3', 'ac3', 'dts']) {
    const spec = playbackSpec(meta(codec), asked);
    assert.equal(spec.audio.pageRenders, true, codec);
    assert.equal(rendered(spec), false, codec);
    assert.equal(copied(spec), true, codec);
    const { args } = ffmpegArgs('in', meta(codec), asked, 'out');
    assert.equal(args[args.lastIndexOf('-c:a') + 1], 'copy', codec);
    assert.ok(!args.includes('-strict'), codec);
  }
  // FFmpeg names E-AC-3 and AC-3 in the manifest; DTS gets MP4's object type where it doesn't
  const codecOf = (codec) =>
    audioCodec(meta(codec), playbackSpec(meta(codec), asked));
  assert.equal(codecOf('eac3'), null);
  assert.equal(codecOf('ac3'), null);
  assert.equal(codecOf('dts'), 'mp4a.a9');
});

test('client binaural: copied Dolby Vision loses its metadata where TrueHD needs the experimental flag', () => {
  const dv = (dovi) => ({
    durationMs: 6000,
    tracks: [
      { index: 0, type: 'video', codec: 'hevc', hdr: true, dovi },
      {
        index: 1,
        type: 'audio',
        codec: 'truehd',
        channels: 8,
        sampleRate: 48000,
        default: true,
      },
    ],
  });
  const headphones = request(
    { audio: false, hdr: true, binaural: true, clientBinaural: ['truehd'] },
    { audio: 1 }
  );
  const bsf = (args) => args[args.indexOf('-bsf:v') + 1];
  // Top Gun: Maverick's UHD remux: profile 7 with an HDR10 base layer
  const { args } = ffmpegArgs(
    'in',
    dv({ profile: 7, compatibility: 6 }),
    headphones,
    'out'
  );
  assert.equal(args[args.indexOf('-c:v') + 1], 'copy');
  assert.equal(args[args.indexOf('-strict') + 1], 'experimental');
  assert.equal(bsf(args), 'dovi_rpu=strip=1');
  // no Dolby Vision: the video as it is
  assert.ok(
    !ffmpegArgs('in', dv(undefined), headphones, 'out').args.includes('-bsf:v')
  );
  // headphones off: no TrueHD copy, no flag, no box to strip
  const off = ffmpegArgs(
    'in',
    dv({ profile: 7, compatibility: 6 }),
    request({ audio: false, hdr: true }, { audio: 1 }),
    'out'
  ).args;
  assert.ok(!off.includes('-strict'));
  assert.ok(!off.includes('-bsf:v'));
});

test('Dolby Vision the player draws is copied with its RPUs, profile 5 included', () => {
  const dv = (dovi, audio = 'truehd') => ({
    durationMs: 6000,
    tracks: [
      { index: 0, type: 'video', codec: 'hevc', hdr: true, dovi },
      {
        index: 1,
        type: 'audio',
        codec: audio,
        channels: 8,
        sampleRate: 48000,
        default: true,
      },
    ],
  });
  const caps = { video: true, audio: true, container: true, hdr: true };
  const draws = request({ ...caps, picture: ['dovi'] }, { audio: 1 });
  const plain = request(caps, { audio: 1 });
  // profile 5: converted unless the player draws it
  assert.equal(
    playbackSpec(dv({ profile: 5, compatibility: 0 }), plain).video.where,
    'server-encode'
  );
  const p5 = playbackSpec(dv({ profile: 5, compatibility: 0 }), draws);
  assert.equal(p5.video.where, 'server-copy');
  assert.equal(p5.video.picture, 'dovi');
  // the player reads the DASH stream, never the file directly
  assert.notEqual(modeOf(p5), 'direct');
  // profile 8 copied either way; drawn (and so not played directly) only where the player draws it
  const p8 = playbackSpec(dv({ profile: 8, compatibility: 1 }, 'aac'), plain);
  assert.equal(p8.video.picture, 'none');
  assert.equal(modeOf(p8), 'direct');
  const p8draws = playbackSpec(
    dv({ profile: 8, compatibility: 1 }, 'aac'),
    draws
  );
  assert.equal(p8draws.video.picture, 'dovi');
  assert.notEqual(modeOf(p8draws), 'direct');
  // no Dolby Vision: nothing to draw
  assert.equal(playbackSpec(dv(undefined), draws).video.picture, 'none');
  // with headphones (TrueHD copied, experimental flag): the RPUs stay
  const both = request(
    { ...caps, picture: ['dovi'], binaural: true, clientBinaural: ['truehd'] },
    { audio: 1 }
  );
  const { args } = ffmpegArgs(
    'in',
    dv({ profile: 7, compatibility: 6 }),
    both,
    'out'
  );
  assert.equal(args[args.indexOf('-c:v') + 1], 'copy');
  assert.equal(args[args.indexOf('-strict') + 1], 'experimental');
  assert.ok(!args.includes('-bsf:v'));
});

test('a codec the player decodes itself is copied with headphones off too', () => {
  // The player renders binaural or the speaker version itself: no new job when they're toggled.
  const off = playbackSpec(
    meta('truehd'),
    request({ binaural: false, clientBinaural: ['truehd'] })
  );
  assert.equal(off.audio.pageRenders, true);
  assert.equal(rendered(off), false);
  assert.equal(copied(off), true);
  const on = playbackSpec(
    meta('truehd'),
    request({ binaural: true, clientBinaural: ['truehd'] })
  );
  assert.deepEqual(on.audio, off.audio);
  // not one it doesn't decode: converted here as before
  const aac = playbackSpec(
    meta('aac'),
    request({ binaural: false, clientBinaural: ['truehd'] })
  );
  assert.equal(aac.audio.pageRenders, false);
  // a 96 kHz TrueHD isn't one the renderer reads
  const hi = meta('truehd');
  hi.tracks[1].sampleRate = 96000;
  assert.equal(
    playbackSpec(hi, request({ clientBinaural: ['truehd'] })).audio.pageRenders,
    false
  );
});

test("the listener's headphone mode reaches the renderer here", () => {
  const args = (mode, codec = 'truehd') =>
    rendererArgs(
      meta(codec),
      playbackSpec(meta(codec), request({ binaural: true, binauralMode: mode }))
    );
  assert.deepEqual(args('near'), ['--format', 'truehd', '--modes', 'windows']);
  assert.deepEqual(args('far'), ['--format', 'truehd', '--modes', 'far']);
  assert.deepEqual(args(undefined), ['--format', 'truehd']);
  // anything else is as mixed
  assert.deepEqual(args('mid'), ['--format', 'truehd']);
  assert.deepEqual(args('far', 'eac3').slice(-2), ['--modes', 'far']);
  // rendered in the player: the player applies it, the job doesn't depend on it
  const client = playbackSpec(
    meta('truehd'),
    request({ binaural: true, binauralMode: 'far', clientBinaural: ['truehd'] })
  );
  assert.equal(client.audio.render, null);
});

test('client binaural: E-AC-3 the player renders is copied, with the codec FFmpeg writes', () => {
  const asked = request({ binaural: true, clientBinaural: ['truehd', 'eac3'] });
  const spec = playbackSpec(meta('eac3'), asked);
  assert.equal(spec.audio.pageRenders, true);
  assert.equal(rendered(spec), false);
  assert.equal(copied(spec), true);
  // FFmpeg writes "ec-3" itself
  assert.equal(audioCodec(meta('eac3'), spec), null);
  const { args } = ffmpegArgs('in', meta('eac3'), asked, 'out');
  assert.equal(args[args.lastIndexOf('-c:a') + 1], 'copy');
});

test('client binaural: the empty TrueHD codec string is filled in', () => {
  const mpd =
    '<Representation id="0" mimeType="video/mp4" codecs="avc1.64001f"/>' +
    '<Representation id="1" mimeType="audio/mp4" codecs="" bandwidth="2299528"/>';
  assert.match(
    withAudioCodec(mpd, 'mlpa'),
    /mimeType="audio\/mp4" codecs="mlpa"/
  );
  assert.equal(withAudioCodec(mpd, null), mpd);
});

test('binaural: the arguments of the three processes', () => {
  const spec = playbackSpec(meta('eac3'), request({ binaural: true }));
  const demux = demuxArgs('http://aio/source', meta('eac3'), spec, 8);
  // the audio track as a raw stream on pipe:1, its timestamps on pipe:3
  assert.deepEqual(
    demux.slice(demux.indexOf('-ss'), demux.indexOf('-ss') + 2),
    ['-ss', '8']
  );
  assert.ok(demux.includes('-copyts') && demux.includes('-reconnect'));
  assert.equal(demux[demux.indexOf('pipe:1') - 1], 'eac3');
  assert.equal(demux[demux.indexOf('pipe:3') - 1], 'framemd5');
  assert.deepEqual(rendererArgs(meta('eac3'), spec), [
    '--format',
    'eac3',
    '--ffmpeg',
    'ffmpeg',
  ]);
  const truehd = playbackSpec(meta('truehd'), request({ binaural: true }));
  assert.deepEqual(rendererArgs(meta('truehd'), truehd), [
    '--format',
    'truehd',
  ]);
  // AC-3 and DTS: raw as FFmpeg names them, decoded by the renderer's own FFmpeg
  for (const codec of ['ac3', 'dts']) {
    const p = playbackSpec(meta(codec), request({ binaural: true }));
    const d = demuxArgs('in', meta(codec), p, 0);
    assert.equal(d[d.indexOf('pipe:1') - 1], codec);
    assert.deepEqual(rendererArgs(meta(codec), p), [
      '--format',
      codec,
      '--ffmpeg',
      'ffmpeg',
    ]);
  }
  // the converting FFmpeg reads the rendered stereo on pipe:4 from the first packet's time
  const { args } = ffmpegArgs(
    'in',
    meta('truehd'),
    request({ binaural: true, lossless: true }, { positionMs: 9000 }),
    'out',
    'cpu',
    { audioStart: 7.995 }
  );
  const pipe = args.indexOf('pipe:4');
  assert.deepEqual(args.slice(pipe - 9, pipe + 1), [
    '-f',
    'f32le',
    '-ar',
    '48000',
    '-ch_layout',
    'stereo',
    '-itsoffset',
    '7.995',
    '-i',
    'pipe:4',
  ]);
  assert.equal(args[args.indexOf('-map', args.indexOf('-map') + 1) + 1], '1:a');
  // the last -c:a is the one FFmpeg uses
  assert.equal(args[args.lastIndexOf('-c:a') + 1], 'flac');
  // AAC where the browser doesn't play FLAC
  const aac = ffmpegArgs(
    'in',
    meta('truehd'),
    request({ binaural: true }),
    'out'
  ).args;
  assert.ok(aac.includes('aac') && aac.includes('192k'));
});

test('binaural: the audio start is the first packet framemd5 lists', () => {
  const text = [
    '#format: frame checksums',
    '#version: 2',
    '#hash: MD5',
    '#tb 0: 1/1000',
    '#media_type 0: audio',
    '#stream#, dts,        pts, duration,     size, hash',
    '0,       7995,       7995,        1,      240, 0123',
    '0,       7996,       7996,        1,      240, 4567',
  ].join('\n');
  assert.equal(firstPacketTime(text), 7.995);
  assert.equal(firstPacketTime(text.split('\n').slice(0, 6).join('\n')), null);
  // a partly written line isn't read
  assert.equal(firstPacketTime('#tb 0: 1/48000\n0,  96000,'), null);
});

let dir, source, worker, base, headers;
before(async () => {
  if (!haveRenderer) return;
  dir = await mkdtemp(`${tmpdir()}/binaural-`);
  // Six seconds of 5.1, each channel its own tone, as TrueHD, E-AC-3, AC-3 and DTS.
  const tones = [220, 330, 440, 550, 60, 770]
    .map((f) => `0.3*sin(2*PI*${f}*t)`)
    .join('|');
  for (const [name, codec, seconds] of [
    ['truehd', ['-c:a', 'truehd', '-strict', '-2'], '6'],
    ['eac3', ['-c:a', 'eac3', '-b:a', '384k'], '6'],
    ['ac3', ['-c:a', 'ac3', '-b:a', '448k'], '6'],
    ['dts', ['-c:a', 'dca', '-strict', '-2', '-b:a', '1509k'], '6'],
    ['truehd-long', ['-c:a', 'truehd', '-strict', '-2'], '20'],
  ])
    await exec('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=160x90:rate=24',
      '-f',
      'lavfi',
      '-i',
      `aevalsrc=${tones}:c=5.1:s=48000`,
      '-t',
      seconds,
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-g',
      '48',
      ...codec,
      `${dir}/${name}.mkv`,
    ]);
  source = createHttpServer(async (req, res) => {
    const name = /\/(eac3|ac3|dts|truehd-long)/.exec(req.url)?.[1] ?? 'truehd';
    const file = `${dir}/${name}.mkv`;
    const size = (await stat(file)).size;
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
    const start = range ? Number(range[1]) : 0,
      end = range && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    res.writeHead(range ? 206 : 200, {
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
    });
    if (req.method === 'HEAD') res.end();
    else createReadStream(file, { start, end }).pipe(res);
  });
  await new Promise((resolve) => source.listen(0, '127.0.0.1', resolve));
  process.env.AIOSTREAMS_INTERNAL_URL = `http://127.0.0.1:${source.address().port}`;
  process.env.TRANSCODER_SECRET = 'b'.repeat(32);
  process.env.CACHE_DIR = `${dir}/worker`;
  process.env.TRANSCODER_ENCODER = 'cpu';
  // every test's job stays on the one worker until its viewer leaves (a minute)
  process.env.TRANSCODER_MAX_COPY_JOBS = '32';
  const { createServer } = await import('./server.mjs');
  worker = createServer();
  await new Promise((resolve) => worker.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${worker.address().port}`;
  headers = {
    Authorization: `Bearer ${process.env.TRANSCODER_SECRET}`,
    'Content-Type': 'application/json',
  };
});
after(async () => {
  worker?.close();
  source?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

const call = async (path, body) => {
  const res = await fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  assert.equal(res.status, 200, await res.clone().text());
  return res.json();
};
/** A viewer's state once it plays (or failed): the long poll, asked again until then. */
async function ready(lease) {
  let after = -1;
  for (let i = 0; i < 40; i++) {
    const state = await call(`/viewers/${lease}/state?after=${after}`);
    if (state.ready || state.failure) return state;
    after = state.version;
  }
  assert.fail('never ready');
}
/**
 * Waits for a viewer's video and audio jobs to finish, then returns each stream's start time and
 * the audio's shape, from each job's own segments.
 */
async function finished(prepared) {
  const ids = [prepared.jobs.video.id, prepared.jobs.audio.id];
  let jobs;
  for (let i = 0; i < 600; i++) {
    const health = await call('/health');
    jobs = ids.map((id) => health.jobs.find((j) => j.id === id));
    if (jobs.every((j) => j?.stage === 'finished' || j?.failure)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  for (const job of jobs) {
    assert.equal(job?.failure, null, JSON.stringify(job?.failure));
    assert.equal(job?.stage, 'finished', 'the conversion finished');
  }
  const joined = async (id) => {
    const out = `${dir}/worker/${id}`;
    const chunks = (await readdir(out))
      .filter((f) => f.startsWith('chunk-0-'))
      .sort();
    const path = `${out}/joined.mp4`;
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      path,
      Buffer.concat(
        await Promise.all(
          ['init-0.m4s', ...chunks].map((f) => readFile(`${out}/${f}`))
        )
      )
    );
    return path;
  };
  const probe = async (path) =>
    JSON.parse(
      (
        await exec('ffprobe', [
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
        ])
      ).stdout
    );
  const video = await probe(await joined(ids[0]));
  const audio = await probe(await joined(ids[1]));
  return {
    videoStart: Number(video.packets[0].pts_time),
    audioStart: Number(audio.packets[0].pts_time),
    audio: audio.streams[0],
  };
}
const manifest = async (lease) => {
  const res = await fetch(`${base}/viewers/${lease}/manifest.mpd`, { headers });
  assert.equal(res.status, 200);
  return res.text();
};

for (const codec of ['truehd', 'eac3', 'ac3', 'dts'])
  test(
    `real chain: ${codec} rendered to binaural stereo, in step with the video`,
    { skip: !haveRenderer && 'atmos-render not installed' },
    async () => {
      for (const positionMs of [0, 2500]) {
        const result = await call('/prepare', {
          input: `${process.env.AIOSTREAMS_INTERNAL_URL}/party/guest/source/${codec}`,
          viewer: `${codec}-viewer-${positionMs}`.padEnd(16, 'x'),
          request: request(
            { audio: false, binaural: true, lossless: true },
            { positionMs }
          ),
        });
        assert.equal(result.effective.audio.where === 'server-render', true);
        // one video job and one audio job, in their own streams
        assert.ok(result.jobs.video.id && result.jobs.audio.id);
        assert.notEqual(result.jobs.video.id, result.jobs.audio.id);
        const { videoStart, audioStart, audio } = await finished(result);
        assert.equal(audio.codec_name, 'flac');
        assert.equal(audio.channels, 2);
        assert.equal(Number(audio.sample_rate), 48000);
        // the copied video starts at the keyframe before the seek, the audio at its first
        // packet there: within a frame of each other here (keyframes every 2 s)
        assert.ok(
          Math.abs(audioStart - videoStart) < 0.05,
          `${codec} at ${positionMs}: audio ${audioStart}, video ${videoStart}`
        );
      }
    }
  );

test(
  'real chain: TrueHD copied for the player to render, with its codec in the manifest',
  { skip: !haveRenderer && 'atmos-render not installed' },
  async () => {
    const result = await call('/prepare', {
      input: `${process.env.AIOSTREAMS_INTERNAL_URL}/party/guest/source/truehd`,
      viewer: 'client-viewer-xxxxxxxx',
      request: request(
        { audio: false, binaural: true, clientBinaural: ['truehd'] },
        { positionMs: 0 }
      ),
    });
    assert.equal(result.effective.audio.pageRenders, true);
    assert.equal(result.effective.audio.where === 'server-render', false);
    await ready(result.lease);
    assert.match(
      await manifest(result.lease),
      /mimeType="audio\/mp4" codecs="mlpa"/
    );
    const { audio } = await finished(result);
    // the audio stream is the source's TrueHD, untouched
    assert.equal(audio.codec_name, 'truehd');
    assert.equal(audio.channels, 6);
  }
);

test(
  'real chain: E-AC-3 copied for the player to render, with its codec in the manifest',
  { skip: !haveRenderer && 'atmos-render not installed' },
  async () => {
    const result = await call('/prepare', {
      input: `${process.env.AIOSTREAMS_INTERNAL_URL}/party/guest/source/eac3`,
      viewer: 'client-viewer-eac3-xxxxxxxx',
      request: request(
        { audio: false, binaural: true, clientBinaural: ['truehd', 'eac3'] },
        { positionMs: 0 }
      ),
    });
    assert.equal(result.effective.audio.pageRenders, true);
    assert.equal(result.effective.audio.where === 'server-render', false);
    await ready(result.lease);
    assert.match(
      await manifest(result.lease),
      /mimeType="audio\/mp4" codecs="ec-3"/
    );
    const { audio } = await finished(result);
    assert.equal(audio.codec_name, 'eac3');
    assert.equal(audio.channels, 6);
  }
);

for (const [codec, written] of [
  ['ac3', 'ac-3'],
  ['dts', 'mp4a.a9'],
])
  test(
    `real chain: ${codec} copied for the player to render, with its codec in the manifest`,
    { skip: !haveRenderer && 'atmos-render not installed' },
    async () => {
      const result = await call('/prepare', {
        input: `${process.env.AIOSTREAMS_INTERNAL_URL}/party/guest/source/${codec}`,
        viewer: `client-viewer-${codec}-xxxxxxxx`,
        request: request(
          { audio: false, binaural: true, clientBinaural: [codec] },
          { positionMs: 0 }
        ),
      });
      assert.equal(result.effective.audio.pageRenders, true);
      assert.equal(result.effective.audio.where === 'server-render', false);
      await ready(result.lease);
      assert.match(
        await manifest(result.lease),
        new RegExp(`mimeType="audio/mp4" codecs="${written}"`)
      );
      const { audio } = await finished(result);
      assert.equal(audio.codec_name, codec);
      assert.equal(audio.channels, 6);
    }
  );

test(
  'real chain: a renderer that dies while playing restarts the audio job converting, and the track converts next time',
  { skip: !haveRenderer && 'atmos-render not installed' },
  async () => {
    // Passes on ~8 s of rendered audio, waits until the first segment is out, then fails.
    const wrapper = `${dir}/dying-renderer.mjs`;
    const { writeFile, chmod } = await import('node:fs/promises');
    await writeFile(
      wrapper,
      `#!/usr/bin/env node
import { spawn } from 'node:child_process';
const real = spawn(${JSON.stringify(renderer)}, process.argv.slice(2), { stdio: ['pipe', 'pipe', 'ignore'] });
process.stdin.pipe(real.stdin);
real.stdin.on('error', () => {});
let sent = 0;
real.stdout.on('data', (chunk) => {
  if (sent >= 3_000_000) return;
  process.stdout.write(chunk);
  sent += chunk.length;
  if (sent >= 3_000_000) setTimeout(() => { real.kill('SIGKILL'); process.exit(1); }, 1500);
});
`
    );
    await chmod(wrapper, 0o755);
    const saved = process.env.ATMOS_RENDER;
    process.env.ATMOS_RENDER = wrapper;
    try {
      const input = `${process.env.AIOSTREAMS_INTERNAL_URL}/party/guest/source/truehd-long`;
      const asked = request(
        { audio: false, binaural: true, lossless: true },
        { positionMs: 0 }
      );
      const first = await call('/prepare', {
        input,
        viewer: 'dying-viewer-xxxxxxxx',
        request: asked,
      });
      assert.equal(first.effective.audio.where === 'server-render', true);
      const audioJob = first.jobs.audio.id;
      // The audio job starts again converting the track (the renderer's failure, not the
      // video's: the video job goes on), and the viewer follows what it now makes.
      let job;
      for (let i = 0; i < 200; i++) {
        job = (await call('/health')).jobs.find((j) => j.id === audioJob);
        if (job?.stages.some((s) => s.fallback === 'renderer')) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(
        job?.stages.some((s) => s.fallback === 'renderer'),
        'the audio job fell back'
      );
      assert.equal(job.effective.audio.where === 'server-render', false);
      const state = await ready(first.lease);
      assert.equal(state.failure, null);
      assert.equal(state.effective.audio.where === 'server-render', false);
      // The next playback of this track asks for it converted, and shares the job.
      const again = await call('/prepare', {
        input,
        viewer: 'dying-viewer-again-xx',
        request: asked,
      });
      assert.equal(again.effective.audio.where === 'server-render', false);
      assert.equal(again.jobs.audio.id, audioJob);
      const { audio } = await finished(again);
      assert.equal(audio.channels, 2);
    } finally {
      if (saved === undefined) delete process.env.ATMOS_RENDER;
      else process.env.ATMOS_RENDER = saved;
    }
  }
);

test(
  'real chain: without the renderer, the conversion runs without binaural',
  { skip: !haveRenderer && 'atmos-render not installed' },
  async () => {
    const saved = process.env.ATMOS_RENDER;
    process.env.ATMOS_RENDER = `${dir}/no-such-renderer`;
    try {
      const result = await call('/prepare', {
        input: `${process.env.AIOSTREAMS_INTERNAL_URL}/party/guest/source/truehd-missing`,
        viewer: 'fallback-viewer-xxxxxx',
        request: request(
          { audio: false, binaural: true, lossless: true },
          { positionMs: 1000 }
        ),
      });
      const state = await ready(result.lease);
      assert.equal(state.effective.audio.where === 'server-render', false);
      const { audio } = await finished(result);
      // converted as usual: no surround asked for, so stereo AAC
      assert.equal(audio.codec_name, 'aac');
    } finally {
      if (saved === undefined) delete process.env.ATMOS_RENDER;
      else process.env.ATMOS_RENDER = saved;
    }
  }
);
