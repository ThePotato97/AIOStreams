import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeManifest, parseTimeline, timelineOf } from './media.mjs';

/** A manifest as FFmpeg's DASH muxer writes one for a single stream. */
const mpd = ({ dynamic, start, kind, timescale, timeline, codec = '' }) =>
  `<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"
\tprofiles="urn:mpeg:dash:profile:isoff-live:2011"
\ttype="${dynamic ? 'dynamic' : 'static'}"
${dynamic ? `\tminimumUpdatePeriod="PT4S"\n\tavailabilityStartTime="${start}"\n` : '\tmediaPresentationDuration="PT20.0S"\n'}\tmaxSegmentDuration="PT4.0S"
\tminBufferTime="PT8.0S">
\t<Period id="0" start="PT0.0S">
\t\t<AdaptationSet id="0" contentType="${kind}" startWithSAP="1" segmentAlignment="true" bitstreamSwitching="true">
\t\t\t<Representation id="0" mimeType="${kind}/mp4" codecs="${codec}" bandwidth="1000">
\t\t\t\t<SegmentTemplate timescale="${timescale}" initialization="init-$RepresentationID$.m4s" media="chunk-$RepresentationID$-$Number%05d$.m4s" startNumber="1">
\t\t\t\t\t<SegmentTimeline>
${timeline}
\t\t\t\t\t</SegmentTimeline>
\t\t\t\t</SegmentTemplate>
\t\t\t</Representation>
\t\t</AdaptationSet>
\t</Period>
</MPD>
`;
// Video from 56 s (16 kHz timescale): 4 s segments, the first a little short.
const video = mpd({
  dynamic: true,
  start: '2026-11-12T23:00:00.000Z',
  kind: 'video',
  timescale: 16000,
  timeline: '<S t="896000" d="61984" />\n<S d="64000" r="5" />',
});
// Audio from 56 s (48 kHz), its job started 3 minutes after the video's.
const audio = mpd({
  dynamic: true,
  start: '2026-11-12T23:03:00.000Z',
  kind: 'audio',
  timescale: 48000,
  timeline: '<S t="2688000" d="192512" r="2" />\n<S d="191488" />',
});

test('manifest: a job manifest’s segments, numbered and timed', () => {
  const { timescale, segments } = parseTimeline(video);
  assert.equal(timescale, 16000);
  assert.equal(segments.length, 7);
  assert.deepEqual(segments[0], { number: 1, t: 896000, d: 61984 });
  assert.deepEqual(segments[1], { number: 2, t: 957984, d: 64000 });
  assert.deepEqual(segments[6], { number: 7, t: 1277984, d: 64000 });
});

test('manifest: a timeline says t= first and after a gap, and equal runs as r=', () => {
  const s = (t, d) => ({ number: 0, t, d });
  assert.equal(
    timelineOf([s(10, 4), s(14, 4), s(18, 4), s(22, 3), s(40, 4), s(44, 4)]),
    '<S t="10" d="4" r="2" />\n\t\t\t\t\t\t<S d="3" />\n\t\t\t\t\t\t<S t="40" d="4" r="1" />'
  );
});

test('manifest: a viewer’s manifest trims each stream to its window and points at its job', () => {
  const out = composeManifest(
    [
      {
        kind: 'video',
        id: 'VID',
        mpd: video,
        firstKept: 3,
        codec: 'hvc1.2.4.L120.90',
      },
      { kind: 'audio', id: 'AUD', mpd: audio, firstKept: 2, codec: null },
    ],
    { durationMs: 1800_000, windowMs: 60_000 }
  );
  // Dynamic while running, saying its window; the header (and availabilityStartTime) of a
  // running job.
  assert.match(out, /<MPD timeShiftBufferDepth="PT60S"/);
  assert.match(out, /type="dynamic"/);
  assert.equal(out.match(/availabilityStartTime/g).length, 1);
  const sets = out.match(/<AdaptationSet\b[\s\S]*?<\/AdaptationSet>/g);
  assert.equal(sets.length, 2);
  // Video: segments 3 on, the r=5 run split where the trim cut it.
  assert.match(sets[0], /<AdaptationSet id="0" contentType="video"/);
  assert.match(sets[0], /<Representation id="0"/);
  assert.match(sets[0], /codecs="hvc1.2.4.L120.90"/);
  assert.match(
    sets[0],
    /initialization="VID\/init-0.m4s" media="VID\/chunk-0-\$Number%05d\$.m4s" startNumber="3"/
  );
  assert.match(sets[0], /<S t="1021984" d="64000" r="4" \/>/);
  // Audio: its own numbering and timescale, segments 2 on.
  assert.match(sets[1], /<AdaptationSet id="1" contentType="audio"/);
  assert.match(sets[1], /<Representation id="1"/);
  assert.match(sets[1], /startNumber="2"/);
  assert.match(
    sets[1],
    /<S t="2880512" d="192512" r="1" \/>\s*<S d="191488" \/>/
  );
  // Nothing of FFmpeg's own templates is left.
  assert.ok(!out.includes('$RepresentationID$'));
});

test('manifest: once both jobs have finished it is static, with the full duration', () => {
  const done = (m) =>
    m
      .replace('type="dynamic"', 'type="static"')
      .replace(
        /\tminimumUpdatePeriod[^\n]*\n\tavailabilityStartTime[^\n]*\n/,
        '\tmediaPresentationDuration="PT20.0S"\n'
      );
  const out = composeManifest(
    [
      { kind: 'video', id: 'V', mpd: done(video), firstKept: 1 },
      { kind: 'audio', id: 'A', mpd: done(audio), firstKept: 1 },
    ],
    { durationMs: 1800_000, windowMs: 60_000 }
  );
  assert.match(out, /type="static"/);
  assert.match(out, /mediaPresentationDuration="PT1800.000S"/);
  assert.ok(!out.includes('timeShiftBufferDepth'));
});

test('manifest: an audio job started after its video finished keeps the manifest live', () => {
  const finished = video
    .replace('type="dynamic"', 'type="static"')
    .replace(
      /\tminimumUpdatePeriod[^\n]*\n\tavailabilityStartTime[^\n]*\n/,
      '\tmediaPresentationDuration="PT20.0S"\n'
    );
  const out = composeManifest(
    [
      { kind: 'video', id: 'V', mpd: finished, firstKept: 1 },
      { kind: 'audio', id: 'A', mpd: audio, firstKept: 1 },
    ],
    { durationMs: 1800_000, windowMs: 60_000 }
  );
  // The running audio job's header: dynamic, its own availabilityStartTime.
  assert.match(out, /type="dynamic"/);
  assert.match(out, /availabilityStartTime="2026-11-12T23:03:00.000Z"/);
  assert.equal(out.match(/<AdaptationSet\b/g).length, 2);
});

test('manifest: a viewer’s window reaches back to the first segment kept, however far ahead the job writes', () => {
  const out = composeManifest(
    [
      { kind: 'video', id: 'VID', mpd: video, firstKept: 3, codec: null },
      { kind: 'audio', id: 'AUD', mpd: audio, firstKept: 2, codec: null },
    ],
    { durationMs: 1800_000, windowMs: 10_000 }
  );
  // Kept: audio from 60.01 s, video to 83.87 s, plus a segment (4 s): players seek within the
  // depth behind the live edge, the last segment written.
  assert.match(out, /<MPD timeShiftBufferDepth="PT28S"/);
});
