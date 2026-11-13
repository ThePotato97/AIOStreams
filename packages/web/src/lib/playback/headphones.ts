/* eslint-disable lingui/no-unlocalized-strings -- audio graph settings, not UI text. */
import { watchHeadphones } from './headphone-setting';
import { HESUVI, HRIR_CHANNELS, layout, type Speaker } from './hrir-layout';
import { localAudio, routing, type Routing } from './binaural/local-audio';

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
  /** A stream carrying the binaural render and the speaker version: which channels are which. */
  route(routing: Routing | null): void;
  /** Its binaural pair, and its speaker channels, each on (1) or off (0). */
  binaural: GainNode;
  speakers: GainNode;
}

/** What an element's sound should be now. */
interface State {
  /** Through the HRIR virtualiser. */
  virtualise: boolean;
  /** One of a converted stream's two outputs (local-audio.ts); null for a plain stream. */
  packed: Routing | null;
  headphones: boolean;
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

/**
 * The element's sound in Web Audio. Made at once, set up for `state` before the element plays a
 * sample through it; the HRIR set follows when it's loaded.
 */
function build(el: HTMLMediaElement, state: State): Graph {
  const context = new AudioContext();
  const source = context.createMediaElementSource(el);
  const dry = context.createGain();
  const wet = context.createGain();
  dry.gain.value = 0;
  wet.gain.value = 0;
  source.connect(dry).connect(context.destination);
  wet.connect(context.destination);
  // A converted stream's two outputs: each of its channels to the binaural pair or the speakers.
  const binauralOut = context.createGain();
  const speakerOut = context.createGain();
  binauralOut.gain.value = 0;
  speakerOut.gain.value = 0;
  binauralOut.connect(context.destination);
  speakerOut.connect(context.destination);
  const pick = context.createChannelSplitter(8);
  pick.channelCount = 8;
  pick.channelCountMode = 'explicit';
  pick.channelInterpretation = 'discrete';
  source.connect(pick);
  let merges: AudioNode[] = [];
  let routed = '';
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
    binaural: binauralOut,
    speakers: speakerOut,
    route(r) {
      const key = r ? `${r.binaural}|${r.speakers}` : '';
      if (key === routed) return;
      routed = key;
      pick.disconnect();
      for (const m of merges) m.disconnect();
      merges = [];
      if (!r) return;
      const merge = (channels: number[], to: GainNode) => {
        if (!channels.length) return;
        const m = context.createChannelMerger(channels.length);
        channels.forEach((c, i) => pick.connect(m, c, i));
        // as the browser plays a stream of these channels: stereo, or 5.1 to its speakers
        m.channelInterpretation = 'speakers';
        m.connect(to);
        merges.push(m);
      };
      merge(r.binaural, binauralOut);
      merge(r.speakers, speakerOut);
      const dest = context.destination;
      if (r.speakers.length > dest.channelCount)
        dest.channelCount = Math.min(dest.maxChannelCount, r.speakers.length);
    },
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
  apply(graph, state);
  void hrirFor(context)
    .then((hrir) => graph.load(hrir))
    .catch(() => {});
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

function apply(graph: Graph, state: State) {
  graph.route(state.packed);
  const packed = !!state.packed;
  // A converted stream's chosen output, at once; otherwise the stream as it is, or virtualised.
  graph.binaural.gain.value = packed && state.headphones ? 1 : 0;
  graph.speakers.gain.value = packed && !state.headphones ? 1 : 0;
  graph.dry.gain.value = !packed && !state.virtualise ? 1 : 0;
  graph.wet.gain.value = !packed && state.virtualise ? 1 : 0;
  if (packed || state.virtualise) void graph.context.resume();
}

/**
 * Elements whose audio was already rendered for headphones (by the server, or converted in the
 * page), and their updates. An element's graph, made the first time it's needed, stays: its sound
 * can't leave Web Audio once it's in.
 */
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

/**
 * Keeps an element's sound as the headphones setting wants it: surround virtualised for
 * headphones, and of a stream converted in the page with both outputs (local-audio.ts), the
 * binaural pair for headphones and the speaker version otherwise, switched at once.
 */
export function virtualSurround(el: HTMLMediaElement): () => void {
  let setting = false;
  const update = () => {
    const plan = localAudio.current;
    // the page's conversion plays in this element where its sound is marked rendered
    const packed =
      rendered.get(el) && plan?.contents === 'both' ? routing(plan) : null;
    const state: State = {
      virtualise: setting && !rendered.get(el),
      packed,
      headphones: setting,
    };
    let graph = graphs.get(el);
    if (!graph) {
      if (
        (!state.virtualise && !packed) ||
        !audible(el) ||
        typeof AudioContext === 'undefined'
      )
        return;
      try {
        graph = build(el, state);
      } catch {
        return;
      }
      graphs.set(el, graph);
      live.add(graph);
    }
    apply(graph, state);
  };
  // Sound joins Web Audio only once a source it can hear is playing.
  el.addEventListener('loadedmetadata', update);
  updates.set(el, update);
  const unsubscribe = localAudio.subscribe(update);
  const unwatch = watchHeadphones((now) => {
    setting = now;
    update();
  });
  return () => {
    unwatch();
    unsubscribe();
    updates.delete(el);
    el.removeEventListener('loadedmetadata', update);
  };
}
