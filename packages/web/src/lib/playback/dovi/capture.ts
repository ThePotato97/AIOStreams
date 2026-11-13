/*
 * Dolby Vision in a Shaka stream, seen as Shaka fetches it: a response filter that keeps each video
 * frame's RPU (parsed) by presentation time for the renderer, and turns the video init segment's
 * Dolby Vision configuration box into a free box, as Chrome refuses a track declaring Dolby
 * Vision through Media Source unless it's encrypted. The RPUs stay in the frames.
 */
import { RpuParser, rpuFromNal, type DoviParams } from './rpu';
import {
  segmentRpus,
  videoInit,
  withoutDoviConfig,
  type VideoInit,
} from './segments';

/** Shaka's RequestType.SEGMENT, and its AdvancedRequestType INIT_SEGMENT / MEDIA_SEGMENT. */
const SEGMENT = 1;
const INIT_SEGMENT = 0;
const MEDIA_SEGMENT = 1;
/** Kept around the playing position, seconds. */
const KEEP = 120;

interface Response {
  data: ArrayBuffer | ArrayBufferView;
}
interface Context {
  type?: number;
  stream?: { type?: string };
  /** Shaka's SegmentReference: its timestampOffset is the SourceBuffer's for this segment. */
  segment?: { timestampOffset?: number } | null;
}

const bytes = (d: ArrayBuffer | ArrayBufferView) =>
  ArrayBuffer.isView(d)
    ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength)
    : new Uint8Array(d);

export class DoviCapture {
  private init: VideoInit | null = null;
  private parser = new RpuParser();
  /** Sorted by time. */
  private frames: { time: number; params: DoviParams }[] = [];
  /** Whether any frame came with an RPU: the stream is Dolby Vision. */
  seen = false;
  private listeners = new Set<() => void>();

  /** Called once the stream turns out to be Dolby Vision. */
  onSeen(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** For Shaka's networking engine (registerResponseFilter). */
  filter = (type: number, response: Response, context?: Context) => {
    if (type !== SEGMENT || context?.stream?.type !== 'video') return;
    const data = bytes(response.data);
    if (context.type === INIT_SEGMENT) {
      this.init = videoInit(data);
      // a new stream (or a seek's new job): what the RPUs refer back to starts again
      this.parser = new RpuParser();
      if (this.init) response.data = withoutDoviConfig(data);
      return;
    }
    if (context.type !== MEDIA_SEGMENT || !this.init) return;
    try {
      const found = segmentRpus(data, this.init);
      if (!found.length) return;
      const offset = context.segment?.timestampOffset ?? 0;
      const added = found
        .map((f) => ({
          time: f.time + offset,
          params: this.parser.parse(rpuFromNal(f.nal)),
        }))
        .filter((f): f is { time: number; params: DoviParams } => !!f.params);
      if (!added.length) return;
      const from = added.reduce((m, f) => Math.min(m, f.time), Infinity);
      const to = added.reduce((m, f) => Math.max(m, f.time), -Infinity);
      this.frames = this.frames
        .filter((f) => f.time < from || f.time > to)
        .concat(added)
        .sort((a, b) => a.time - b.time);
      if (!this.seen) {
        this.seen = true;
        for (const l of this.listeners) l();
      }
    } catch {
      // A segment whose RPUs don't parse: its frames show as plain HDR10.
    }
  };

  /** The RPU of the frame shown at `time` (the video's mediaTime), within half a frame. */
  at(time: number): DoviParams | null {
    const list = this.frames;
    let lo = 0,
      hi = list.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].time < time) lo = mid + 1;
      else hi = mid;
    }
    let best: (typeof list)[number] | null = null;
    for (const i of [lo - 1, lo]) {
      const f = list[i];
      if (f && (!best || Math.abs(f.time - time) < Math.abs(best.time - time)))
        best = f;
    }
    // drop what's far from the playing position
    if (list.length > 6000)
      this.frames = list.filter((f) => Math.abs(f.time - time) < KEEP);
    return best && Math.abs(best.time - time) < 0.021 ? best.params : null;
  }
}
