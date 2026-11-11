/*
 * A Shaka Player transmuxer that converts the transcoder's TrueHD, E-AC-3, AC-3 or DTS DASH audio
 * (codecs "mlpa", "ec-3", "ac-3", "mp4a.a9") in the browser to FLAC: the binaural render
 * (atmos-render built as WebAssembly, and for the others FFmpeg's decoders, as libav.js) and the
 * speaker version, as the player's
 * request asks (local-audio.ts). Shaka hands it each segment and appends what it returns, so
 * buffering, seeking and A/V sync stay Shaka's.
 */
import { wasmUrl } from 'atmos-render-wasm-url';
import type { OutputPlan } from './convert';
import { localAudio, planFor } from './local-audio';
import { sceneStore, type SceneSnapshot } from './objects';
import type { Codec } from './codecs';

/** Without a request from the player: the binaural render alone, as before. */
const BINAURAL_ONLY: OutputPlan = {
  modes: 0,
  layout: 'stereo',
  contents: 'binaural',
};

/** What the browser plays instead. */
export const BINAURAL_OUTPUT = 'audio/mp4; codecs="flac"';
/**
 * Each codec as the transcoder's manifest names it: DTS as MP4's object types for it (FFmpeg
 * writes 0xA9; DTS-HD's are 0xAA and 0xAB) or its sample entries.
 */
const INPUT: Record<Codec, RegExp> = {
  truehd: /codecs="?mlpa/i,
  eac3: /codecs="?ec-3/i,
  ac3: /codecs="?ac-3/i,
  dts: /codecs="?(mp4a\.a[9ab]|dts[cehl])\b/i,
};
/** Each codec as the browser would get it without the transmuxer. */
/* eslint-disable lingui/no-unlocalized-strings -- MIME types for the browser, not UI text */
const AS_IS: Record<Codec, string> = {
  truehd: 'audio/mp4; codecs="mlpa"',
  eac3: 'audio/mp4; codecs="ec-3"',
  ac3: 'audio/mp4; codecs="ac-3"',
  dts: 'audio/mp4; codecs="mp4a.a9"',
};
/* eslint-enable lingui/no-unlocalized-strings */
/** The codecs libav.js decodes, where it was built (scripts/build-libav-eac3.sh). */
const LIBAV: Codec[] = __LIBAV_DECODERS__ as Codec[];
const codecOf = (mimeType: string) =>
  (Object.keys(INPUT) as Codec[]).find((c) => INPUT[c].test(mimeType));

/** Whether this browser can render binaural audio itself at all. */
export function clientBinauralSupported(): boolean {
  return (
    !!wasmUrl &&
    typeof WebAssembly !== 'undefined' &&
    typeof Worker !== 'undefined' &&
    typeof MediaSource !== 'undefined' &&
    MediaSource.isTypeSupported(BINAURAL_OUTPUT)
  );
}

/**
 * The codecs this browser renders to binaural itself: those it doesn't play itself (all but
 * TrueHD also need their decoder built into libav.js).
 */
export function clientBinauralCodecs(): Codec[] {
  if (!clientBinauralSupported()) return [];
  // Shaka transmuxes only what the browser can't play itself: where it claims to, it would get
  // the stream as it is, so the server renders that codec instead.
  return (['truehd', ...LIBAV] as Codec[]).filter(
    (codec) => !MediaSource.isTypeSupported(AS_IS[codec])
  );
}

/** The worker's answer: converted bytes, and the scene snapshots taken converting them. */
interface Reply {
  data?: ArrayBuffer;
  snapshots?: SceneSnapshot[];
  /** A media segment's: its seconds of audio, and the milliseconds converting it took. */
  timing?: { seconds: number; ms: number };
}

/** The last segments' conversion times, for how fast this browser converts the audio. */
const timings: { seconds: number; ms: number; at: number }[] = [];
const TIMED = 4;
/** Older than this, the conversion isn't running: no speed to report. */
const STALE_MS = 30_000;

/**
 * Seconds of audio this browser converts per second of work, over its last few segments; null
 * when it hasn't converted any lately.
 */
export function renderSpeed(): number | null {
  const now = Date.now();
  const recent = timings.filter((t) => now - t.at < STALE_MS);
  const ms = recent.reduce((n, t) => n + t.ms, 0);
  const seconds = recent.reduce((n, t) => n + t.seconds, 0);
  return recent.length && ms > 0 ? seconds / (ms / 1000) : null;
}

/** Makes the error Shaka reports for a segment that couldn't be converted. */
type Failure = (message: string) => Error;

class BinauralTransmuxer {
  constructor(private readonly failure: Failure) {}
  private worker: Worker | null = null;
  private loaded: Promise<void> | null = null;
  private next = 1;
  private waiting = new Map<
    number,
    {
      resolve(reply: Reply): void;
      reject(e: Error): void;
    }
  >();
  private original = '';
  private plan: OutputPlan | null = null;

  private call(message: object, transfer: Transferable[] = []): Promise<Reply> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.worker!.postMessage({ ...message, id }, transfer);
    });
  }

  private start(codec: Codec): Promise<void> {
    if (this.loaded) return this.loaded;
    sceneStore.started();
    this.worker = new Worker(new URL('./worker.ts', import.meta.url));
    this.worker.onmessage = (
      event: MessageEvent<Reply & { id: number; error?: string }>
    ) => {
      const { id, error, ...reply } = event.data;
      const waiting = this.waiting.get(id);
      this.waiting.delete(id);
      if (error) waiting?.reject(new Error(error));
      else waiting?.resolve(reply);
    };
    this.worker.onerror = (event) => {
      for (const w of this.waiting.values())
        w.reject(new Error(event.message || 'Binaural worker failed'));
      this.waiting.clear();
    };
    const request = localAudio.request;
    const plan = {
      ...(request ? planFor(request) : BINAURAL_ONLY),
      // what the debug view has switched off
      disabled: sceneStore.disabledList(),
    };
    this.plan = plan;
    this.loaded = this.call({ type: 'load', wasmUrl, codec, plan }).then(() =>
      localAudio.started(plan)
    );
    return this.loaded;
  }

  isSupported(mimeType: string, contentType?: string): boolean {
    const codec = codecOf(mimeType);
    return (
      contentType !== 'video' &&
      !!codec &&
      clientBinauralCodecs().includes(codec)
    );
  }

  convertCodecs(_contentType: string, mimeType: string): string {
    this.original = mimeType;
    return BINAURAL_OUTPUT;
  }

  getOriginalMimeType(): string {
    return this.original;
  }

  async transmux(
    data: ArrayBuffer | ArrayBufferView,
    stream: { codecs?: string } | null,
    reference: unknown
  ): Promise<Uint8Array> {
    const view = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);
    const copy = view.slice().buffer;
    try {
      const codec =
        codecOf(this.original) ?? codecOf(`codecs="${stream?.codecs ?? ''}"`);
      if (!codec)
        throw new Error(`Not a stream rendered here: ${this.original}`);
      await this.start(codec);
      const out = await this.call(
        { type: reference ? 'segment' : 'init', data: copy },
        [copy]
      );
      if (out.snapshots) sceneStore.add(out.snapshots);
      if (out.timing?.seconds) {
        timings.push({ ...out.timing, at: Date.now() });
        timings.splice(0, Math.max(0, timings.length - TIMED));
      }
      return new Uint8Array(out.data ?? new ArrayBuffer(0));
    } catch (error) {
      // Shaka's TRANSMUXING_FAILED, which the guest engine answers with server rendering.
      throw this.failure((error as Error).message);
    }
  }

  destroy() {
    timings.length = 0;
    if (this.worker) sceneStore.stopped();
    if (this.plan) localAudio.stopped(this.plan);
    this.worker?.terminate();
    this.worker = null;
    for (const w of this.waiting.values())
      w.reject(new Error('Binaural transmuxer closed'));
    this.waiting.clear();
  }
}

/** Shaka's error code for a segment a transmuxer couldn't convert. */
export const TRANSMUXING_FAILED = 3018;

interface ShakaTransmuxers {
  util: {
    Error: new (
      severity: number,
      category: number,
      code: number,
      ...data: unknown[]
    ) => Error;
  };
  transmuxer: {
    TransmuxerEngine: {
      registerTransmuxer(
        mimeType: string,
        plugin: () => unknown,
        priority: number
      ): void;
      PluginPriority: { APPLICATION: number };
    };
  };
}

let registered = false;
/** Registers the transmuxer with Shaka once (for audio/mp4; it takes only "mlpa"). */
export function registerBinauralTransmuxer(shaka: ShakaTransmuxers) {
  if (registered || !clientBinauralSupported()) return;
  registered = true;
  const engine = shaka.transmuxer.TransmuxerEngine;
  // CRITICAL (2), MEDIA (3)
  const failure: Failure = (message) =>
    new shaka.util.Error(2, 3, TRANSMUXING_FAILED, message);
  engine.registerTransmuxer(
    'audio/mp4',
    () => new BinauralTransmuxer(failure),
    engine.PluginPriority.APPLICATION
  );
}
