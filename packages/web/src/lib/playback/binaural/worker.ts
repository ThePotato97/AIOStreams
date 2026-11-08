/// <reference lib="webworker" />
/*
 * The binaural transmuxer's worker: the renderer (WebAssembly) and the conversion run here, off
 * the page's thread. One worker per transmuxer, so one stream's renderer state.
 */
import { BinauralConverter, type RendererExports } from './convert';

let converter: BinauralConverter | null = null;
let loading: Promise<BinauralConverter> | null = null;

type Request =
  | { id: number; type: 'load'; wasmUrl: string }
  | { id: number; type: 'init' | 'segment'; data: ArrayBuffer };

self.onmessage = async (event: MessageEvent<Request>) => {
  const message = event.data;
  try {
    if (message.type === 'load') {
      loading = WebAssembly.instantiateStreaming(
        fetch(message.wasmUrl),
        {}
      ).then(
        ({ instance }) =>
          (converter = new BinauralConverter(
            instance.exports as unknown as RendererExports
          ))
      );
      await loading;
      self.postMessage({ id: message.id });
      return;
    }
    const conv = converter ?? (await loading);
    if (!conv) throw new Error('The binaural renderer was not loaded');
    const bytes = new Uint8Array(message.data);
    const out =
      message.type === 'init' ? conv.init(bytes) : conv.segment(bytes);
    self.postMessage({ id: message.id, data: out.buffer }, [out.buffer]);
  } catch (error) {
    self.postMessage({ id: message.id, error: (error as Error).message });
  }
};
