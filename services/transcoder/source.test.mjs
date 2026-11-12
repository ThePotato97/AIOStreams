import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import http from 'node:http';

const exec = promisify(execFile);
const SECRET = 's'.repeat(32);

// A stand-in for AIOStreams: serves one source, and its reader's status. When `broken`, the
// source answers 502 and its status says why, as AIOStreams' reader would.
const aio = { file: Buffer.alloc(0), broken: false, statusAsked: [] };
let dir;
let aiostreams;
let worker;
let base;

before(async () => {
  dir = await mkdtemp(`${tmpdir()}/source-status-`);
  await exec('ffmpeg', [
    ...['-hide_banner', '-loglevel', 'error', '-y'],
    ...['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24'],
    ...['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000'],
    ...['-t', '20', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '48'],
    ...['-c:a', 'aac', `${dir}/clip.mkv`],
  ]);
  aio.file = await readFile(`${dir}/clip.mkv`);
  aiostreams = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    if (path.endsWith('/status')) {
      aio.statusAsked.push(path);
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify(
          aio.broken
            ? {
                state: 'failed',
                class: 'source',
                status: 502,
                code: 'source_unreachable',
                message: 'The usenet source could not be read',
              }
            : { state: 'ok' }
        )
      );
    }
    if (aio.broken) return res.writeHead(502).end();
    const m = /bytes=(\d+)-/.exec(req.headers.range ?? '');
    const start = m ? Number(m[1]) : 0;
    res.writeHead(m ? 206 : 200, {
      'Content-Type': 'video/x-matroska',
      'Accept-Ranges': 'bytes',
      'Content-Length': aio.file.length - start,
      ...(m
        ? {
            'Content-Range': `bytes ${start}-${aio.file.length - 1}/${aio.file.length}`,
          }
        : {}),
    });
    res.end(aio.file.subarray(start));
  });
  await new Promise((r) => aiostreams.listen(0, '127.0.0.1', r));
  process.env.AIOSTREAMS_INTERNAL_URL = `http://127.0.0.1:${aiostreams.address().port}`;
  process.env.TRANSCODER_SECRET = SECRET;
  process.env.CACHE_DIR = `${dir}/cache`;
  process.env.TRANSCODER_ENCODER = 'cpu';
  const { createServer } = await import('./server.mjs');
  worker = createServer();
  await new Promise((r) => worker.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${worker.address().port}`;
});
after(async () => {
  const { jobs, drop } = await import('./server.mjs');
  for (const job of [...jobs.values()]) await drop(job);
  worker?.close();
  aiostreams?.close();
  await rm(dir, { recursive: true, force: true });
});

const call = (path, body) =>
  fetch(`${base}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${SECRET}`,
      'Content-Type': 'application/json',
    },
    body: body && JSON.stringify(body),
  });
const source = (handle) =>
  `${process.env.AIOSTREAMS_INTERNAL_URL}/party/guest/source/${handle}`;

test("a probe that fails keeps the source's state, read from AIOStreams, without the handle", async () => {
  aio.broken = true;
  aio.statusAsked.length = 0;
  const res = await call('/probe', { input: source('PROBEHANDLE') });
  assert.notEqual(res.status, 200);
  assert.deepEqual(aio.statusAsked, ['/party/guest/source/PROBEHANDLE/status']);
  const health = await (await call('/health')).json();
  const last = health.probeSources.at(-1);
  assert.equal(last.state, 'failed');
  assert.equal(last.code, 'source_unreachable');
  assert.equal(last.status, 502);
  assert.ok(!JSON.stringify(health).includes('PROBEHANDLE'));
});

test("a conversion whose FFmpeg fails keeps the source's state on its job", async () => {
  aio.broken = false;
  const input = source('JOBHANDLE');
  // Probed while the source works; then it fails as the conversion reads it.
  assert.equal((await call('/probe', { input })).status, 200);
  aio.broken = true;
  aio.statusAsked.length = 0;
  const res = await call('/prepare', {
    input,
    viewer: 'v'.repeat(16),
    request: {
      positionMs: 0,
      quality: 'original',
      capabilities: { video: true, audio: false, container: false, hdr: true },
    },
  });
  const answer = await res.text();
  assert.notEqual(res.status, 200, answer);
  let job;
  for (let i = 0; i < 50 && !job?.source; i++) {
    job = (await (await call('/health')).json()).jobs[0];
    if (!job?.source) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(job, `no job; prepare answered ${res.status} ${answer}`);
  assert.equal(job.source.state, 'failed');
  assert.equal(job.source.code, 'source_unreachable');
  assert.equal(job.source.after, 'main');
  assert.ok(aio.statusAsked.includes('/party/guest/source/JOBHANDLE/status'));
});

test('an AIOStreams that does not answer gives an unknown state, not an error', async () => {
  const { sourceStatus } = await import('./server.mjs');
  assert.deepEqual(
    await sourceStatus('http://127.0.0.1:9/party/guest/source/H'),
    { state: 'unknown' }
  );
});
