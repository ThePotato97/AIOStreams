import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cases } from './spec-matrix.mjs';
import { ffmpegArgs, playbackSpec, streamArgs } from './media.mjs';

const ENCODERS = [
  ['cpu', {}],
  ['vaapi', {}],
  ['nvidia', { decode: 'gpu', tonemap: 'gpu' }],
  ['nvidia', { decode: 'cpu', tonemap: 'gpu' }],
  ['nvidia', { decode: 'cpu', tonemap: 'cpu' }],
];
/** Every flag (with its value, when it has one) of `names`, in order. */
function pick(args, names) {
  const out = [];
  for (let i = 0; i < args.length; i++)
    if (names.includes(args[i])) {
      const value = args[i + 1];
      out.push(
        value !== undefined && !value.startsWith('-')
          ? `${args[i]} ${value}`
          : args[i]
      );
    }
  return out;
}
const VIDEO = [
  '-vaapi_device',
  '-init_hw_device',
  '-filter_hw_device',
  '-hwaccel',
  '-hwaccel_device',
  '-hwaccel_output_format',
  '-ss',
  '-noaccurate_seek',
  '-c:v',
  '-tag:v',
  '-vf',
  '-filter_complex',
  '-preset',
  '-crf',
  '-cq',
  '-forced-idr',
  '-qp',
  '-b:v',
  '-maxrate',
  '-bufsize',
  '-force_key_frames',
  '-sc_threshold',
];
const AUDIO = ['-c:a', '-af', '-ac', '-b:a', '-sample_fmt', '-strict'];

test('stream jobs: each stream runs what the combined command ran for it', () => {
  let checked = 0;
  for (const { meta, request } of cases()) {
    let spec;
    try {
      spec = playbackSpec(meta, request);
    } catch {
      continue;
    }
    if (spec.video?.where === 'page-original' || !spec.video) continue;
    const binaural = spec.audio?.where === 'server-render';
    for (const [encoder, options] of ENCODERS) {
      const extra = binaural ? { audioStart: 1667.995 } : {};
      const combined = ffmpegArgs('in', meta, request, 'out', encoder, {
        ...options,
        ...extra,
        spec,
      });
      const video = streamArgs('video', 'in', meta, spec, 'out', encoder, {
        ...options,
        positionMs: request.positionMs,
      });
      // The picture: the same seek, decoding, filters and encoder settings.
      assert.deepEqual(
        pick(video.args, VIDEO),
        pick(combined.args, VIDEO),
        `video of ${JSON.stringify(spec.video)}`
      );
      assert.equal(video.tonemap, combined.tonemap);
      assert.equal(video.decode, combined.decode);
      assert.ok(video.args.includes('-an'));
      // TrueHD's experimental flag was the combined command's; the video job never has it, so
      // it never writes the Dolby Vision box that the RPU strip was there to avoid.
      assert.ok(!video.args.includes('-strict'));
      assert.ok(!video.args.includes('-bsf:v'));
      if (!spec.audio) continue;
      const audio = streamArgs('audio', 'in', meta, spec, 'out', encoder, {
        positionMs: request.positionMs,
        videoCopied: spec.video.where !== 'server-encode',
        ...extra,
      });
      // The sound: the same codec, layout and bitrate.
      assert.deepEqual(
        pick(audio.args, AUDIO),
        pick(combined.args, AUDIO).filter((a) => !a.startsWith('-c:v')),
        `audio of ${JSON.stringify(spec.audio)}`
      );
      assert.ok(audio.args.includes('-vn'));
      if (binaural) {
        assert.deepEqual(pick(audio.args, ['-i', '-output_ts_offset']), [
          '-i pipe:0',
          '-output_ts_offset 1667.995',
        ]);
      } else {
        const track =
          combined.args[
            combined.args.indexOf('-map', combined.args.indexOf('-map') + 1) + 1
          ];
        assert.equal(audio.args[audio.args.indexOf('-map') + 1], track);
        assert.deepEqual(
          pick(audio.args, ['-ss']),
          pick(combined.args, ['-ss']).slice(0, 1)
        );
      }
      checked++;
    }
  }
  assert.ok(checked > 1000, `checked ${checked}`);
});

test('stream jobs: GPU fallback applies only to a command that used the GPU', () => {
  const meta = {
    durationMs: 60_000,
    tracks: [
      {
        index: 0,
        type: 'video',
        codec: 'hevc',
        pixelFormat: 'yuv420p10le',
        hdr: true,
        transfer: 'smpte2084',
      },
      { index: 1, type: 'audio', codec: 'aac', channels: 2, sampleRate: 48000 },
    ],
  };
  const spec = (video) =>
    playbackSpec(meta, {
      quality: 'original',
      positionMs: 0,
      capabilities: { video, audio: true, container: false, hdr: video },
    });
  const copied = streamArgs('video', 'in', meta, spec(true), 'out', 'nvidia');
  assert.equal(spec(true).video.where, 'server-copy');
  assert.equal(copied.gpu, false);
  const encoded = streamArgs('video', 'in', meta, spec(false), 'out', 'nvidia');
  assert.equal(spec(false).video.where, 'server-encode');
  assert.equal(encoded.gpu, true);
  assert.equal(
    streamArgs('video', 'in', meta, spec(false), 'out', 'cpu').gpu,
    false
  );
});
