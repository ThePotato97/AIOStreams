/*
 * The binaural renderer's scene as it renders it, for the player's debug view: snapshots from
 * the renderer (about 47 a second, `ar_debug` in atmos-render), stamped with the stream's time,
 * kept here for the view to read at the video's current time. Only audio rendered in this
 * browser has them; the server's binaural audio arrives as stereo.
 */

export type ElementKind = 'object' | 'bed' | 'lfe' | 'isf' | 'unknown';
export type RenderMode = 'off' | 'near' | 'far' | 'mid';

export interface SceneElement {
  kind: ElementKind;
  /** A bed channel's ID (atmos-render's `direct::bed_position`). */
  bed?: number;
  /** Atmos for Headphones' render mode; none for the LFE. */
  mode: RenderMode | null;
  active: boolean;
  /** Dolby x (left to right), y (front to back), z (floor to ceiling), 0..1; none for the LFE. */
  pos: [number, number, number] | null;
  /** The metadata gain, linear. */
  gain: number;
  /** The input's RMS level over the snapshot's block, linear (after the input headroom). */
  level: number;
}

export interface SceneSnapshot {
  /** Stream time, seconds: the manifest's (and the video's) timeline. */
  time: number;
  elements: SceneElement[];
}

const KINDS: Record<number, ElementKind> = {
  0: 'object',
  1: 'bed',
  2: 'lfe',
  3: 'isf',
};
const MODES: Record<number, RenderMode> = {
  0: 'off',
  1: 'near',
  2: 'far',
  3: 'mid',
};
const FIELDS = 9;

/** Reads `ar_debug_data`'s layout (atmos-render's `input::Snapshots`). */
export function readSnapshots(
  data: Float64Array,
  /** Stream time of the session's first sample, seconds. */
  start: number,
  rate: number
): SceneSnapshot[] {
  const out: SceneSnapshot[] = [];
  let at = 0;
  while (at + 2 <= data.length) {
    const time = start + data[at] / rate;
    const count = data[at + 1];
    at += 2;
    const elements: SceneElement[] = [];
    for (
      let i = 0;
      i < count && at + FIELDS <= data.length;
      i++, at += FIELDS
    ) {
      const [kind, bed, mode, active, x, y, z, gain, level] = data.subarray(
        at,
        at + FIELDS
      );
      elements.push({
        kind: KINDS[kind] ?? 'unknown',
        bed: kind === 1 ? bed : undefined,
        mode: MODES[mode] ?? null,
        active: active === 1,
        pos: Number.isNaN(x) ? null : [x, y, z],
        gain,
        level,
      });
    }
    out.push({ time, elements });
  }
  return out;
}

/** Bed channel labels by ID, from their positions. */
export const BED_LABELS: Record<number, string> = {
  1: 'L',
  2: 'R',
  3: 'C',
  4: 'LFE',
  5: 'Ls',
  6: 'Rs',
  7: 'Lrs',
  8: 'Rrs',
  9: 'Ltf',
  10: 'Rtf',
  11: 'Ltm',
  12: 'Rtm',
  13: 'Ltr',
  14: 'Rtr',
  15: 'Lw',
  16: 'Rw',
};

/** How much is kept around the playing position, seconds. */
const KEEP_BEHIND = 30;
const KEEP_AHEAD = 120;

type Listener = () => void;

class SceneStore {
  private snapshots: SceneSnapshot[] = [];
  private renderers = 0;
  private listeners = new Set<Listener>();
  shown = false;

  private notify() {
    for (const l of this.listeners) l();
  }

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Whether audio is being rendered in this browser now (the view has something to show). */
  get live() {
    return this.renderers > 0;
  }

  started() {
    this.renderers++;
    if (this.renderers === 1) this.notify();
  }

  stopped() {
    this.renderers = Math.max(0, this.renderers - 1);
    if (!this.renderers) {
      this.snapshots = [];
      this.notify();
    }
  }

  toggle = () => {
    this.shown = !this.shown;
    this.notify();
  };

  /** Snapshots of a converted segment; a seek's segments replace what they overlap. */
  add(snapshots: SceneSnapshot[]) {
    if (!snapshots.length) return;
    const from = snapshots[0].time;
    const to = snapshots[snapshots.length - 1].time;
    this.snapshots = this.snapshots
      .filter((s) => s.time < from || s.time > to)
      .concat(snapshots)
      .sort((a, b) => a.time - b.time);
  }

  /** The snapshot in effect at `time` (the last one at or before it), within a second. */
  at(time: number): SceneSnapshot | null {
    const list = this.snapshots;
    let lo = 0,
      hi = list.length - 1,
      found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].time <= time) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (found < 0 || time - list[found].time > 1) return null;
    // Drop what's far from the playing position.
    if (list.length > 4096)
      this.snapshots = list.filter(
        (s) => s.time > time - KEEP_BEHIND && s.time < time + KEEP_AHEAD
      );
    return list[found];
  }
}

export const sceneStore = new SceneStore();
