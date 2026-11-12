import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { guestPlaybackSpecSchema, type GuestPlaybackSpec } from './guest.js';

/** The transcoder's decisions (services/transcoder/fixtures/spec-examples.json). */
const examples = JSON.parse(
  readFileSync(
    new URL(
      '../../../services/transcoder/fixtures/spec-examples.json',
      import.meta.url
    ),
    'utf8'
  )
) as { name: string; spec: unknown }[];

describe('guestPlaybackSpecSchema', () => {
  it('accepts every spec the transcoder decides, as it writes it', () => {
    assert.ok(examples.length >= 6);
    for (const { name, spec } of examples) {
      const parsed = guestPlaybackSpecSchema.safeParse(spec);
      assert.ok(parsed.success, `${name}: ${parsed.error?.message}`);
      assert.deepEqual(parsed.data, spec, name);
    }
  });
  it('has a place for every planned value', () => {
    const planned: GuestPlaybackSpec = {
      video: {
        track: 0,
        where: 'page-demux',
        encode: {
          codec: 'hevc10',
          range: 'hdr10',
          tonemap: 'none',
          deinterlace: true,
          scale: 1080,
          maxBitrate: '8M',
        },
        picture: 'tonemap-sdr',
        reason: null,
      },
      audio: {
        track: 1,
        where: 'server-render',
        pageRenders: false,
        convert: null,
        render: { binaural: true, mode: 'near', codec: 'aac', bitrate: '192k' },
        reason: 'binaural rendering',
      },
      subtitle: { track: 2, where: 'page', format: 'vobsub' },
    };
    assert.ok(guestPlaybackSpecSchema.safeParse(planned).success);
    for (const where of ['page-original', 'server-copy', 'server-encode'])
      assert.ok(
        guestPlaybackSpecSchema.safeParse({
          ...planned,
          video: { ...planned.video!, where },
        }).success
      );
    assert.ok(
      guestPlaybackSpecSchema.safeParse({
        ...planned,
        video: {
          ...planned.video!,
          encode: { ...planned.video!.encode!, codec: 'av1' },
        },
      }).success
    );
  });
  it('rejects what it has no place for', () => {
    const [{ spec }] = examples as { spec: GuestPlaybackSpec }[];
    const unknown = (patch: object) =>
      !guestPlaybackSpecSchema.safeParse({ ...spec, ...patch }).success;
    assert.ok(unknown({ video: { ...spec.video!, where: 'server-magic' } }));
    assert.ok(unknown({ video: { ...spec.video!, height: 720 } }));
    assert.ok(unknown({ extra: true }));
  });
});
