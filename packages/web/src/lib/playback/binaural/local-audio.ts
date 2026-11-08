/*
 * TrueHD and E-AC-3 decoded in the page (transmuxer.ts): what the player asks for, the plan the
 * transmuxer follows, and what it's producing now, for the page's audio graph (headphones.ts) to
 * play the right channels. Where the binaural render and the speaker version fit together (FLAC's
 * 8 channels) and the page can pick channels itself (Web Audio), both are carried and turning
 * headphones on or off switches between them at once; otherwise only the one wanted is.
 */
import { MAX_CHANNELS, type OutputPlan } from './convert';
import { LAYOUTS, channelsOf, speakerLayout } from './speakers';

/** The listener's headphone mode: as mixed (the stream's modes), every element Near, or Far. */
export type HeadphoneMode = 'mixed' | 'near' | 'far';
/** The renderer's codes for them (wasm.rs). */
const MODE_CODES: Record<HeadphoneMode, number> = { mixed: 0, near: 1, far: 2 };

export interface LocalAudioRequest {
  headphones: boolean;
  mode: HeadphoneMode;
  /** The output has six channels or more. */
  surround: boolean;
  /** The track's channels, as probed. */
  trackChannels: number;
}

/** Whether the browser outputs to six channels or more. */
export function surroundOutput(): boolean {
  if (typeof AudioContext === 'undefined') return false;
  const context = new AudioContext();
  const channels = context.destination.maxChannelCount;
  void context.close().catch(() => {});
  return channels >= 6;
}

/** Whether the page can play chosen channels of a stream (Web Audio). */
export const canRoute = () => typeof AudioContext !== 'undefined';

/** The conversion for a request: both outputs where they fit and the page can choose. */
export function planFor(request: LocalAudioRequest): OutputPlan {
  const layout = speakerLayout(request.trackChannels, request.surround);
  const speakers = channelsOf(LAYOUTS[layout]).length;
  const both = canRoute() && 2 + speakers <= MAX_CHANNELS;
  return {
    modes: MODE_CODES[request.mode],
    layout,
    contents: both ? 'both' : request.headphones ? 'binaural' : 'speakers',
  };
}

/** Channels of a converted stream: the binaural pair's, and the speaker version's. */
export interface Routing {
  binaural: number[];
  speakers: number[];
  /** Channels in the stream. */
  channels: number;
}

/** Where each output is in a plan's stream. */
export function routing(plan: OutputPlan): Routing {
  const speakers = channelsOf(LAYOUTS[plan.layout]).length;
  const range = (from: number, n: number) =>
    Array.from({ length: n }, (_, i) => from + i);
  switch (plan.contents) {
    case 'both':
      return {
        binaural: [0, 1],
        speakers: range(2, speakers),
        channels: 2 + speakers,
      };
    case 'binaural':
      return { binaural: [0, 1], speakers: [], channels: 2 };
    default:
      return { binaural: [], speakers: range(0, speakers), channels: speakers };
  }
}

let request: LocalAudioRequest | null = null;
let current: OutputPlan | null = null;
const listeners = new Set<() => void>();

export const localAudio = {
  /** Set by the player before each load: what the next conversion should be. */
  ask(next: LocalAudioRequest) {
    request = next;
  },
  get request() {
    return request;
  },
  /** The conversion running now (the transmuxer's), null without one. */
  get current() {
    return current;
  },
  started(plan: OutputPlan) {
    current = plan;
    for (const l of listeners) l();
  },
  stopped(plan: OutputPlan) {
    if (current !== plan) return;
    current = null;
    for (const l of listeners) l();
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
