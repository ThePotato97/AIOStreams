/* eslint-disable lingui/no-unlocalized-strings -- test data, not UI text. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fakes = vi.hoisted(() => {
  /** Shaka Player, as far as the engine uses it. */
  class FakePlayer extends EventTarget {
    config: Record<string, unknown> = {};
    attached: unknown = null;
    loads: [string, number | null | undefined][] = [];
    destroyed = false;
    retryStreaming = vi.fn(() => fakes.retryWorks);
    /** Where the manifest's last segment ends. */
    maxSegmentEnd: number | null = null;
    getManifest() {
      return {
        presentationTimeline: {
          getMaxSegmentEndTime: () => this.maxSegmentEnd,
        },
      };
    }
    constructor() {
      super();
      fakes.players.push(this);
    }
    configure(config: Record<string, unknown>) {
      this.config = config;
      return true;
    }
    async attach(video: unknown) {
      this.attached = video;
    }
    load(url: string, start?: number | null) {
      this.loads.push([url, start]);
      return fakes.loadResult();
    }
    async destroy() {
      this.destroyed = true;
    }
    fire(type: string, detail?: unknown) {
      this.dispatchEvent(new CustomEvent(type, { detail }));
    }
  }
  const fakes = {
    players: [] as FakePlayer[],
    supported: true,
    retryWorks: true,
    loadResult: (): Promise<void> => Promise.resolve(),
    FakePlayer,
    raw: undefined as
      | {
          emit: (event: unknown) => void;
          loads: { url: string; startMs: number }[];
          seek: (ms: number) => void;
        }
      | undefined,
  };
  return fakes;
});

vi.mock('@lingui/core/macro', () => ({
  t: (s: TemplateStringsArray, ...v: unknown[]) => String.raw({ raw: s }, ...v),
}));
vi.mock('./capabilities', () => ({ browserCapabilities: async () => ({}) }));
vi.mock('shaka-player', () => ({
  default: {
    Player: Object.assign(fakes.FakePlayer, {
      isBrowserSupported: () => fakes.supported,
    }),
    polyfill: { installAll() {} },
  },
}));
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
  seekable: {
    length: number;
    start?: (i: number) => number;
    end?: (i: number) => number;
  };
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
        url: `/party/guest/media/${mode === 'direct' ? 'original' : 'job/manifest.mpd'}?token=t&lease=l`,
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
const player = () => fakes.players.at(-1)!;
/** A Shaka error, critical unless said otherwise. */
const shakaError = (category: number, code: number, extra = {}) => ({
  category,
  code,
  severity: 2,
  data: [],
  ...extra,
});
const notFound = (status = 404) =>
  shakaError(1, 1001, {
    data: ['https://aio.example/chunk-0-00069.m4s', status],
  });
const videoError = () => shakaError(3, 3016);

beforeEach(() => {
  vi.useFakeTimers();
  fakes.players = [];
  fakes.supported = true;
  fakes.retryWorks = true;
  fakes.loadResult = () => Promise.resolve();
  prepares = [];
  touch = async () => ({ ok: true });
  mode = 'audio';
  el = { currentTime: 0, error: null, src: '', seekable: { length: 0 } };
  vi.stubGlobal('window', { location: { href: 'https://aio.example/watch' } });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('which player opens the stream', () => {
  it('plays a converted stream with Shaka, from where playback is', async () => {
    const { engine } = setup();
    await start(engine, 754_300);
    expect(fakes.players).toHaveLength(1);
    expect(player().attached).toBe(el);
    // The manifest keeps the source's timestamps: the position is absolute.
    expect(player().loads).toEqual([
      [
        'https://aio.example/party/guest/media/job/manifest.mpd?token=t&lease=l',
        754.3,
      ],
    ]);
    expect(el.src).toBe('');
  });
  it("ignores the manifest's live delay and minimum buffer", async () => {
    const { engine } = setup();
    await start(engine);
    expect(player().config).toMatchObject({
      manifest: {
        defaultPresentationDelay: 0,
        dash: {
          ignoreMinBufferTime: true,
          ignoreSuggestedPresentationDelay: true,
        },
      },
    });
  });
  it('plays the original file as it is', async () => {
    mode = 'direct';
    const { engine } = setup();
    await start(engine);
    expect(fakes.players).toHaveLength(0);
    expect(el.src).toContain('/media/original');
  });
  it('says so where the browser has no Media Source', async () => {
    fakes.supported = false;
    const { engine, failures } = setup();
    await start(engine);
    expect(failures()).toEqual([
      { type: 'failed', error: 'This browser cannot play converted streams' },
    ]);
  });
  it('replaces the player for each new stream, and closes it', async () => {
    const { engine } = setup();
    await start(engine);
    const first = player();
    engine.seek(3_000_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(first.destroyed).toBe(true);
    expect(fakes.players).toHaveLength(2);
    engine.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(player().destroyed).toBe(true);
  });
});

describe('buffering', () => {
  it("keeps Shaka's buffering rate of 0 out of the viewer's speed", async () => {
    const { engine, events } = setup();
    await start(engine);
    const before = events.length;
    fakes.raw!.emit({ type: 'state', state: { rate: 0 } });
    fakes.raw!.emit({ type: 'state', state: { rate: 1.5 } });
    const rates = events
      .slice(before)
      .map((e) => (e as { state?: { rate?: number } }).state?.rate);
    expect(rates).toEqual([undefined, 1.5]);
  });
  it('shows Shaka buffering as waiting', async () => {
    const { engine, events } = setup();
    await start(engine);
    const buffering = (on: boolean) =>
      player().dispatchEvent(
        Object.assign(new Event('buffering'), { buffering: on })
      );
    buffering(true);
    buffering(false);
    expect(events.slice(-2)).toEqual([
      { type: 'state', state: { waiting: true } },
      { type: 'state', state: { waiting: false } },
    ]);
  });
  it('passes a rate of 0 on for the original file', async () => {
    mode = 'direct';
    const { engine, events } = setup();
    await start(engine);
    fakes.raw!.emit({ type: 'state', state: { rate: 0 } });
    expect(events.at(-1)).toEqual({ type: 'state', state: { rate: 0 } });
  });
});

describe('seeking in a converted stream', () => {
  // The live manifest's seekable range follows the clock: 40 s to 78 s,
  // though segments to 148 s are written.
  const live = () => {
    el.seekable = { length: 1, start: () => 40, end: () => 78 };
    player().maxSegmentEnd = 148;
  };
  it('seeks in place to what the manifest lists, past the seekable range', async () => {
    const { engine } = setup();
    await start(engine, 45_000);
    live();
    engine.seek(125_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(fakes.raw!.seek).toHaveBeenCalledWith(125_000);
    expect(prepares).toHaveLength(1);
  });
  it('converts from a spot past what the manifest lists', async () => {
    const { engine } = setup();
    await start(engine, 45_000);
    live();
    engine.seek(900_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(fakes.raw!.seek).not.toHaveBeenCalled();
    expect(prepares.at(-1)?.positionMs).toBe(900_000);
  });
});

describe('a stream that cannot be fetched', () => {
  it('is fetched again, not converted again, and then reported with why', async () => {
    const { engine, failures } = setup();
    await start(engine);
    for (let i = 1; i <= 3; i++) {
      player().fire('error', notFound());
      await vi.advanceTimersByTimeAsync(2000 * i);
      expect(player().retryStreaming).toHaveBeenCalledTimes(i);
    }
    expect(failures()).toHaveLength(0);
    player().fire('error', notFound());
    expect(prepares).toHaveLength(1);
    expect(failures()).toHaveLength(1);
    expect(failures()[0].error).toContain('BAD_HTTP_STATUS, HTTP 404');
    expect(failures()[0].retry).toBeDefined();
  });
  it('is loaded again where it was when streaming cannot resume', async () => {
    fakes.retryWorks = false;
    const { engine } = setup();
    await start(engine, 30_000);
    el.currentTime = 41.5;
    player().fire('error', shakaError(1, 1003));
    await vi.advanceTimersByTimeAsync(2000);
    expect(player().loads.at(-1)?.[1]).toBe(41.5);
  });
  it('gets its retries back once the stream plays on', async () => {
    const { engine, failures } = setup();
    await start(engine);
    for (let i = 0; i < 6; i++) {
      player().fire('error', notFound());
      await vi.advanceTimersByTimeAsync(2000);
      player().fire('segmentappended');
    }
    expect(player().retryStreaming).toHaveBeenCalledTimes(6);
    expect(failures()).toHaveLength(0);
  });
  it('is reported once, however many errors follow', async () => {
    const { engine, failures } = setup();
    await start(engine);
    player().fire('error', shakaError(5, 5999));
    player().fire('error', shakaError(5, 5999));
    expect(failures()).toHaveLength(1);
  });
  it('ignores errors Shaka recovers from itself', async () => {
    const { engine, failures } = setup();
    await start(engine);
    player().fire('error', { ...notFound(), severity: 1 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(player().retryStreaming).not.toHaveBeenCalled();
    expect(failures()).toHaveLength(0);
  });
  it('counts an error once when the load reports it too', async () => {
    const error = shakaError(1, 1002);
    fakes.loadResult = () => Promise.reject(error);
    const { engine } = setup();
    await start(engine);
    player().fire('error', error);
    await vi.advanceTimersByTimeAsync(2000);
    expect(player().retryStreaming).toHaveBeenCalledTimes(1);
  });
  it('ignores a load cut short by the next one', async () => {
    fakes.loadResult = () => Promise.reject(shakaError(7, 7000));
    const { engine, failures } = setup();
    await start(engine);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(failures()).toHaveLength(0);
    expect(player().retryStreaming).not.toHaveBeenCalled();
  });
});

describe('a stream the browser cannot decode', () => {
  it('is reloaded in place, then converted in full, for a guest', async () => {
    const { engine, failures } = setup();
    await start(engine, 30_000);
    el.currentTime = 40;
    player().fire('error', videoError());
    player().fire('error', videoError());
    // Reloaded at the same spot, twice.
    expect(
      player()
        .loads.slice(1)
        .map(([, at]) => at)
    ).toEqual([40, 40]);
    expect(prepares).toHaveLength(1);
    player().fire('error', videoError());
    await vi.advanceTimersByTimeAsync(0);
    expect(prepares).toHaveLength(2);
    expect(prepares[1]).toMatchObject({ force: true, positionMs: 40_000 });
    expect(failures()).toHaveLength(0);
    // Converted in full and still failing: reported, not converted again.
    for (let i = 0; i < 3; i++) player().fire('error', videoError());
    expect(prepares).toHaveLength(2);
    expect(failures()).toHaveLength(1);
    expect(failures()[0].error).toContain('VIDEO_ERROR');
  });
  it('is converted in full when the browser has no decoder for its video', async () => {
    // Shaka refuses the manifest outright: no stream it can play.
    fakes.loadResult = () => Promise.reject(shakaError(4, 4032));
    const { engine } = setup();
    await start(engine);
    await vi.advanceTimersByTimeAsync(0);
    expect(prepares.map((p) => p.force)).toEqual([false, true]);
  });
  it("is reported, not converted in full, where that's off", async () => {
    const { engine, failures } = setup({
      convertOnDecodeError: false,
      failedMessage: (detail) => detail,
    });
    await start(engine);
    for (let i = 0; i < 3; i++) player().fire('error', videoError());
    expect(prepares).toHaveLength(1);
    expect(failures()).toEqual([
      expect.objectContaining({ error: 'VIDEO_ERROR' }),
    ]);
  });
  it("leaves the element's own errors to Shaka while it plays", async () => {
    const { engine, failures } = setup();
    await start(engine);
    el.error = { code: 3, message: 'PIPELINE_ERROR_DECODE' };
    fakes.raw!.emit({ type: 'failed', error: 'x' });
    await vi.advanceTimersByTimeAsync(0);
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
  it('is not fetched again, and is handed to whoever handles it', async () => {
    const onExpired = vi.fn();
    const { engine, failures } = setup({ onExpired });
    await start(engine);
    player().fire('error', notFound(410));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(player().retryStreaming).not.toHaveBeenCalled();
    expect(onExpired).toHaveBeenCalledTimes(1);
    expect(failures()).toHaveLength(0);
  });
  it('is reported as failed for a guest, without a retry that cannot work', async () => {
    const { engine, failures } = setup();
    await start(engine);
    player().fire('error', notFound(401));
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
