/*
 * The binaural renderer's scene as it renders it, for the player's debug view: snapshots from
 * the renderer (about 47 a second, `ar_debug` in atmos-render), stamped with the stream's time,
 * kept here for the view to read at the video's current time. Only audio rendered in this
 * browser has them; the server's binaural audio arrives as stereo.
 */

export type ElementKind =
  'object' | 'bed' | 'lfe' | 'isf' | 'bypass' | 'unknown';
export type RenderMode = 'off' | 'near' | 'far' | 'mid';

export interface SceneElement {
  kind: ElementKind;
  /** A bed channel's ID (atmos-render's `direct::bed_position`); a stereo-bypass input's side (0 left, 1 right). */
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
  /**
   * Its slot in Windows' renderer (E) with one app playing spatial audio; none where
   * Windows drops it or has no type for it. Seeks and pauses keep it (measured); another app's
   * spatial objects on the same device would move it.
   */
  slot: number | null;
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
  4: 'bypass',
};
const MODES: Record<number, RenderMode> = {
  0: 'off',
  1: 'near',
  2: 'far',
  3: 'mid',
};
const FIELDS = 10;

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
      const [kind, bed, mode, active, x, y, z, gain, level, slot] =
        data.subarray(at, at + FIELDS);
      elements.push({
        kind: KINDS[kind] ?? 'unknown',
        bed: kind === 1 || kind === 4 ? bed : undefined,
        mode: MODES[mode] ?? null,
        active: active === 1,
        pos: Number.isNaN(x) ? null : [x, y, z],
        gain,
        level,
        slot: slot >= 0 ? slot : null,
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

/** How long an element has to have had no signal to count as silent, seconds. */
export const SILENT_AFTER = 1;
/**
 * Below this an input counts as having no signal, dBFS: decoders leave idle objects at a noise
 * floor rather than at exact zero (DD+ JOC objects sit near -123 dB). Display only.
 */
export const SILENT_DB = -100;
const SILENT_LEVEL = 10 ** (SILENT_DB / 20);

/** Whether an input level is signal rather than a decoder's noise floor. */
export const hasSignal = (level: number) => level >= SILENT_LEVEL;

/**
 * The elements of `current` with no signal in any of `recent` (the snapshots of the last
 * `SILENT_AFTER` seconds, `current` among them): spare objects a mix doesn't use, say, rather than
 * a moment's quiet. Snapshots with another element count (a new scene) don't count.
 */
export function silentElements(
  recent: SceneSnapshot[],
  current: SceneSnapshot
): Set<number> {
  const same = recent.filter(
    (s) => s.elements.length === current.elements.length
  );
  const silent = new Set<number>();
  current.elements.forEach((_, i) => {
    if (same.every((s) => !hasSignal(s.elements[i].level))) silent.add(i);
  });
  return silent;
}

/** How much is kept around the playing position, seconds. */
const KEEP_BEHIND = 30;
const KEEP_AHEAD = 120;

type Listener = () => void;

class SceneStore {
  private snapshots: SceneSnapshot[] = [];
  private renderers = 0;
  private listeners = new Set<Listener>();
  /** Told when the switched-off elements change: the audio has to be rendered again. */
  private disabledListeners = new Set<Listener>();
  shown = false;
  /**
   * Elements switched off in the view (indices in the snapshots' order), rendered as silence in
   * this browser's binaural render. Kept across the reloads a change causes; cleared when the view
   * closes and when another track plays.
   */
  disabled: ReadonlySet<number> = new Set();

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
    // nothing stays switched off once the view that shows it is gone
    if (!this.shown) this.setDisabled(new Set());
    this.notify();
  };

  /** The switched-off elements, ascending. */
  disabledList(): number[] {
    return [...this.disabled].sort((a, b) => a - b);
  }

  private setDisabled(next: Set<number>) {
    const same =
      next.size === this.disabled.size &&
      [...next].every((i) => this.disabled.has(i));
    if (same) return;
    this.disabled = next;
    this.notify();
    for (const l of this.disabledListeners) l();
  }

  /** Switches one element on or off. */
  toggleElement = (index: number) => {
    const next = new Set(this.disabled);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    this.setDisabled(next);
  };

  /** Switches these elements on or off together. */
  setElements = (indices: number[], on: boolean) => {
    const next = new Set(this.disabled);
    for (const i of indices) {
      if (on) next.delete(i);
      else next.add(i);
    }
    this.setDisabled(next);
  };

  /** Only `index` stays on, of `count` elements. */
  only = (index: number, count: number) => {
    this.setDisabled(
      new Set(
        Array.from({ length: count }, (_, i) => i).filter((i) => i !== index)
      )
    );
  };

  /** Everything on again. */
  allOn = () => this.setDisabled(new Set());

  /** For the player: told when the switched-off elements change. */
  subscribeDisabled = (listener: Listener) => {
    this.disabledListeners.add(listener);
    return () => this.disabledListeners.delete(listener);
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

  /** The snapshots from `from` to `to`, seconds. */
  between(from: number, to: number): SceneSnapshot[] {
    return this.snapshots.filter((s) => s.time >= from && s.time <= to);
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
