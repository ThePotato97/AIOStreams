/*
 * Dolby Vision in the transcoder's DASH video: the RPUs (per-frame metadata, HEVC NAL units of
 * type 62) of each segment with their frames' presentation times, and an init segment Chrome
 * plays (it refuses a track declaring Dolby Vision through Media Source unless encrypted).
 */
import { boxes, child, readFragments, top } from '../binaural/fmp4';

export interface VideoInit {
  timescale: number;
  /**
   * Seconds the edit list moves presentation earlier (its media_time): FFmpeg's for B-frames'
   * reordering delay. Chrome applies it, so a frame's mediaTime is its tfdt + offset minus this.
   */
  shift: number;
  /** Bytes of each NAL unit's length prefix (hvcC). */
  lengthSize: number;
}

const SAMPLE_ENTRIES = new Set(['hvc1', 'hev1', 'dvh1', 'dvhe']);
const DOVI_BOXES = new Set(['dvcC', 'dvvC', 'dvwC']);

/** The video track's sample entry, if this init segment has an HEVC one. */
function sampleEntry(data: Uint8Array) {
  const stsd = child(
    data,
    child(
      data,
      child(
        data,
        child(data, child(data, top(data, 'moov'), 'trak'), 'mdia'),
        'minf'
      ),
      'stbl'
    ),
    'stsd'
  );
  if (!stsd) return null;
  // full box (4) + entry count (4), then the entries
  for (const e of boxes(data, stsd.start + 8, stsd.end))
    if (SAMPLE_ENTRIES.has(e.type)) return e;
  return null;
}

/** An HEVC video init segment's timescale and NAL length size; null for anything else. */
export function videoInit(data: Uint8Array): VideoInit | null {
  const entry = sampleEntry(data);
  if (!entry) return null;
  const mdhd = child(
    data,
    child(data, child(data, top(data, 'moov'), 'trak'), 'mdia'),
    'mdhd'
  );
  if (!mdhd) return null;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const timescale = v.getUint32(
    mdhd.start + (data[mdhd.start] === 1 ? 20 : 12)
  );
  // visual sample entry: 78 bytes before its child boxes
  let lengthSize = 4;
  for (const b of boxes(data, entry.start + 78, entry.end))
    if (b.type === 'hvcC') lengthSize = (data[b.start + 21] & 3) + 1;
  return { timescale, lengthSize, shift: editShift(data, v) / timescale };
}

/**
 * The media_time of the edit list's first entry that isn't empty (-1), in the track's timescale;
 * 0 without one. (FFmpeg writes a single entry for the transcoder's DASH.)
 */
function editShift(data: Uint8Array, v: DataView): number {
  const elst = child(
    data,
    child(data, child(data, top(data, 'moov'), 'trak'), 'edts'),
    'elst'
  );
  if (!elst) return 0;
  const version = data[elst.start];
  const count = v.getUint32(elst.start + 4);
  const size = version === 1 ? 20 : 12;
  for (let i = 0; i < count; i++) {
    const at = elst.start + 8 + i * size;
    if (at + size > elst.end) break;
    const mediaTime =
      version === 1 ? Number(v.getBigInt64(at + 8)) : v.getInt32(at + 4);
    if (mediaTime >= 0) return mediaTime;
  }
  return 0;
}

/** Whether the init segment declares Dolby Vision (a dvcC/dvvC/dvwC box). */
export function declaresDovi(data: Uint8Array): boolean {
  const entry = sampleEntry(data);
  if (!entry) return false;
  for (const b of boxes(data, entry.start + 78, entry.end))
    if (DOVI_BOXES.has(b.type)) return true;
  return false;
}

/** The init segment with its Dolby Vision configuration box made a free box (same size). */
export function withoutDoviConfig(data: Uint8Array): Uint8Array {
  const entry = sampleEntry(data);
  if (!entry) return data;
  const out = data.slice();
  for (const b of boxes(out, entry.start + 78, entry.end))
    if (DOVI_BOXES.has(b.type)) out.set([0x66, 0x72, 0x65, 0x65], b.at + 4);
  return out;
}

export interface FrameRpu {
  /** Presentation time, seconds. */
  time: number;
  /** The NAL unit (type 62), header included. */
  nal: Uint8Array;
}

/** Each frame's RPU NAL unit in a media segment, in decoding order. */
export function segmentRpus(data: Uint8Array, init: VideoInit): FrameRpu[] {
  const out: FrameRpu[] = [];
  for (const f of readFragments(data)) {
    let dts = f.start;
    for (const s of f.samples) {
      const time = (dts + s.offset) / init.timescale - init.shift;
      dts += s.duration;
      const d = s.data;
      let at = 0;
      while (at + init.lengthSize <= d.length) {
        let len = 0;
        for (let i = 0; i < init.lengthSize; i++) len = len * 256 + d[at + i];
        at += init.lengthSize;
        if (len < 2 || at + len > d.length) break;
        const type = (d[at] >> 1) & 0x3f;
        if (type === 62) out.push({ time, nal: d.subarray(at, at + len) });
        at += len;
      }
    }
  }
  return out;
}
