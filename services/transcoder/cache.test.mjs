import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { clearCache } from './server.mjs';

async function fill(dir) {
  await mkdir(`${dir}/job-a`, { recursive: true });
  await writeFile(`${dir}/job-a/segment-1.m4s`, 'x');
  await writeFile(`${dir}/stray`, 'x');
}

test('clearCache empties the directory but keeps it', async () => {
  const dir = await mkdtemp(`${tmpdir()}/transcoder-cache-`);
  try {
    await fill(dir);
    await clearCache(dir);
    assert.ok((await stat(dir)).isDirectory());
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('clearCache creates a missing directory', async () => {
  const base = await mkdtemp(`${tmpdir()}/transcoder-cache-`);
  try {
    await clearCache(`${base}/nested/cache`);
    assert.deepEqual(await readdir(`${base}/nested/cache`), []);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// The cache is normally a volume (Kubernetes emptyDir, a compose volume), and
// removing a mount point fails with EBUSY. Needs permission to mount tmpfs.
test('clearCache works on a mount point', async (t) => {
  const dir = await mkdtemp(`${tmpdir()}/transcoder-mount-`);
  try {
    try {
      execFileSync('mount', ['-t', 'tmpfs', 'tmpfs', dir], { stdio: 'ignore' });
    } catch {
      return t.skip('cannot mount tmpfs here');
    }
    try {
      await fill(dir);
      await assert.rejects(rm(dir, { recursive: true, force: true }), {
        code: 'EBUSY',
      });
      await clearCache(dir);
      assert.deepEqual(await readdir(dir), []);
    } finally {
      execFileSync('umount', [dir], { stdio: 'ignore' });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
