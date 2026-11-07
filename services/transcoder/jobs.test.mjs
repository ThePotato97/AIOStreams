import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';

process.env.TRANSCODER_SECRET = 's'.repeat(32);
let transcoder;
before(async () => {
  transcoder = await import('./server.mjs');
});

/** A stand-in for FFmpeg: on SIGTERM it keeps writing for a moment, then exits. */
function flushingChild(dir) {
  return spawn(
    process.execPath,
    [
      '-e',
      `process.on('SIGTERM', () => {
         let i = 0;
         const t = setInterval(() => {
           require('fs').writeFileSync(${JSON.stringify(dir)} + '/segment-' + i++ + '.m4s', 'x');
           if (i === 5) { clearInterval(t); process.exit(0); }
         }, 40);
       });
       setInterval(() => {}, 1000);`,
    ],
    { stdio: 'ignore' }
  );
}
const ready = (child) =>
  new Promise((resolve) => setTimeout(resolve, 200, child));

test('dropping a job waits for FFmpeg to finish writing before removing it', async () => {
  const dir = await mkdtemp(`${tmpdir()}/job-`);
  await writeFile(`${dir}/index.m3u8`, '#EXTM3U');
  const child = await ready(flushingChild(dir));
  const job = { id: 'flush', dir, child, paused: false };
  transcoder.jobs.set(job.id, job);
  await transcoder.drop(job);
  assert.notEqual(child.exitCode, null, 'FFmpeg exited before the files went');
  await assert.rejects(stat(dir), { code: 'ENOENT' });
  assert.equal(transcoder.jobs.has('flush'), false);
});

test('a job whose FFmpeg ignores SIGTERM is killed, then removed', async () => {
  const dir = await mkdtemp(`${tmpdir()}/job-`);
  const child = await ready(
    spawn(
      process.execPath,
      ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
      { stdio: 'ignore' }
    )
  );
  const started = Date.now();
  await transcoder.drop({ id: 'stubborn', dir, child, paused: false });
  assert.equal(child.signalCode, 'SIGKILL');
  assert.ok(
    Date.now() - started >= 2900,
    'SIGKILL comes after the grace period'
  );
  await assert.rejects(stat(dir), { code: 'ENOENT' });
});

test('stopping a job that already exited resolves at once', async () => {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((resolve) => child.once('exit', resolve));
  await transcoder.stop({ child, paused: false });
  await transcoder.stop({ child: null, paused: false });
});

test('a segment not written yet is a 404, not a media failure', async () => {
  const dir = await mkdtemp(`${tmpdir()}/job-`);
  await mkdir(dir, { recursive: true });
  transcoder.jobs.set('pending', {
    id: 'pending',
    dir,
    child: null,
    viewers: new Map(),
    last: Date.now(),
  });
  const server = transcoder.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/jobs/pending/segment-000007.m4s`,
      { headers: { Authorization: `Bearer ${'s'.repeat(32)}` } }
    );
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'Not written yet' });
  } finally {
    server.close();
    transcoder.jobs.delete('pending');
  }
  assert.deepEqual(await readdir(dir), []);
});

test('native errors are passed on as their code and operation only', () => {
  const error = Object.assign(
    new Error("ENOTEMPTY: directory not empty, rmdir '/cache/abc'"),
    { code: 'ENOTEMPTY', syscall: 'rmdir', path: '/cache/abc' }
  );
  assert.equal(
    transcoder.mediaError(error),
    'Media operation failed (ENOTEMPTY in rmdir)'
  );
  assert.equal(
    transcoder.mediaError({ code: 'http://evil/secret', syscall: 'x y' }),
    'Media operation failed'
  );
  assert.equal(
    transcoder.mediaError({ cmd: 'ffmpeg …' }),
    'Media operation failed'
  );
});
