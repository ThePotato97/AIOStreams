/*
 * Dolby Vision drawn over a playing video: on each frame the video presents
 * (requestVideoFrameCallback), the frame and its RPU (capture.ts) through the renderer onto a
 * canvas laid exactly over the video's picture. The video plays on underneath, keeping A/V sync,
 * buffering and seeking; only its picture is covered.
 */
import type { DoviCapture } from './capture';
import { DoviRenderer } from './renderer';

let supported: Promise<boolean> | null = null;

/**
 * Whether this browser can draw Dolby Vision itself: an HDR display, WebGPU with an extended-range
 * canvas, and video frames to read. Checked once.
 */
export function doviSupported(): Promise<boolean> {
  supported ??= (async () => {
    if (
      typeof document === 'undefined' ||
      typeof VideoFrame === 'undefined' ||
      !('requestVideoFrameCallback' in HTMLVideoElement.prototype) ||
      !matchMedia('(dynamic-range: high)').matches
    )
      return false;
    const renderer = await DoviRenderer.create(
      document.createElement('canvas')
    ).catch(() => null);
    renderer?.destroy();
    return !!renderer;
  })();
  return supported;
}

/** The rectangle the video's picture fills, in the page (object-fit contain or cover). */
function pictureRect(video: HTMLVideoElement) {
  const box = video.getBoundingClientRect();
  const fit = getComputedStyle(video).objectFit;
  const vw = video.videoWidth || box.width;
  const vh = video.videoHeight || box.height;
  if (fit === 'fill' || !vw || !vh) return box;
  const scale =
    fit === 'cover'
      ? Math.max(box.width / vw, box.height / vh)
      : Math.min(box.width / vw, box.height / vh);
  const w = vw * scale,
    h = vh * scale;
  return {
    left: box.left + (box.width - w) / 2,
    top: box.top + (box.height - h) / 2,
    width: w,
    height: h,
  };
}

export class DoviView {
  private stopped = false;
  private drawing = false;
  private handle = 0;

  private constructor(
    private readonly video: HTMLVideoElement,
    private readonly capture: DoviCapture,
    private readonly renderer: DoviRenderer,
    private readonly canvas: HTMLCanvasElement,
    private readonly onFail: (error: Error) => void
  ) {
    this.handle = video.requestVideoFrameCallback(this.step);
  }

  /** Starts drawing over the video; null where this browser can't. */
  static async start(
    video: HTMLVideoElement,
    capture: DoviCapture,
    onFail: (error: Error) => void
  ): Promise<DoviView | null> {
    if (!(await doviSupported())) return null;
    const canvas = document.createElement('canvas');
    canvas.dataset.ui = 'dovi';
    Object.assign(canvas.style, {
      position: 'fixed',
      pointerEvents: 'none',
      // above the video, under the controls that follow it
      zIndex:
        getComputedStyle(video).zIndex === 'auto'
          ? '0'
          : getComputedStyle(video).zIndex,
      display: 'none',
    });
    const renderer = await DoviRenderer.create(canvas);
    if (!renderer) return null;
    video.insertAdjacentElement('afterend', canvas);
    return new DoviView(video, capture, renderer, canvas, onFail);
  }

  private place() {
    const r = pictureRect(this.video);
    Object.assign(this.canvas.style, {
      left: `${r.left}px`,
      top: `${r.top}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
    });
  }

  private step = (_now: number, meta: VideoFrameCallbackMetadata) => {
    if (this.stopped) return;
    this.handle = this.video.requestVideoFrameCallback(this.step);
    // a frame still drawing: this one is skipped rather than queued
    if (this.drawing || !this.capture.seen) return;
    this.drawing = true;
    const frame = new VideoFrame(this.video);
    this.renderer
      .draw(frame, this.capture.at(meta.mediaTime))
      .then(() => {
        if (this.stopped) return;
        this.place();
        this.canvas.style.display = '';
      })
      .catch((error: Error) => {
        if (this.stopped) return;
        this.destroy();
        this.onFail(error);
      })
      .finally(() => {
        frame.close();
        this.drawing = false;
      });
  };

  destroy() {
    if (this.stopped) return;
    this.stopped = true;
    this.video.cancelVideoFrameCallback(this.handle);
    this.canvas.remove();
    this.renderer.destroy();
  }
}
