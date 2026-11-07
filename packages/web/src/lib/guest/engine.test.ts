/* eslint-disable lingui/no-unlocalized-strings -- test data, not UI text. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (event: string, data: unknown) => void;
const fakes = vi.hoisted(() => ({
  hls: [] as FakeHls[],
  hlsSupported: true,
  raw: undefined as
    | {
        emit: (event: unknown) => void;
        loads: { url: string; startMs: number }[];
      }
    | undefined,
}));
interface FakeHls {
  config: { startPosition?: number };
  handlers: Map<string, Handler>;
  startLoad: ReturnType<typeof vi.fn>;
  recoverMediaError: ReturnType<typeof vi.fn>;
  destroyed: boolean;
  fire(event: string, data?: unknown): void;
}

vi.mock('@lingui/core/macro', () => ({
  t: (s: TemplateStringsArray, ...v: unknown[]) => String.raw({ raw: s }, ...v),
}));
vi.mock('./capabilities', () => ({ browserCapabilities: async () => ({}) }));
vi.mock('hls.js', () => {
  class Hls {
    static Events = { ERROR: 'hlsError', FRAG_BUFFERED: 'hlsFragBuffered' };
    static isSupported = () => fakes.hlsSupported;
    handlers = new Map<string, Handler>();
    startLoad = vi.fn();
    recoverMediaError = vi.fn();
    destroyed = false;
    constructor(public config: { startPosition?: number }) {
      fakes.hls.push(this as unknown as FakeHls);
    }
    on(event: string, handler: Handler) {
      this.handlers.set(event, handler);
    }
    fire(event: string, data?: unknown) {
      this.handlers.get(event)?.(event, data);
    }
    loadSource() {}
    attachMedia() {}
    destroy() {
      this.destroyed = true;
    }
  }
  return { default: Hls };
});
// The raw engine: loads go to the attach function, as the real one's do.
vi.mock('../playback/video', () => ({
  videoEngine:
    (
      video: { current: HTMLVideoElement },
      attach: (el: HTMLVideoElement, url: string) => void
    ) =>
    (emit: (event: unknown) => void) => {
      const raw = {
        emit,
        loads: [] as { url: string; startMs: number }[],
        load(file: { url: string; startMs: number }) {
          raw.loads.push(file);
          attach(video.current, file.url);
        },
        close() {},
        setPaused() {},
        setSubtitle() {},
        seek: vi.fn(),
      };
      fakes.raw = raw;
      return raw;
    },
}));

import { guestEngine } from './engine';
import type { GuestApi, GuestCurrent } from './api';
import type { EngineFile } from '../playback/engine';

const media = {
  durationMs: 3_600_000,
  container: 'matroska',
  bitrate: 1,
  tracks: [
    { index: 0, type: 'video', codec: 'h264', title: 'Video' },
    { index: 1, type: 'audio', codec: 'eac3', title: 'English', default: true },
  ],
  chapters: [],
} as unknown as GuestCurrent['media'];
const current = (): GuestCurrent => ({
  revision: 'r',
  playlistItemId: '',
  itemId: 'i',
  title: 'Episode',
  media,
});
let el: {
  currentTime: number;
  error: { code: number; message?: string } | null;
  src: string;
  canPlayType: () => string;
  seekable: { length: number };
};
let prepares: { force?: boolean; positionMs: number }[];
let touch: () => Promise<unknown>;
let mode: string;
function setup(options: Parameters<typeof guestEngine>[4] = {}) {
  const events: { type: string; error?: string; retry?: unknown }[] = [];
  const api = {
    prepare: vi.fn(async (body: { force?: boolean; positionMs: number }) => {
      prepares.push(body);
      return {
        mode,
        url: `/party/guest/media/${mode === 'direct' ? 'original' : 'job/index.m3u8'}?token=t&lease=l`,
        offsetMs: 0,
        lease: 'l'.repeat(43),
      };
    }),
    request: vi.fn(() => touch()),
  } as unknown as GuestApi;
  const engine = guestEngine(
    { current: el as unknown as HTMLVideoElement },
    api,
    current,
    () => {},
    options
  ).factory((e) => events.push(e as (typeof events)[number]), {});
  const failures = () => events.filter((e) => e.type === 'failed');
  return { engine, events, failures, api };
}
const start = async (engine: ReturnType<typeof setup>['engine'], at = 0) => {
  engine.load({ startMs: at, paused: false } as unknown as EngineFile);
  await vi.advanceTimersByTimeAsync(0);
};
const hls = () => fakes.hls.at(-1)!;
const networkError = (code = 404) => ({
  type: 'networkError',
  details: 'fragLoadError',
  fatal: true,
  response: { code },
});
const mediaError = {
  type: 'mediaError',
  details: 'bufferAppendError',
  fatal: true,
};

beforeEach(() => {
  vi.useFakeTimers();
  fakes.hls = [];
  fakes.hlsSupported = true;
  prepares = [];
  touch = async () => ({ ok: true });
  mode = 'audio';
  el = {
    currentTime: 0,
    error: null,
    src: '',
    // What Chrome answers: it claims to play HLS itself.
    canPlayType: () => 'maybe',
    seekable: { length: 0 },
  };
  vi.stubGlobal('window', { location: { href: 'https://aio.example/watch' } });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('which player opens the stream', () => {
  it('uses hls.js in Chrome, starting where playback is', async () => {
    const { engine } = setup();
    await start(engine, 754_000);
    expect(fakes.hls).toHaveLength(1);
    expect(el.src).toBe('');
    // Not hls.js's default of the newest segment, for an unfinished playlist.
    expect(hls().config.startPosition).toBe(754);
  });
  it("uses Safari's own player", async () => {
    vi.stubGlobal('window', {
      location: { href: 'https://aio.example/watch' },
      ManagedMediaSource: class {},
    });
    const { engine } = setup();
    await start(engine);
    expect(fakes.hls).toHaveLength(0);
    expect(el.src).toContain('index.m3u8');
  });
});

describe('a stream that cannot be fetched', () => {
  it('is reloaded, not converted again, and then reported with why', async () => {
    const { engine, failures } = setup();
    await start(engine);
    for (let i = 1; i <= 3; i++) {
      hls().fire('hlsError', networkError());
      await vi.advanceTimersByTimeAsync(2000 * i);
      expect(hls().startLoad).toHaveBeenCalledTimes(i);
    }
    expect(failures()).toHaveLength(0);
    hls().fire('hlsError', networkError());
    expect(prepares).toHaveLength(1);
    expect(failures()).toHaveLength(1);
    expect(failures()[0].error).toContain('fragLoadError, HTTP 404');
    expect(failures()[0].retry).toBeDefined();
  });
  it('gets its reloads back once a fragment plays', async () => {
    const { engine, failures } = setup();
    await start(engine);
    for (let i = 0; i < 6; i++) {
      hls().fire('hlsError', networkError());
      await vi.advanceTimersByTimeAsync(2000);
      hls().fire('hlsFragBuffered');
    }
    expect(hls().startLoad).toHaveBeenCalledTimes(6);
    expect(failures()).toHaveLength(0);
  });
  it('is reported once, however many errors follow', async () => {
    const { engine, failures } = setup();
    await start(engine);
    hls().fire('hlsError', { ...networkError(), type: 'otherError' });
    hls().fire('hlsError', { ...networkError(), type: 'otherError' });
    el.error = { code: 2 };
    fakes.raw!.emit({ type: 'failed', error: 'x' });
    expect(failures()).toHaveLength(1);
  });
  it('ignores errors hls.js recovers from itself', async () => {
    const { engine, failures } = setup();
    await start(engine);
    hls().fire('hlsError', { ...networkError(), fatal: false });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(hls().startLoad).not.toHaveBeenCalled();
    expect(failures()).toHaveLength(0);
  });
});

describe('a stream the browser cannot decode', () => {
  it('is recovered in place, then converted in full, for a guest', async () => {
    const { engine, failures } = setup();
    await start(engine, 30_000);
    el.currentTime = 40;
    hls().fire('hlsError', mediaError);
    hls().fire('hlsError', mediaError);
    expect(hls().recoverMediaError).toHaveBeenCalledTimes(2);
    expect(prepares).toHaveLength(1);
    hls().fire('hlsError', mediaError);
    await vi.advanceTimersByTimeAsync(0);
    expect(prepares).toHaveLength(2);
    expect(prepares[1]).toMatchObject({ force: true, positionMs: 40_000 });
    expect(failures()).toHaveLength(0);
    // Converted in full and still failing: reported, not converted again.
    for (let i = 0; i < 3; i++) hls().fire('hlsError', mediaError);
    expect(prepares).toHaveLength(2);
    expect(failures()).toHaveLength(1);
    expect(failures()[0].error).toContain('bufferAppendError');
  });
  it("is reported, not converted in full, where that's off", async () => {
    const { engine, failures } = setup({
      convertOnDecodeError: false,
      failedMessage: (detail) => detail,
    });
    await start(engine);
    for (let i = 0; i < 3; i++) hls().fire('hlsError', mediaError);
    expect(prepares).toHaveLength(1);
    expect(failures()).toEqual([
      expect.objectContaining({ error: 'bufferAppendError' }),
    ]);
  });
  it('recovers an error the element reports while hls.js plays', async () => {
    const { engine, failures } = setup();
    await start(engine);
    el.error = { code: 3, message: 'PIPELINE_ERROR_DECODE' };
    fakes.raw!.emit({ type: 'failed', error: 'x' });
    expect(hls().recoverMediaError).toHaveBeenCalledTimes(1);
    expect(prepares).toHaveLength(1);
    expect(failures()).toHaveLength(0);
  });
  it('is converted in full when played as the original file and it fails', async () => {
    mode = 'direct';
    const { engine, failures } = setup();
    await start(engine);
    el.error = { code: 4, message: 'DEMUXER_ERROR_NO_SUPPORTED_STREAMS' };
    fakes.raw!.emit({ type: 'failed', error: 'x' });
    await vi.advanceTimersByTimeAsync(0);
    expect(prepares.map((p) => p.force)).toEqual([false, true]);
    expect(failures()).toHaveLength(0);
  });
  it('is not converted in full for a network error on the original file', async () => {
    mode = 'direct';
    const { engine, failures } = setup();
    await start(engine);
    el.error = { code: 2 };
    fakes.raw!.emit({ type: 'failed', error: 'x' });
    expect(prepares).toHaveLength(1);
    expect(failures()[0].error).toContain('MEDIA_ERR_NETWORK');
  });
});

describe('a playback the server dropped', () => {
  it('is not reloaded, and is handed to whoever handles it', async () => {
    const onExpired = vi.fn();
    const { engine, failures } = setup({ onExpired });
    await start(engine);
    hls().fire('hlsError', networkError(410));
    expect(hls().startLoad).not.toHaveBeenCalled();
    expect(onExpired).toHaveBeenCalledTimes(1);
    expect(failures()).toHaveLength(0);
  });
  it('is reported as failed for a guest, without a retry that cannot work', async () => {
    const { engine, failures } = setup();
    await start(engine);
    hls().fire('hlsError', networkError(401));
    expect(failures()).toHaveLength(1);
    expect(failures()[0].retry).toBeUndefined();
  });
});

describe('heartbeats', () => {
  it('a heartbeat that fails on the way does not stop playback', async () => {
    const { engine, failures } = setup();
    await start(engine);
    touch = async () => {
      throw new TypeError('Failed to fetch');
    };
    await vi.advanceTimersByTimeAsync(30_000);
    touch = async () => {
      throw Object.assign(new Error('The server answered 524'), {
        status: 524,
      });
    };
    await vi.advanceTimersByTimeAsync(10_000);
    expect(failures()).toHaveLength(0);
  });
  it('a heartbeat the server refuses as gone ends it, once', async () => {
    const { engine, failures } = setup();
    await start(engine);
    touch = async () => {
      throw Object.assign(new Error('This guest session has expired'), {
        status: 401,
      });
    };
    await vi.advanceTimersByTimeAsync(30_000);
    expect(failures()).toEqual([
      { type: 'failed', error: 'This guest session has expired' },
    ]);
  });
});

describe('preparing', () => {
  it('a playback the server dropped while preparing is handed on', async () => {
    const onExpired = vi.fn();
    const { engine, api, failures } = setup({ onExpired });
    vi.mocked(api.prepare).mockRejectedValueOnce(
      Object.assign(new Error('This playback has expired; start it again'), {
        status: 401,
      })
    );
    await start(engine);
    expect(onExpired).toHaveBeenCalledWith(
      'This playback has expired; start it again'
    );
    expect(failures()).toHaveLength(0);
  });
  it('any other failure is shown with a retry', async () => {
    const { engine, api, failures } = setup();
    vi.mocked(api.prepare).mockRejectedValueOnce(
      Object.assign(new Error('Conversion is unavailable'), { status: 502 })
    );
    await start(engine);
    expect(failures()).toHaveLength(1);
    expect(failures()[0].retry).toBeDefined();
  });
});
