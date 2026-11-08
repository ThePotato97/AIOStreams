/*
 * A Shaka Player transmuxer that renders the transcoder's TrueHD or E-AC-3 DASH audio (codecs
 * "mlpa", "ec-3") to binaural FLAC in the browser, with atmos-render built as WebAssembly (and
 * for E-AC-3 FFmpeg's core decoder, as libav.js). Shaka hands it each segment and appends what
 * it returns, so buffering, seeking and A/V sync stay Shaka's.
 */
import { wasmUrl } from 'atmos-render-wasm-url';
import { sceneStore, type SceneSnapshot } from './objects';

/** What the browser plays instead. */
export const BINAURAL_OUTPUT = 'audio/mp4; codecs="flac"';
type Codec = 'truehd' | 'eac3';
/** Each codec as the transcoder's manifest names it. */
const INPUT: Record<Codec, RegExp> = {
  truehd: /codecs="?mlpa/i,
  eac3: /codecs="?ec-3/i,
};
/** Each codec as the browser would get it without the transmuxer. */
const TRUEHD_AS_IS = 'audio/mp4; codecs="mlpa"';
const EAC3_AS_IS = 'audio/mp4; codecs="ec-3"';
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
 * The codecs this browser renders to binaural itself: those it doesn't play itself (E-AC-3 also
 * needs the core decoder built).
 */
export function clientBinauralCodecs(): Codec[] {
  if (!clientBinauralSupported()) return [];
  const codecs: Codec[] = [];
  // Shaka transmuxes only what the browser can't play itself: where it claims to, it would get
  // the stream as it is, so the server renders that codec instead.
  if (!MediaSource.isTypeSupported(TRUEHD_AS_IS)) codecs.push('truehd');
  if (__LIBAV_EAC3__ && !MediaSource.isTypeSupported(EAC3_AS_IS))
    codecs.push('eac3');
  return codecs;
}

/** The worker's answer: converted bytes, and the scene snapshots taken converting them. */
interface Reply {
  data?: ArrayBuffer;
  snapshots?: SceneSnapshot[];
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
    this.loaded = this.call({ type: 'load', wasmUrl, codec }).then(() => {});
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
      return new Uint8Array(out.data ?? new ArrayBuffer(0));
    } catch (error) {
      // Shaka's TRANSMUXING_FAILED, which the guest engine answers with server rendering.
      throw this.failure((error as Error).message);
    }
  }

  destroy() {
    if (this.worker) sceneStore.stopped();
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
