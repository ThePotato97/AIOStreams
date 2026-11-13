import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createPassThrough } from './passthrough.mjs';
import { playbackSpec, streamArgs } from './media.mjs';

const FILE = Buffer.from('0123456789'.repeat(10_000));
const listen = (server, port = 0) =>
  new Promise((resolve) =>
    server.listen(port, '127.0.0.1', () => resolve(server.address().port))
  );
/** A free port nothing listens on (yet). */
async function freePort() {
  const s = http.createServer();
  const port = await listen(s);
  await new Promise((r) => s.close(r));
  return port;
}
/** AIOStreams' source route, as far as the pass-through sees it: ranges of FILE. */
function source(handler) {
  return http.createServer((req, res) => {
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
    const start = m ? Number(m[1]) : 0;
    handler(req, res, start);
  });
}
function ranged(res, start, body = FILE, etag = '"v1"') {
  res.writeHead(start ? 206 : 200, {
    'content-type': 'video/x-matroska',
    'content-length': body.length - start,
    ...(start
      ? { 'content-range': `bytes ${start}-${body.length - 1}/${body.length}` }
      : {}),
    'accept-ranges': 'bytes',
    etag,
  });
  return body.subarray(start);
}
/** Reads the pass-through's answer: its status, its body, and whether it ended cleanly. */
function read(url, range) {
  return new Promise((resolve) => {
    const req = http.get(url, { headers: range ? { range } : {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          body: Buffer.concat(chunks),
          complete: res.complete,
        })
      );
      res.on('error', () =>
        resolve({
          status: res.statusCode,
          body: Buffer.concat(chunks),
          complete: false,
        })
      );
      res.on('aborted', () =>
        resolve({
          status: res.statusCode,
          body: Buffer.concat(chunks),
          complete: false,
        })
      );
    });
    req.on('error', () =>
      resolve({ status: 0, body: Buffer.alloc(0), complete: false })
    );
  });
}
const unknown = async () => ({ state: 'unknown' });

test('holds a read while AIOStreams is away, then answers it as one response', async () => {
  const port = await freePort();
  const waits = [];
  const pt = createPassThrough({
    status: unknown,
    retryMs: 100,
    onWaiting: (input, waiting) => waits.push(waiting),
  });
  await pt.ready;
  const input = `http://127.0.0.1:${port}/party/guest/source/h`;
  const started = Date.now();
  const pending = read(pt.url(input), 'bytes=5-');
  // AIOStreams comes back after a while.
  await new Promise((r) => setTimeout(r, 700));
  const up = source((_req, res, start) => res.end(ranged(res, start)));
  await listen(up, port);
  const got = await pending;
  assert.equal(got.status, 206);
  assert.ok(got.complete);
  assert.deepEqual(got.body, FILE.subarray(5));
  assert.ok(Date.now() - started >= 700);
  // waitingSource set, then cleared once it answered.
  assert.deepEqual(waits, [true, false]);
  assert.equal(pt.failure(input), undefined);
  up.close();
  pt.close();
});

test('reopens a response cut part-way at the byte already sent', async () => {
  const ranges = [];
  let cut = true;
  const up = source((req, res, start) => {
    ranges.push(req.headers.range ?? null);
    const body = ranged(res, start);
    if (cut) {
      cut = false;
      // AIOStreams dies mid-read.
      res.write(body.subarray(0, 30_000), () => res.socket.destroy());
      return;
    }
    res.end(body);
  });
  const port = await listen(up);
  const pt = createPassThrough({ status: unknown, retryMs: 50 });
  await pt.ready;
  const got = await read(
    pt.url(`http://127.0.0.1:${port}/party/guest/source/h`)
  );
  assert.equal(got.status, 200);
  assert.ok(got.complete);
  assert.deepEqual(got.body, FILE);
  assert.equal(ranges[0], null);
  const resumedAt = Number(/bytes=(\d+)-/.exec(ranges[1])[1]);
  assert.ok(resumedAt > 0 && resumedAt <= 30_000);
  up.close();
  pt.close();
});

for (const [what, change] of [
  ['its ETag', (res, start) => ranged(res, start, FILE, '"v2"')],
  ['its size', (res, start) => ranged(res, start, Buffer.concat([FILE, FILE]))],
]) {
  test(`fails as the source's failure when the file changed (${what}) on reopening`, async () => {
    let first = true;
    const up = source((_req, res, start) => {
      if (first) {
        first = false;
        const body = ranged(res, start);
        res.write(body.subarray(0, 20_000), () => res.socket.destroy());
        return;
      }
      res.end(change(res, start));
    });
    const port = await listen(up);
    const input = `http://127.0.0.1:${port}/party/guest/source/h`;
    const pt = createPassThrough({ status: unknown, retryMs: 50 });
    await pt.ready;
    const got = await read(pt.url(input));
    assert.equal(got.complete, false);
    assert.ok(got.body.length < FILE.length);
    assert.equal(pt.failure(input)?.class, 'source');
    assert.equal(pt.failure(input)?.code, 'source_failed');
    up.close();
    pt.close();
  });
}

test('fails as the source when AIOStreams stays away too long', async () => {
  const port = await freePort();
  const input = `http://127.0.0.1:${port}/party/guest/source/h`;
  const pt = createPassThrough({
    status: unknown,
    retryMs: 50,
    maxWaitMs: 400,
  });
  await pt.ready;
  const started = Date.now();
  const got = await read(pt.url(input));
  assert.equal(got.status, 502);
  assert.ok(Date.now() - started >= 400);
  assert.equal(pt.failure(input)?.code, 'source_unreachable');
  assert.equal(pt.failure(input)?.class, 'source');
  pt.close();
});

test('fails at once when AIOStreams says the source failed, and passes on a refusal as it is', async () => {
  const up = source((req, res) => {
    if (req.url.endsWith('/gone')) return void res.writeHead(404).end();
    res.writeHead(503).end();
  });
  const port = await listen(up);
  const failed = {
    state: 'failed',
    class: 'source',
    status: 502,
    code: 'source_failed',
    message: 'The source failed',
  };
  const pt = createPassThrough({ status: async () => failed, retryMs: 5000 });
  await pt.ready;
  const input = `http://127.0.0.1:${port}/party/guest/source/h`;
  const started = Date.now();
  const got = await read(pt.url(input));
  assert.equal(got.status, 502);
  assert.ok(Date.now() - started < 2000);
  assert.deepEqual(pt.failure(input), failed);
  // A handle AIOStreams no longer knows isn't held.
  const gone = await read(
    pt.url(`http://127.0.0.1:${port}/party/guest/source/gone`)
  );
  assert.equal(gone.status, 404);
  up.close();
  pt.close();
});

test("FFmpeg's commands carry no I/O timeout that a held read would trip", () => {
  const meta = {
    durationMs: 60_000,
    tracks: [
      { index: 0, type: 'video', codec: 'h264', pixelFormat: 'yuv420p' },
      {
        index: 1,
        type: 'audio',
        codec: 'eac3',
        channels: 6,
        sampleRate: 48000,
      },
    ],
  };
  const spec = playbackSpec(meta, {
    quality: 'original',
    positionMs: 0,
    capabilities: { video: true, audio: false, container: false, hdr: false },
  });
  for (const kind of ['video', 'audio']) {
    const { args } = streamArgs(
      kind,
      'http://127.0.0.1:1/s/x',
      meta,
      spec,
      '/tmp/x',
      'cpu',
      {
        positionMs: 0,
      }
    );
    assert.ok(args.includes('http://127.0.0.1:1/s/x'));
    for (const flag of ['-rw_timeout', '-timeout', '-listen_timeout'])
      assert.ok(!args.includes(flag), `${kind} has ${flag}`);
  }
});

test('a viewer does not lapse while AIOStreams is away; the time away is credited when it is back', async () => {
  const { viewers, sweep, checkAiostreams, aiostreams } =
    await import('./server.mjs');
  const viewer = {
    lease: 'held',
    jobs: {},
    at: Date.now() - 70_000,
    version: 0,
    waiters: [],
  };
  viewers.set('held', viewer);
  try {
    // AIOStreams doesn't answer (it restarts): seen as away, and its viewer stays.
    await checkAiostreams(async () => {
      throw new TypeError('fetch failed');
    });
    assert.notEqual(aiostreams.awaySince, null);
    const awaySince = aiostreams.awaySince;
    process.env.AIOSTREAMS_INTERNAL_URL = 'http://127.0.0.1:1';
    await sweep();
    assert.ok(viewers.has('held'));
    // Back after 40 s: those 40 s are the viewer's, so its next heartbeat is in time.
    aiostreams.awaySince = awaySince - 40_000;
    const at = viewer.at;
    await checkAiostreams(async () => ({}));
    assert.equal(aiostreams.awaySince, null);
    assert.ok(viewer.at - at >= 40_000);
    // No heartbeat after all: it lapses as before.
    viewer.at = Date.now() - 70_000;
    await checkAiostreams(async () => ({}));
    const reachable = http.createServer((_req, res) => res.end());
    const port = await listen(reachable);
    process.env.AIOSTREAMS_INTERNAL_URL = `http://127.0.0.1:${port}`;
    await sweep();
    assert.ok(!viewers.has('held'));
    reachable.close();
  } finally {
    viewers.delete('held');
    delete process.env.AIOSTREAMS_INTERNAL_URL;
  }
});
