import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { metadata, select, ffmpegArgs } from './media.mjs';
const exec = promisify(execFile);
let dir, media;
before(async () => {
  dir = await mkdtemp(`${tmpdir()}/guest-media-`);
  await writeFile(
    `${dir}/subs.srt`,
    '1\n00:00:01,000 --> 00:00:04,000\nGuest playback\n'
  );
  await writeFile(
    `${dir}/chapters.txt`,
    ';FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=4000\ntitle=Opening\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=4000\nEND=12000\ntitle=Main\n'
  );
  await exec('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x180:rate=24',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440',
    '-i',
    `${dir}/subs.srt`,
    '-f',
    'ffmetadata',
    '-i',
    `${dir}/chapters.txt`,
    '-map',
    '0:v',
    '-map',
    '1:a',
    '-map',
    '2:s',
    '-map_metadata',
    '3',
    '-map_chapters',
    '3',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-g',
    '96',
    '-c:a',
    'ac3',
    '-c:s',
    'srt',
    '-t',
    '12',
    `${dir}/source.mkv`,
  ]);
  const { stdout } = await exec('ffprobe', [
    '-v',
    'error',
    '-show_format',
    '-show_streams',
    '-show_chapters',
    '-of',
    'json',
    `${dir}/source.mkv`,
  ]);
  media = metadata(JSON.parse(stdout));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});
const request = (extra = {}) => ({
  quality: 'original',
  positionMs: 0,
  capabilities: { video: true, audio: true, container: true, hdr: false },
  ...extra,
});
test('probe retains chapter timestamps and track choices', () => {
  assert.deepEqual(
    media.chapters.map((c) => c.title),
    ['Opening', 'Main']
  );
  assert.equal(media.chapters[1].startMs, 4000);
  assert.deepEqual(
    media.tracks.map((t) => t.type),
    ['video', 'audio', 'subtitle']
  );
});
test('conversion policy chooses direct, remux, audio, video and burn-in', () => {
  assert.equal(select(media, request()).mode, 'direct');
  assert.equal(
    select(
      media,
      request({ capabilities: { video: true, audio: true, container: false } })
    ).mode,
    'remux'
  );
  assert.equal(
    select(
      media,
      request({ capabilities: { video: true, audio: false, container: false } })
    ).mode,
    'audio'
  );
  assert.equal(select(media, request({ force: true })).mode, 'video');
  assert.equal(
    select(
      {
        ...media,
        tracks: media.tracks.map((t) =>
          t.type === 'subtitle' ? { ...t, codec: 'hdmv_pgs_subtitle' } : t
        ),
      },
      request({ subtitle: 2 })
    ).burn,
    true
  );
  assert.throws(() => select(media, request({ audio: 99 })), /Unknown track/);
});
for (const [name, options] of [
  [
    'remux',
    request({ capabilities: { video: true, audio: true, container: false } }),
  ],
  [
    'audio conversion',
    request({ capabilities: { video: true, audio: false, container: false } }),
  ],
  ['video conversion', request({ force: true, quality: '720p' })],
  ['seek generation', request({ force: true, positionMs: 7000 })],
])
  test(`real FFmpeg: ${name}`, async () => {
    const output = `${dir}/${name.replaceAll(' ', '-')}`;
    await mkdir(output);
    const command = ffmpegArgs(`${dir}/source.mkv`, media, options, output);
    await exec('ffmpeg', command.args, { timeout: 30000 });
    const playlist = await readFile(`${output}/index.m3u8`, 'utf8');
    assert.match(playlist, /#EXT-X-MAP/);
    assert.match(playlist, /#EXT-X-ENDLIST/);
    const { stdout } = await exec('ffprobe', [
      '-v',
      'error',
      '-show_streams',
      '-of',
      'json',
      `${output}/index.m3u8`,
    ]);
    const streams = JSON.parse(stdout).streams;
    assert.equal(
      streams.find((s) => s.codec_type === 'video').codec_name,
      'h264'
    );
    if (name === 'audio conversion')
      assert.equal(
        streams.find((s) => s.codec_type === 'audio').codec_name,
        'aac'
      );
    if (name === 'seek generation') assert.equal(command.offsetMs, 4000);
  });

test('real FFmpeg: styled subtitle burn-in', async () => {
  const input = `${dir}/styled.mkv`,
    output = `${dir}/styled-output`;
  await exec('ffmpeg', [
    '-v',
    'error',
    '-i',
    `${dir}/source.mkv`,
    '-map',
    '0',
    '-c',
    'copy',
    '-c:s',
    'ass',
    input,
  ]);
  const { stdout } = await exec('ffprobe', [
    '-v',
    'error',
    '-show_format',
    '-show_streams',
    '-of',
    'json',
    input,
  ]);
  const meta = metadata(JSON.parse(stdout));
  await mkdir(output);
  const command = ffmpegArgs(input, meta, request({ subtitle: 2 }), output);
  await exec('ffmpeg', command.args, { timeout: 30000 });
  assert.match(
    await readFile(`${output}/index.m3u8`, 'utf8'),
    /#EXT-X-ENDLIST/
  );
  assert.equal(command.policy.mode, 'video');
});

test('real FFmpeg: HDR to SDR', async () => {
  const input = `${dir}/hdr.mkv`,
    output = `${dir}/sdr`;
  await exec(
    'ffmpeg',
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=128x72:rate=24',
      '-t',
      '1',
      '-c:v',
      'libx265',
      '-pix_fmt',
      'yuv420p10le',
      '-color_primaries',
      'bt2020',
      '-color_trc',
      'smpte2084',
      '-colorspace',
      'bt2020nc',
      '-x265-params',
      'pools=1:frame-threads=1:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc',
      '-threads',
      '1',
      input,
    ],
    { timeout: 30000 }
  );
  const { stdout } = await exec('ffprobe', [
    '-v',
    'error',
    '-show_format',
    '-show_streams',
    '-of',
    'json',
    input,
  ]);
  const meta = metadata(JSON.parse(stdout));
  assert.equal(meta.tracks[0].hdr, true);
  await mkdir(output);
  await exec(
    'ffmpeg',
    ffmpegArgs(
      input,
      meta,
      request({
        capabilities: {
          video: false,
          audio: true,
          container: false,
          hdr: false,
        },
      }),
      output
    ).args,
    { timeout: 30000 }
  );
  const result = await exec('ffprobe', [
    '-v',
    'error',
    '-show_streams',
    '-of',
    'json',
    `${output}/index.m3u8`,
  ]);
  assert.equal(JSON.parse(result.stdout).streams[0].codec_name, 'h264');
});

test('companion HTTP: auth, source handles, shared jobs, subtitles, capacity and GPU fallback', async () => {
  const { createServer: createHttpServer } = await import('node:http');
  const { createReadStream } = await import('node:fs');
  const { stat } = await import('node:fs/promises');
  const source = createHttpServer(async (req, res) => {
    const file = req.url.includes('styled')
      ? `${dir}/styled.mkv`
      : `${dir}/source.mkv`;
    const size = (await stat(file)).size;
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
    const start = range ? Number(range[1]) : 0,
      end = range && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    res.writeHead(range ? 206 : 200, {
      'Content-Type': 'video/x-matroska',
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
    });
    if (req.method === 'HEAD') res.end();
    else createReadStream(file, { start, end }).pipe(res);
  });
  await new Promise((resolve, reject) => {
    source.once('error', reject);
    source.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${source.address().port}`;
  process.env.AIOSTREAMS_INTERNAL_URL = origin;
  process.env.TRANSCODER_SECRET = 's'.repeat(32);
  process.env.CACHE_DIR = `${dir}/worker`;
  process.env.TRANSCODER_ENCODER = 'nvidia';
  const { createServer } = await import('./server.mjs');
  const worker = createServer();
  await new Promise((resolve, reject) => {
    worker.once('error', reject);
    worker.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${worker.address().port}`;
  const headers = {
    Authorization: `Bearer ${process.env.TRANSCODER_SECRET}`,
    'Content-Type': 'application/json',
  };
  const call = (path, body) =>
    fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  try {
    assert.equal((await fetch(base + '/health')).status, 401);
    assert.equal(
      (await call('/probe', { input: 'http://example.invalid/video' })).status,
      400
    );
    const input = `${origin}/party/guest/source/${'a'.repeat(43)}`;
    const probe = await (await call('/probe', { input })).json();
    assert.equal(probe.chapters.length, 2);
    const body = {
      input,
      viewer: 'one'.repeat(8),
      request: request({
        capabilities: { video: true, audio: false, container: false },
      }),
    };
    const first = await call('/prepare', body);
    assert.equal(first.status, 200);
    const job = await first.json();
    assert.equal(job.mode, 'audio');
    const second = await (
      await call('/prepare', { ...body, viewer: 'two'.repeat(8) })
    ).json();
    assert.equal(second.id, job.id);
    assert.match(
      await (await call(`/jobs/${job.id}/index.m3u8`)).text(),
      /#EXT-X-MAP/
    );
    const subtitle = await call('/subtitle', { input, index: 2 });
    assert.equal(subtitle.status, 200);
    assert.match(await subtitle.text(), /WEBVTT/);
    const gpu = await call('/prepare', {
      input,
      viewer: 'three'.repeat(5),
      request: request({ force: true }),
    });
    assert.equal(gpu.status, 200);
    const gpuJob = await gpu.json();
    const health = await (await call('/health')).json();
    assert.ok(
      health.jobs.every((j) => j.encoder === 'cpu' || j.mode === 'audio')
    );
    const full = await call('/prepare', {
      input,
      viewer: 'four'.repeat(5),
      request: request({ force: true, quality: '720p' }),
    });
    assert.equal(full.status, 503);
    await call(`/jobs/${job.id}/touch`, { viewer: body.viewer, release: true });
    await call(`/jobs/${job.id}/touch`, {
      viewer: 'two'.repeat(8),
      release: true,
    });
    const replacement = await call('/prepare', {
      input,
      viewer: 'four'.repeat(5),
      request: request({ force: true, quality: '720p' }),
    });
    assert.equal(replacement.status, 200);
    await call(`/jobs/${gpuJob.id}/touch`, {
      viewer: 'three'.repeat(5),
      release: true,
    });
    const styled = await call('/prepare', {
      input: `${origin}/party/guest/source/styled`,
      viewer: 'styled'.repeat(5),
      request: request({ subtitle: 2 }),
    });
    assert.equal(styled.status, 200, await styled.text());
  } finally {
    await new Promise((resolve) => worker.close(resolve));
    await new Promise((resolve) => source.close(resolve));
  }
});
