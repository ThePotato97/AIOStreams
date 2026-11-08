/// <reference lib="webworker" />
/*
 * The binaural transmuxer's worker: the renderer (WebAssembly) and the conversion run here, off
 * the page's thread. One worker per transmuxer, so one stream's renderer state.
 */
import { loadLibav } from 'libav-eac3';
import { BinauralConverter, type RendererExports } from './convert';
import { eac3Core } from './eac3-core';

let converter: BinauralConverter | null = null;
let loading: Promise<BinauralConverter> | null = null;

type Request =
  | { id: number; type: 'load'; wasmUrl: string; codec: 'truehd' | 'eac3' }
  | { id: number; type: 'init' | 'segment'; data: ArrayBuffer };

self.onmessage = async (event: MessageEvent<Request>) => {
  const message = event.data;
  try {
    if (message.type === 'load') {
      loading = (async () => {
        const [{ instance }, libav] = await Promise.all([
          WebAssembly.instantiateStreaming(fetch(message.wasmUrl), {}),
          // E-AC-3: FFmpeg's decoder for the core, as libav.js
          message.codec === 'eac3'
            ? (loadLibav?.() ??
              Promise.reject(new Error('The E-AC-3 decoder was not built')))
            : null,
        ]);
        converter = new BinauralConverter(
          instance.exports as unknown as RendererExports,
          libav ? () => eac3Core(libav) : undefined
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
