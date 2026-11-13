/*
 * Subtitles drawn over the video in the browser, rather than burned into it:
 * ASS/SSA with JASSUB (libass in WebAssembly), PGS with libpgs. Both draw on
 * a canvas they keep in step with the video's own time, which for a
 * converted stream is the source's.
 */

/** A subtitle being drawn; destroy stops it and removes its canvas. */
export interface Renderer {
  destroy(): void;
}

/** Whether this browser can run the renderers at all. */
export function canRender(): boolean {
  return (
    typeof WebAssembly === 'object' &&
    typeof Worker === 'function' &&
    typeof OffscreenCanvas === 'function'
  );
}

/** Draws an ASS/SSA subtitle, with the fonts its file carries. */
export async function renderAss(
  video: HTMLVideoElement,
  content: string,
  fonts: string[]
): Promise<Renderer> {
  const { default: JASSUB } = await import('jassub');
  const renderer = new JASSUB({ video, subContent: content, fonts });
  await renderer.ready;
  return { destroy: () => void renderer.destroy().catch(() => {}) };
}

/** Draws a PGS (Blu-ray) subtitle. */
export async function renderPgs(
  video: HTMLVideoElement,
  data: ArrayBuffer
): Promise<Renderer> {
  const [{ PgsRenderer }, { default: workerSource }] = await Promise.all([
    import('libpgs'),
    // libpgs starts its worker from a URL; its worker is one file, so it
    // runs from its own source as a blob, wherever the app is served.
    import('libpgs/dist/libpgs.worker.js?raw'),
  ]);
  const workerUrl = URL.createObjectURL(
    new Blob([workerSource], { type: 'text/javascript' })
  );
  const renderer = new PgsRenderer({
    video,
    workerUrl,
    aspectRatio: 'contain',
  });
  await renderer.loadFromBuffer(data);
  return {
    destroy: () => {
      renderer.dispose();
      URL.revokeObjectURL(workerUrl);
    },
  };
}
