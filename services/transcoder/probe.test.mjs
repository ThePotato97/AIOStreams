import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import http from 'node:http';
import { probeFailure } from './server.mjs';

const exec = promisify(execFile);
const ffprobe = (input, timeout = 20000) =>
  exec('ffprobe', ['-v', 'error', '-show_format', '-of', 'json', input], {
    timeout,
  });

test('a probe of something that is not media says so, without the URL', async () => {
  const server = http.createServer((_req, res) =>
    res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html>no</html>')
  );
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/party/guest/source/SECRETHANDLE`;
  try {
    const error = await ffprobe(url).then(
      () => assert.fail('ffprobe accepted HTML'),
      (e) => e
    );
    assert.equal(
      probeFailure(error),
      'Source probe failed: Invalid data found when processing input'
    );
  } finally {
    server.close();
  }
});

test('a probe of an unreachable source says so, without the URL', async () => {
  const error = await ffprobe(
    'http://127.0.0.1:9/party/guest/source/SECRETHANDLE'
  ).then(
    () => assert.fail('ffprobe reached a closed port'),
    (e) => e
  );
  assert.equal(probeFailure(error), 'Source probe failed: Connection refused');
});

test('a probe that runs out of time says it timed out', async () => {
  // Answers headers, then never sends the body.
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'video/mp4' });
    res.flushHeaders();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const error = await ffprobe(
      `http://127.0.0.1:${server.address().port}/stall`,
      1500
    ).then(
      () => assert.fail('ffprobe finished'),
      (e) => e
    );
    assert.equal(probeFailure(error), 'Source probe timed out');
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('every URL in the reason is removed, wherever it sits', () => {
  const stderr = (line) => ({ stderr: `${line}\n` });
  assert.equal(
    probeFailure(
      stderr(
        'http://aiostreams:3000/party/guest/source/SECRETHANDLE: Invalid data'
      )
    ),
    'Source probe failed: Invalid data'
  );
  assert.equal(
    probeFailure(
      stderr('[http @ 0x1] Redirect to https://cdn.example/tok?k=SECRET failed')
    ),
    'Source probe failed: [http @ 0x1] Redirect to source failed'
  );
});

test('a failure without stderr still reads as a probe failure', () => {
  assert.equal(probeFailure(new Error('x')), 'Source probe failed');
  assert.equal(probeFailure(undefined), 'Source probe failed');
});
