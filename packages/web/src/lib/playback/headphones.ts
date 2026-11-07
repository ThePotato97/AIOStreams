/* eslint-disable lingui/no-unlocalized-strings -- audio graph settings, not UI text. */
import { watchHeadphones } from './headphone-setting';
import { HESUVI, HRIR_CHANNELS, layout, type Speaker } from './hrir-layout';

/*
 * Virtual surround for headphones, in the browser: each speaker channel of a
 * surround track is convolved with that speaker's left-ear and right-ear
 * impulse responses (an HRIR set) and the ears are summed, as HeSuVi and
 * the system virtualisers do. The bundled set is HeSuVi's capture of Dolby
 * Atmos for Headphones in 7.1 (hrir/atmos.wav).
 */

/** The low-frequency channel reaches both ears unprocessed, below this. */
const LFE_HZ = 120;
const LFE_GAIN = Math.SQRT1_2;
/** Checks how many channels a track has, by which carry sound. */
const LAYOUT_POLL_MS = 1000;

interface Graph {
  context: AudioContext;
  dry: GainNode;
  wet: GainNode;
  channels: number;
  rewire(channels: number): void;
  /** Puts an HRIR set (HeSuVi's 14-channel layout) in the convolvers. */
  load(hrir: AudioBuffer): void;
}
const graphs = new WeakMap<HTMLMediaElement, Graph>();
const live = new Set<Graph>();

/** The user's own HRIR set, kept in IndexedDB as the WAV they chose. */
const DB = 'aiostreams-web-hrir';
const STORE = 'files';
const KEY = 'custom';
function store<T>(
  mode: IDBTransactionMode,
  run: (files: IDBObjectStore) => IDBRequest
): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const done = run(db.transaction(STORE, mode).objectStore(STORE));
      done.onsuccess = () => {
        db.close();
        resolve(done.result as T);
      };
      done.onerror = () => {
        db.close();
        reject(done.error);
      };
    };
  });
}

export interface CustomHrir {
  name: string;
  data: ArrayBuffer;
}
export const customHrir = () =>
  store<CustomHrir>('readonly', (files) => files.get(KEY)).catch(
    () => undefined
  );

async function decode(context: BaseAudioContext, data: ArrayBuffer) {
  const hrir = await context.decodeAudioData(data.slice(0));
  if (hrir.numberOfChannels !== HRIR_CHANNELS)
    throw new Error(`channels: ${hrir.numberOfChannels}`);
  return hrir;
}

async function hrirFor(context: BaseAudioContext): Promise<AudioBuffer> {
  const custom = await customHrir();
  if (custom) {
    try {
      return await decode(context, custom.data);
    } catch {
      /* Fall back to the bundled set. */
    }
  }
  const response = await fetch(new URL('./hrir/atmos.wav', import.meta.url));
  return decode(context, await response.arrayBuffer());
}

/**
 * Uses a HeSuVi-layout WAV (14 channels) in place of the bundled set, or
 * the bundled set again with null. Throws for a file that isn't one.
 */
export async function setCustomHrir(file: File | null): Promise<void> {
  if (file) {
    const data = await file.arrayBuffer();
    const check = new OfflineAudioContext(1, 1, 48000);
    await decode(check, data);
    await store('readwrite', (files) =>
      files.put({ name: file.name, data } satisfies CustomHrir, KEY)
    );
  } else {
    await store('readwrite', (files) => files.delete(KEY));
  }
  for (const graph of live)
    hrirFor(graph.context)
      .then((hrir) => graph.load(hrir))
      .catch(() => {});
}

/** Whether Web Audio hears a URL without CORS: a converted stream or the page's own. */
export function readable(url: string): boolean {
  if (!url || url.startsWith('blob:')) return true;
  try {
    return new URL(url, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}
/** The source playing now, once it's known, is heard by Web Audio. */
const audible = (el: HTMLMediaElement) =>
  !!el.currentSrc && readable(el.currentSrc);

/**
 * Readies an element to load a URL. Once its sound is in Web Audio it's
 * heard from another site only with CORS, so that's asked for: true when it
 * was, and the load should be tried again without it if refused.
 */
export function corsFor(el: HTMLMediaElement, url: string): boolean {
  const cors = graphs.has(el) && !readable(url);
  if (cors) el.crossOrigin = 'anonymous';
  else el.removeAttribute('crossorigin');
  return cors;
}

async function build(el: HTMLMediaElement): Promise<Graph> {
  const context = new AudioContext();
  const source = context.createMediaElementSource(el);
  const dry = context.createGain();
  const wet = context.createGain();
  source.connect(dry).connect(context.destination);
  wet.connect(context.destination);
  const hrir = await hrirFor(context);
  // Each speaker: one convolver with a stereo response, a mono input.
  const speakers = Object.fromEntries(
    (Object.keys(HESUVI) as Speaker[]).map((speaker) => {
      const convolver = context.createConvolver();
      convolver.normalize = false;
      convolver.connect(wet);
      return [speaker, convolver];
    })
  ) as Record<Speaker, ConvolverNode>;
  const lfe = context.createBiquadFilter();
  lfe.type = 'lowpass';
  lfe.frequency.value = LFE_HZ;
  const lfeGain = context.createGain();
  lfeGain.gain.value = LFE_GAIN;
  const both = context.createChannelMerger(2);
  lfe.connect(lfeGain);
  lfeGain.connect(both, 0, 0);
  lfeGain.connect(both, 0, 1);
  both.connect(wet);
  const split = context.createChannelSplitter(8);
  split.channelCount = 8;
  split.channelCountMode = 'explicit';
  split.channelInterpretation = 'discrete';
  source.connect(split);
  // Channels 7 and 8 carry sound only in 7.1.
  const back = context.createAnalyser();
  const merge = context.createChannelMerger(2);
  split.connect(merge, 6, 0);
  split.connect(merge, 7, 1);
  merge.connect(back);
  const graph: Graph = {
    context,
    dry,
    wet,
    channels: 0,
    rewire(channels) {
      if (channels === graph.channels) return;
      graph.channels = channels;
      split.disconnect();
      split.connect(merge, 6, 0);
      split.connect(merge, 7, 1);
      layout(channels).forEach((speaker, i) => {
        if (speaker === 'LFE') split.connect(lfe, i);
        else if (speaker) split.connect(speakers[speaker], i);
      });
    },
    load(set) {
      for (const speaker of Object.keys(HESUVI) as Speaker[]) {
        const [left, right] = HESUVI[speaker];
        const buffer = context.createBuffer(2, set.length, set.sampleRate);
        buffer.copyToChannel(set.getChannelData(left), 0);
        buffer.copyToChannel(set.getChannelData(right), 1);
        speakers[speaker].buffer = buffer;
      }
    },
  };
  graph.load(hrir);
  graph.rewire(6);
  // A new track starts out as 5.1 again, until its back pair is heard.
  el.addEventListener('loadstart', () => graph.rewire(6));
  const samples = new Float32Array(back.fftSize);
  setInterval(() => {
    if (el.paused) return;
    back.getFloatTimeDomainData(samples);
    if (samples.some((v) => Math.abs(v) > 1e-4)) graph.rewire(8);
  }, LAYOUT_POLL_MS);
  // A context made before the first play is suspended until a gesture.
  el.addEventListener('play', () => void context.resume());
  return graph;
}

function apply(graph: Graph, on: boolean) {
  graph.dry.gain.value = on ? 0 : 1;
  graph.wet.gain.value = on ? 1 : 0;
  if (on) void graph.context.resume();
}

/**
 * Keeps an element's sound rendered for headphones while the setting is on.
 * The graph is made the first time it's turned on, and then stays: an
 * element's sound can't leave Web Audio once it's in.
 */
/** Elements whose audio the server already rendered for headphones, and their updates. */
const rendered = new WeakMap<HTMLMediaElement, boolean>();
const updates = new WeakMap<HTMLMediaElement, () => void>();

/**
 * Says whether an element's current audio was rendered to binaural on the server: the virtualiser
 * stays off for it (it would put the binaural pair through an HRTF again).
 */
export function setServerBinaural(el: HTMLMediaElement, binaural: boolean) {
  rendered.set(el, binaural);
  updates.get(el)?.();
}

export function virtualSurround(el: HTMLMediaElement): () => void {
  let setting = false;
  let building: Promise<void> | null = null;
  const update = () => {
    const on = setting && !rendered.get(el);
    const graph = graphs.get(el);
    if (graph) return apply(graph, on);
    if (!on || building || !audible(el) || typeof AudioContext === 'undefined')
      return;
    building = build(el)
      .then((made) => {
        graphs.set(el, made);
        live.add(made);
        // as things stand once it's made
        apply(made, setting && !rendered.get(el));
      })
      .catch(() => {})
      .finally(() => {
        building = null;
      });
  };
  // Sound joins Web Audio only once a source it can hear is playing.
  el.addEventListener('loadedmetadata', update);
  updates.set(el, update);
  const unwatch = watchHeadphones((now) => {
    setting = now;
    update();
  });
  return () => {
    unwatch();
    updates.delete(el);
    el.removeEventListener('loadedmetadata', update);
  };
}
