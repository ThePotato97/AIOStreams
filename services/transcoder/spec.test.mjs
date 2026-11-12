import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { cases, record, digestOf } from './spec-matrix.mjs';
import { playbackSpec } from './media.mjs';

test('spec: every case runs exactly what it did before the spec', async () => {
  const pinned = JSON.parse(
    await readFile(new URL('./fixtures/spec-matrix.json', import.meta.url))
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
  const ask = (capabilities) =>
    playbackSpec(meta, {
      quality: 'original',
      positionMs: 0,
      subtitle: 2,
      capabilities,
    }).spec;
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
  assert.deepEqual(server.audio.output, {
    codec: 'flac',
    bitrate: null,
    layout: null,
    channels: null,
  });
  assert.equal(server.subtitle.where, 'server-burn');
  // A browser that can't show HDR: encoded with the tone map on the server.
  const sdr = ask({ video: true, hdr: false, subtitles: ['ass'] });
  assert.deepEqual(sdr.video.encode, {
    codec: 'h264',
    range: 'sdr',
    tonemap: 'server',
    deinterlace: false,
    height: null,
    maxBitrate: null,
  });
  // `picture` asks for what the older `dovi` flag did.
  const dv = { ...meta, tracks: [{ ...meta.tracks[0], dovi: { profile: 5 } }] };
  const draws = (caps) =>
    playbackSpec(dv, { quality: 'original', positionMs: 0, capabilities: caps })
      .spec.video;
  assert.deepEqual(
    draws({ video: true, hdr: true, picture: ['dovi'] }),
    draws({ video: true, hdr: true, dovi: true })
  );
  assert.equal(
    draws({ video: true, hdr: true, picture: ['dovi'] }).picture,
    'dovi'
  );
});
