import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { cases, record, digestOf, readPin } from './spec-matrix.mjs';
import { playbackSpec } from './media.mjs';

test('spec: every case runs exactly what it did before the spec', async () => {
  const pinned = readPin(
    await readFile(new URL('./fixtures/spec-matrix.json.gz', import.meta.url))
  );
  const changed = [];
  let count = 0;
  for (const c of cases()) {
    count++;
    if ((await digestOf(record(c))) !== pinned[c.name]) changed.push(c.name);
  }
  assert.equal(count, Object.keys(pinned).length, 'the matrix itself changed');
  assert.deepEqual(changed.slice(0, 20), [], `${changed.length} cases changed`);
});

test('spec: where each stream is worked on, for the main players', () => {
  const meta = {
    durationMs: 1,
    container: 'matroska,webm',
    tracks: [
      {
        index: 0,
        type: 'video',
        codec: 'hevc',
        hdr: true,
        transfer: 'smpte2084',
      },
      {
        index: 1,
        type: 'audio',
        codec: 'eac3',
        channels: 6,
        sampleRate: 48000,
      },
      { index: 2, type: 'subtitle', codec: 'ass' },
    ],
  };
  const ask = (capabilities, inputs) =>
    playbackSpec(
      meta,
      { quality: 'original', positionMs: 0, subtitle: 2, capabilities },
      inputs
    );
  // Chrome: the page renders E-AC-3 and draws ASS; nothing is converted.
  const chrome = ask({
    video: true,
    hdr: true,
    clientBinaural: ['eac3'],
    subtitles: ['ass'],
  });
  assert.equal(chrome.video.where, 'server-copy');
  assert.equal(chrome.audio.where, 'server-copy');
  assert.equal(chrome.audio.pageRenders, true);
  assert.equal(chrome.subtitle.where, 'page');
  // Headphones without a page renderer: the server renders binaural.
  const server = ask({
    video: true,
    hdr: true,
    binaural: true,
    lossless: true,
  });
  assert.equal(server.audio.where, 'server-render');
  assert.deepEqual(server.audio.render, {
    binaural: true,
    mode: null,
    codec: 'flac',
    bitrate: null,
  });
  // The renderer failed on this track: converted instead, not asked of it again.
  const failed = ask(
    { video: true, hdr: true, binaural: true, lossless: true, surround: true },
    { binauralFailed: true }
  );
  assert.equal(failed.audio.where, 'server-convert');
  assert.deepEqual(failed.audio.convert, {
    codec: 'flac',
    layout: '5.1',
    channels: 6,
    bitrate: null,
  });
  assert.equal(server.subtitle.where, 'server-burn');
  // A browser that can't show HDR: encoded with the tone map on the server.
  const sdr = ask({ video: true, hdr: false, subtitles: ['ass'] });
  assert.deepEqual(sdr.video.encode, {
    codec: 'h264',
    range: 'sdr',
    tonemap: 'server',
    deinterlace: false,
    scale: null,
    maxBitrate: null,
  });
  // Dolby Vision drawn by the page is asked for with `picture`; the old `dovi` flag is gone.
  const dv = { ...meta, tracks: [{ ...meta.tracks[0], dovi: { profile: 5 } }] };
  const draws = (caps) =>
    playbackSpec(dv, { quality: 'original', positionMs: 0, capabilities: caps })
      .video;
  assert.equal(
    draws({ video: true, hdr: true, picture: ['dovi'] }).picture,
    'dovi'
  );
  assert.equal(
    draws({ video: true, hdr: true, dovi: true }).where,
    'server-encode'
  );
});

test('spec: the shared examples are what the transcoder decides', async () => {
  // fixtures/spec-examples.json is also parsed by core's schema (packages/core/src/guest.test.ts),
  // so this mirror and the TypeScript type check against the same specs.
  const examples = JSON.parse(
    await readFile(new URL('./fixtures/spec-examples.json', import.meta.url))
  );
  assert.ok(examples.length >= 6);
  for (const { name, meta, request, inputs, spec } of examples)
    assert.deepEqual(playbackSpec(meta, request, inputs), spec, name);
});
