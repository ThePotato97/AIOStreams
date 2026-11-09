/// <reference lib="webworker" />
/*
 * The binaural transmuxer's worker: the renderer (WebAssembly) and the conversion run here, off
 * the page's thread. One worker per transmuxer, so one stream's renderer state.
 */
import { loadLibav } from 'libav-eac3';
import {
  BinauralConverter,
  type OutputPlan,
  type RendererExports,
} from './convert';
import { libavDecoder, REFERENCE_OPTIONS } from './eac3-core';
import type { Codec } from './codecs';

/**
 * Each codec libav.js decodes: FFmpeg's decoder, with the options the renderer's own FFmpeg child
 * uses (atmos-render's loudness.rs for the Dolby ones, FFmpeg's defaults for DTS), and the
 * renderer session it feeds (`eac3`: the Dolby core, its EMDF read from the bytes; `decoded`:
 * channels alone). The speaker version is decoded with FFmpeg's defaults, as the transcoder
 * decodes these for speakers.
 */
const DECODERS: Partial<
  Record<
    Codec,
    { name: string; options: [string, string][]; session: 'eac3' | 'decoded' }
  >
> = {
  eac3: { name: 'eac3', options: REFERENCE_OPTIONS, session: 'eac3' },
  ac3: { name: 'ac3', options: REFERENCE_OPTIONS, session: 'eac3' },
  dts: { name: 'dca', options: [], session: 'decoded' },
};

let converter: BinauralConverter | null = null;
let loading: Promise<BinauralConverter> | null = null;

type Request =
  | {
      id: number;
      type: 'load';
      wasmUrl: string;
      codec: Codec;
      plan: OutputPlan;
    }
  | { id: number; type: 'init' | 'segment'; data: ArrayBuffer };

self.onmessage = async (event: MessageEvent<Request>) => {
  const message = event.data;
  try {
    if (message.type === 'load') {
      loading = (async () => {
        const decoder = DECODERS[message.codec];
        const [{ instance }, libav] = await Promise.all([
          WebAssembly.instantiateStreaming(fetch(message.wasmUrl), {}),
          // FFmpeg's decoder, as libav.js; TrueHD is decoded by the renderer itself
          decoder
            ? (loadLibav?.() ??
              Promise.reject(new Error('The libav.js decoders were not built')))
            : null,
        ]);
        converter = new BinauralConverter(
          instance.exports as unknown as RendererExports,
          message.plan,
          decoder && libav
            ? {
                session: decoder.session,
                render: () =>
                  libavDecoder(libav, decoder.name, decoder.options),
                speakers: () => libavDecoder(libav, decoder.name),
              }
            : undefined
        );
        return converter;
      })();
      await loading;
      self.postMessage({ id: message.id });
      return;
    }
    const conv = converter ?? (await loading);
    if (!conv) throw new Error('The binaural renderer was not loaded');
    const bytes = new Uint8Array(message.data);
    const out =
      message.type === 'init' ? conv.init(bytes) : conv.segment(bytes);
    // the scene as rendered, for the player's debug view
    const snapshots = conv.takeSnapshots();
    self.postMessage({ id: message.id, data: out.buffer, snapshots }, [
      out.buffer,
    ]);
  } catch (error) {
    self.postMessage({ id: message.id, error: (error as Error).message });
  }
};
