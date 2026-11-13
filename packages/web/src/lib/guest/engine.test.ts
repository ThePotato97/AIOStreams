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
    /** The live window Shaka has from the manifest, in seconds. */
    range = { start: 0, end: 0 };
    seekRange() {
      return this.range;
    }
    /** Shaka's networking engine: its response filters, and its retry event. */
    net = Object.assign(new EventTarget(), { registerResponseFilter() {} });
    getNetworkingEngine() {
      return this.net;
    }
    /** A retry Shaka is about to make after `error`; whether a listener stopped it. */
    retry(error: { code: number; data: unknown[] }) {
      const event = Object.assign(new Event('retry', { cancelable: true }), {
        error,
      });
      this.net.dispatchEvent(event);
      return event.defaultPrevented;
    }
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
          loads: { url: string; startMs: number; paused?: boolean }[];
          setPaused: ReturnType<typeof vi.fn>;
          seek: (ms: number) => void;
          addServerSubtitle: ReturnType<typeof vi.fn>;
          setSubtitle: ReturnType<typeof vi.fn>;
        }
      | undefined,
  };
  return fakes;
});

vi.mock('@lingui/core/macro', () => ({
  t: (s: TemplateStringsArray, ...v: unknown[]) => String.raw({ raw: s }, ...v),
}));
const asked = vi.hoisted(() => ({
  headphones: [] as boolean[],
  /** Capabilities the probe adds. */
  extra: {} as Record<string, unknown>,
}));
vi.mock('./capabilities', () => ({
  browserCapabilities: async (
    _media: unknown,
    _audio: unknown,
    headphones: boolean
  ) => {
    asked.headphones.push(headphones);
    return { subtitles: ['ass', 'pgs'], ...asked.extra };
  },
}));
/** The headphones setting: its listener, called as the setting would be. */
const headphones = vi.hoisted(() => ({
  listener: null as ((on: boolean, mode?: string) => void) | null,
}));
vi.mock('../playback/headphone-setting', () => ({
  watchHeadphones: (listener: (on: boolean, mode: string) => void) => {
    // the headphone mode as mixed unless a test says otherwise
    headphones.listener = (on, mode = 'mixed') => listener(on, mode);
    return () => {
      headphones.listener = null;
    };
  },
}));
const renderers = vi.hoisted(() => ({
  ass: [] as { content: string; fonts: string[]; destroyed: boolean }[],
  pgs: [] as { bytes: number; destroyed: boolean }[],
  fail: false,
}));
/** The SourceBuffer that failed, as media-errors.ts would have recorded it. */
const buffers = vi.hoisted(() => ({
  failed: null as { mimeType: string } | null,
}));
vi.mock('../playback/media-errors', () => ({
  watchBufferErrors: () => {},
  clearBufferError: () => {},
  lastBufferError: () => buffers.failed,
}));
const toasts = vi.hoisted(() => ({ messages: [] as string[] }));
// the track picker reads the user's settings, not the session behind them
vi.mock('../session', () => ({ useSession: () => ({}) }));
vi.mock('sonner', () => ({
  toast: { message: (m: string) => toasts.messages.push(m) },
}));
vi.mock('./subtitle-renderer', () => ({
  renderAss: async (_video: unknown, content: string, fonts: string[]) => {
    if (renderers.fail) throw new Error('WebAssembly failed');
    const drawn = { content, fonts, destroyed: false };
    renderers.ass.push(drawn);
    return { destroy: () => (drawn.destroyed = true) };
  },
  renderPgs: async (_video: unknown, data: ArrayBuffer) => {
    const drawn = { bytes: data.byteLength, destroyed: false };
    renderers.pgs.push(drawn);
    return { destroy: () => (drawn.destroyed = true) };
  },
}));
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
        loads: [] as { url: string; startMs: number; paused?: boolean }[],
        load(file: { url: string; startMs: number; paused?: boolean }) {
          raw.loads.push(file);
          attach(video.current, file.url);
        },
        close() {},
        setPaused: vi.fn(),
        setSubtitle: vi.fn(),
        addServerSubtitle: vi.fn(),
        seek: vi.fn(),
      };
      fakes.raw = raw;
      return raw;
    },
}));

import { guestEngine } from './engine';
import { localAudio } from '../playback/binaural/local-audio';
import type { GuestApi, GuestCurrent } from './api';
import type { EngineFile } from '../playback/engine';

const media = {
  durationMs: 3_600_000,
  container: 'matroska',
  bitrate: 1,
  tracks: [
    { index: 0, type: 'video', codec: 'h264', title: 'Video' },
    {
      index: 1,
      type: 'audio',
      codec: 'eac3',
      title: 'English',
      default: true,
      channels: 6,
    },
    { index: 2, type: 'audio', codec: 'aac', title: 'Commentary', channels: 2 },
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
let prepares: {
  force?: boolean;
  positionMs: number;
  capabilities?: { binaural?: boolean; clientBinaural?: string[] };
}[];
/** What the server answers each prepare with, besides the stream. */
let answer: (body: (typeof prepares)[number]) => Record<string, unknown>;
let touch: () => Promise<unknown>;
/** The spec a server sends, from the flags a test answers with. */
function specOf(flags: Record<string, unknown>, mode: string) {
  return {
    video: {
      track: 0,
      where:
        mode === 'direct'
          ? 'page-original'
          : mode === 'video'
            ? 'server-encode'
            : 'server-copy',
      encode: null,
      picture: flags.dovi ? 'dovi' : 'none',
      reason: null,
    },
    audio: {
      track: 1,
      where:
        mode === 'direct'
          ? 'page-original'
          : flags.binaural
            ? 'server-render'
            : flags.clientBinaural || mode === 'remux'
              ? 'server-copy'
              : 'server-convert',
      pageRenders: !!flags.clientBinaural,
      convert: null,
      render: flags.binaural
        ? { binaural: true, mode: null, codec: 'flac', bitrate: null }
        : null,
      reason: null,
    },
    subtitle: null,
  };
}
let mode: string;
function setup(options: Parameters<typeof guestEngine>[4] = {}) {
  const events: { type: string; error?: string; retry?: unknown }[] = [];
  const api = {
    prepare: vi.fn(async (body: (typeof prepares)[number]) => {
      prepares.push(body);
      const flags = answer(body);
      return {
        ...flags,
        spec: specOf(flags, mode),
        effective: specOf(flags, mode),
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
  answer = () => ({});
  asked.extra = {};
  buffers.failed = null;
  toasts.messages = [];
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
      // nothing here to tell why
      { type: 'state', state: { waiting: true, waitingFor: null } },
      { type: 'state', state: { waiting: false, waitingFor: null } },
    ]);
  });
  it('says why, where the server has not converted that far yet', async () => {
    const { engine, events } = setup();
    await start(engine);
    el.currentTime = 30;
    player().maxSegmentEnd = 31;
    player().dispatchEvent(
      Object.assign(new Event('buffering'), { buffering: true })
    );
    expect(events.at(-1)).toEqual({
      type: 'state',
      state: {
        waiting: true,
        waitingFor:
          "Waiting for the server, which hasn't converted this far yet",
      },
    });
    // and again while it waits, until it plays on
    player().maxSegmentEnd = 90;
    (player() as unknown as { getStats(): object }).getStats = () => ({
      estimatedBandwidth: 2e7,
      streamBandwidth: 8e7,
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(events.at(-1)).toEqual({
      type: 'state',
      state: {
        waiting: true,
        waitingFor:
          'Your connection (20 Mb/s) is slower than this stream (80 Mb/s): try a lower quality',
      },
    });
    player().dispatchEvent(
      Object.assign(new Event('buffering'), { buffering: false })
    );
    const count = events.length;
    await vi.advanceTimersByTimeAsync(4000);
    expect(
      events.slice(count).some((e) => JSON.stringify(e).includes('waitingFor'))
    ).toBe(false);
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
  // The live window follows the clock: 40 s to 78 s, though segments to 148 s are written.
  const live = () => {
    player().range = { start: 40, end: 78 };
    player().maxSegmentEnd = 148;
    // Its stream has loaded (the element's loadedmetadata).
    fakes.raw!.emit({ type: 'loaded' });
  };
  it('prepares again for what is written past the seekable range, which Shaka will not seek to', async () => {
    const { engine } = setup();
    await start(engine, 45_000);
    live();
    engine.seek(125_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(fakes.raw!.seek).not.toHaveBeenCalled();
    expect(prepares).toHaveLength(2);
    expect(prepares.at(-1)?.positionMs).toBe(125_000);
  });
  it('waits at what is written for a spot past it, when its conversion catches up sooner than a new one starts', async () => {
    const { engine } = setup();
    await start(engine, 45_000);
    live();
    // Shaka's edge runs on by the clock; segments are written to 100 s, then 200 s 10 s later (10x).
    player().range = { start: 20, end: 300 };
    player().maxSegmentEnd = 100;
    await vi.advanceTimersByTimeAsync(10_000);
    player().maxSegmentEnd = 200;
    await vi.advanceTimersByTimeAsync(10_000);
    // 30 s past what is written: caught up in about 3 s.
    engine.seek(230_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(fakes.raw!.seek).not.toHaveBeenCalledWith(230_000);
    expect(prepares).toHaveLength(1);
  });
  it('waits at what is written for a spot past it while its conversion’s speed is not yet known', async () => {
    const { engine } = setup();
    await start(engine, 45_000);
    live();
    player().range = { start: 20, end: 300 };
    player().maxSegmentEnd = 100;
    // Just started: no speed measured yet. Party sync asks for a spot 20 s past what is written.
    engine.seek(120_000);
    engine.seek(120_300);
    engine.seek(120_600);
    await vi.advanceTimersByTimeAsync(0);
    expect(prepares).toHaveLength(1);
  });
  it('converts again for a spot past what is written when its conversion only keeps pace', async () => {
    const { engine } = setup();
    await start(engine, 45_000);
    live();
    player().range = { start: 20, end: 300 };
    player().maxSegmentEnd = 100;
    await vi.advanceTimersByTimeAsync(10_000);
    player().maxSegmentEnd = 110;
    await vi.advanceTimersByTimeAsync(10_000);
    engine.seek(140_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(prepares.at(-1)?.positionMs).toBe(140_000);
  });
  it('does not count a conversion waiting on its source as slow: it waits, and measures again after', async () => {
    const { engine } = setup();
    await start(engine, 45_000);
    live();
    player().range = { start: 20, end: 300 };
    player().maxSegmentEnd = 100;
    // The server restarts: nothing is written for a while, and the heartbeat says why.
    touch = async () => ({ ok: true, waitingSource: true });
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    // The party is 20 s past what is written: a speed of 0 would convert again; unknown waits.
    engine.seek(120_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(prepares).toHaveLength(1);
    // The heartbeat not answering at all is the same.
    touch = async () => {
      throw new TypeError('Failed to fetch');
    };
    await vi.advanceTimersByTimeAsync(10_000);
    engine.seek(121_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(prepares).toHaveLength(1);
    // Back, and still not writing: measured again, it keeps no pace, and converts again.
    touch = async () => ({ ok: true, waitingSource: false });
    // The heartbeat that says so, one to start measuring from, and one to measure.
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    engine.seek(140_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(prepares.at(-1)?.positionMs).toBe(140_000);
  });
  it('while its stream still loads, starts where it was put: only a far seek prepares again', async () => {
    const { engine } = setup();
    await start(engine, 45_000);
    engine.seek(48_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(prepares).toHaveLength(1);
    expect(fakes.raw!.seek).not.toHaveBeenCalled();
    engine.seek(120_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(prepares.at(-1)?.positionMs).toBe(120_000);
  });
  it('converts from a spot behind the window, which the server no longer keeps', async () => {
    const { engine } = setup();
    await start(engine, 45_000);
    live();
    engine.seek(10_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(fakes.raw!.seek).not.toHaveBeenCalled();
    expect(prepares.at(-1)?.positionMs).toBe(10_000);
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

describe('a segment the server dropped', () => {
  it('is not fetched again: a 410 is final, other failures are retried', async () => {
    const { engine } = setup();
    await start(engine, 45_000);
    expect(player().retry({ code: 1001, data: ['u/chunk', 410] })).toBe(true);
    expect(player().retry({ code: 1001, data: ['u/chunk', 503] })).toBe(false);
    expect(player().retry({ code: 1002, data: ['u/chunk'] })).toBe(false);
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

describe('the tracks a file opens with', () => {
  const tracks = [
    { index: 0, type: 'video', codec: 'h264', title: 'Video' },
    {
      index: 1,
      type: 'audio',
      codec: 'ac3',
      title: 'ita',
      language: 'ita',
      default: true,
    },
    { index: 2, type: 'audio', codec: 'eac3', title: 'eng', language: 'eng' },
    {
      index: 3,
      type: 'subtitle',
      codec: 'subrip',
      title: 'ita',
      language: 'ita',
    },
    {
      index: 4,
      type: 'subtitle',
      codec: 'subrip',
      title: 'eng',
      language: 'eng',
    },
  ];
  const open = async (prefs: object) => {
    const saved = media.tracks;
    media.tracks = tracks as typeof media.tracks;
    try {
      const { engine } = setup();
      engine.load({
        startMs: 0,
        paused: false,
        prefs,
        source: {},
        subtitles: [],
      } as unknown as EngineFile);
      await vi.advanceTimersByTimeAsync(0);
      return prepares[0];
    } finally {
      media.tracks = saved;
    }
  };
  it("are the user's language, not the file's default track", async () => {
    const first = await open({
      AudioLanguagePreference: 'eng',
      PlayDefaultAudioTrack: false,
      SubtitleLanguagePreference: 'eng',
      SubtitleMode: 'Always',
    });
    expect(first).toMatchObject({ audio: 2, subtitle: 4 });
  });
  it("keep the file's default audio track where the user plays it whatever its language", async () => {
    const first = await open({ AudioLanguagePreference: 'eng' });
    expect(first).toMatchObject({ audio: 1 });
  });
  it("keep the file's default audio track without settings", async () => {
    expect(await open({})).toMatchObject({ audio: 1 });
  });
});

describe('binaural audio rendered in the browser', () => {
  it('is rendered by the server instead, from where it was, when the browser fails at it', async () => {
    asked.extra = { clientBinaural: ['truehd'] };
    answer = (body) => ({
      clientBinaural: !!body.capabilities?.clientBinaural,
    });
    const { engine, failures } = setup();
    await start(engine, 30_000);
    expect(prepares[0].capabilities?.clientBinaural).toEqual(['truehd']);
    el.currentTime = 41;
    // TRANSMUXING_FAILED
    player().fire('error', shakaError(3, 3018));
    await vi.advanceTimersByTimeAsync(0);
    expect(prepares).toHaveLength(2);
    expect(prepares[1]).toMatchObject({ force: false, positionMs: 41_000 });
    expect(prepares[1].capabilities?.clientBinaural).toBeUndefined();
    expect(failures()).toHaveLength(0);
    // and not asked of the browser again for this file
    player().fire('error', shakaError(3, 3018));
    await vi.advanceTimersByTimeAsync(0);
    expect(prepares).toHaveLength(2);
  });
  it('is asked of the browser again for the next file', async () => {
    asked.extra = { clientBinaural: ['truehd'] };
    answer = (body) => ({
      clientBinaural: !!body.capabilities?.clientBinaural,
    });
    const { engine } = setup();
    await start(engine);
    player().fire('error', shakaError(3, 3018));
    await vi.advanceTimersByTimeAsync(0);
    await start(engine);
    expect(prepares.at(-1)!.capabilities?.clientBinaural).toEqual(['truehd']);
  });
  it('is asked of the browser again for another audio track', async () => {
    asked.extra = { clientBinaural: ['truehd'] };
    answer = (body) => ({
      clientBinaural: !!body.capabilities?.clientBinaural,
    });
    const { engine } = setup();
    await start(engine);
    player().fire('error', shakaError(3, 3018));
    await vi.advanceTimersByTimeAsync(0);
    expect(prepares.at(-1)!.capabilities?.clientBinaural).toBeUndefined();
    engine.setAudio!('2');
    await vi.advanceTimersByTimeAsync(0);
    expect(prepares.at(-1)!.capabilities?.clientBinaural).toEqual(['truehd']);
  });
});

describe('binaural audio that fails to play', () => {
  it('is turned off for the file, which plays on from where it was', async () => {
    answer = (body) => ({ binaural: body.capabilities?.binaural !== false });
    asked.extra = { binaural: true, clientBinaural: ['truehd'] };
    const { engine, failures } = setup();
    await start(engine, 30_000);
    expect(prepares[0].capabilities).toMatchObject({ binaural: true });
    el.currentTime = 52;
    buffers.failed = { mimeType: 'audio/mp4; codecs="flac"' };
    player().fire('error', shakaError(3, 3014, { data: [0, null] }));
    await vi.advanceTimersByTimeAsync(0);
    expect(prepares).toHaveLength(2);
    expect(prepares[1]).toMatchObject({ positionMs: 52_000, force: false });
    expect(prepares[1].capabilities).toMatchObject({ binaural: false });
    expect(prepares[1].capabilities?.clientBinaural).toBeUndefined();
    expect(failures()).toHaveLength(0);
    expect(toasts.messages).toHaveLength(1);
    // another audio track has it again, and so does the next file
    engine.setAudio!('2');
    await vi.advanceTimersByTimeAsync(0);
    expect(prepares.at(-1)!.capabilities).toMatchObject({ binaural: true });
    expect(prepares.at(-1)!.capabilities?.clientBinaural).toEqual(['truehd']);
    await start(engine);
    expect(prepares.at(-1)!.capabilities).toMatchObject({ binaural: true });
  });
  it("isn't blamed for the video failing", async () => {
    answer = () => ({ binaural: true });
    asked.extra = { binaural: true };
    const { engine } = setup();
    await start(engine);
    buffers.failed = { mimeType: 'video/mp4; codecs="hvc1.2.4.L153.B0"' };
    player().fire('error', shakaError(3, 3014, { data: [0, null] }));
    await vi.advanceTimersByTimeAsync(0);
    // recovered in place as any media failure is, with binaural audio still asked for
    expect(prepares).toHaveLength(1);
    expect(player().loads).toHaveLength(2);
    expect(toasts.messages).toHaveLength(0);
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
  it('is played as it is again for another audio track, where the audio failed', async () => {
    const { engine } = setup();
    await start(engine, 30_000);
    buffers.failed = { mimeType: 'audio/mp4; codecs="ac-3"' };
    for (let i = 0; i < 3; i++) {
      player().fire('error', shakaError(3, 3014, { data: [0, null] }));
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(prepares.at(-1)).toMatchObject({ force: true });
    engine.setAudio!('2');
    await vi.advanceTimersByTimeAsync(0);
    expect(prepares.at(-1)).toMatchObject({ force: false, audio: 2 });
  });
  it('stays converted in full for another audio track, where the video failed', async () => {
    const { engine } = setup();
    await start(engine, 30_000);
    for (let i = 0; i < 3; i++) player().fire('error', videoError());
    await vi.advanceTimersByTimeAsync(0);
    expect(prepares.at(-1)).toMatchObject({ force: true });
    engine.setAudio!('2');
    await vi.advanceTimersByTimeAsync(0);
    expect(prepares.at(-1)).toMatchObject({ force: true, audio: 2 });
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
      expect.objectContaining({
        error: "Your browser couldn't decode the stream [VIDEO_ERROR]",
      }),
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
  it('starts again once where a segment left the window, then is handed on if still gone', async () => {
    const onExpired = vi.fn();
    const { engine, failures } = setup({ onExpired });
    await start(engine);
    // 410: the window moved on, or the playback is gone. Prepared again here first.
    player().fire('error', notFound(410));
    await vi.advanceTimersByTimeAsync(0);
    expect(prepares).toHaveLength(2);
    expect(onExpired).not.toHaveBeenCalled();
    // Its fresh segments answer 410 too: gone.
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
  it('starts the stream again, from where it was, once the transcoder no longer has it', async () => {
    const { engine, failures } = setup();
    await start(engine, 30_000);
    el.currentTime = 95;
    touch = async () => {
      throw Object.assign(new Error('This stream ended on the server'), {
        status: 409,
        code: 'stream_gone',
      });
    };
    await vi.advanceTimersByTimeAsync(10_000);
    expect(prepares).toHaveLength(2);
    expect(prepares[1]).toMatchObject({ positionMs: 95_000 });
    expect(failures()).toHaveLength(0);
  });
});

describe('a prepare the server turned down as stale', () => {
  const conflict = (code: string) =>
    Object.assign(new Error('stale'), { status: 409, code });
  it('asks again where another request of this guest won, without failing', async () => {
    const { engine, api, failures } = setup();
    vi.mocked(api.prepare).mockRejectedValueOnce(conflict('superseded'));
    await start(engine);
    await vi.advanceTimersByTimeAsync(0);
    expect(api.prepare).toHaveBeenCalledTimes(2);
    expect(failures()).toHaveLength(0);
  });
  it('gives up asking again after twice', async () => {
    const { engine, api, failures } = setup();
    vi.mocked(api.prepare).mockRejectedValue(conflict('superseded'));
    await start(engine);
    await vi.advanceTimersByTimeAsync(0);
    expect(api.prepare).toHaveBeenCalledTimes(3);
    expect(failures()).toHaveLength(1);
  });
  it('waits for the title the host moved to, without failing', async () => {
    const { engine, api, events, failures } = setup();
    vi.mocked(api.prepare).mockRejectedValueOnce(conflict('title_changed'));
    await start(engine);
    expect(api.prepare).toHaveBeenCalledTimes(1);
    expect(failures()).toHaveLength(0);
    expect(events.at(-1)).toEqual({
      type: 'state',
      state: { waiting: true, waitingFor: 'Loading what the host is playing…' },
    });
  });
});

describe('a conversion starting on the server', () => {
  /** Admitted at once, still opening: the page follows its state. */
  const starting = (api: GuestApi, states: object[]) => {
    const prepare = vi.mocked(api.prepare).getMockImplementation()!;
    vi.mocked(api.prepare).mockImplementationOnce(async (body) => ({
      ...(await prepare(body)),
      ready: false,
      stage: 'opening',
      version: 0,
    }));
    const state = vi.fn(async () => states.shift());
    (api as unknown as { state: typeof state }).state = state;
    return state;
  };
  it('is followed, its stage shown, and played once ready', async () => {
    const { engine, api, events, failures } = setup();
    const state = starting(api, [
      { version: 1, stage: 'rendering', ready: false },
      { version: 2, stage: 'ready', ready: true, failure: null },
    ]);
    await start(engine);
    expect(state).toHaveBeenCalledTimes(2);
    // Asked from what it last saw, each time.
    expect(state.mock.calls.map((c) => (c as unknown[])[1])).toEqual([0, 1]);
    expect(events).toContainEqual({
      type: 'state',
      state: { waiting: true, waitingFor: 'Rendering binaural audio…' },
    });
    expect(player().loads).toHaveLength(1);
    expect(failures()).toHaveLength(0);
  });
  it('fails with what failed, as the source', async () => {
    const { engine, api, failures } = setup();
    starting(api, [
      {
        version: 1,
        stage: 'failed',
        ready: false,
        failure: {
          class: 'source',
          status: 502,
          code: 'source_failed',
          reason: 'The download failed',
        },
      },
    ]);
    await start(engine);
    expect(fakes.players.at(-1)?.loads ?? []).toHaveLength(0);
    expect(failures()).toHaveLength(1);
    expect(failures()[0].error).toContain('The download failed');
  });
  it('starts where the party will be once it plays, from how long this source took to play', async () => {
    let playing = false;
    const { engine, api } = setup({ partyPlaying: () => playing });
    starting(api, [{ version: 1, stage: 'ready', ready: true, failure: null }]);
    const first = start(engine, 10_000);
    await vi.advanceTimersByTimeAsync(0);
    await first;
    expect(prepares.at(-1)?.positionMs).toBe(10_000);
    // While the party plays: a prepare, then the player plays 6 s after it was asked for.
    playing = true;
    vi.setSystemTime(Date.now());
    const asked = Date.now();
    starting(api, [{ version: 1, stage: 'ready', ready: true, failure: null }]);
    engine.seek(200_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(prepares.at(-1)?.positionMs).toBe(200_000);
    vi.setSystemTime(asked + 6000);
    fakes.raw!.emit({
      type: 'state',
      state: { paused: false, waiting: false },
    });
    // The next prepare the party plays through starts that far ahead (and is still starting).
    starting(api, []);
    (api as unknown as { state: () => Promise<never> }).state = () =>
      new Promise<never>(() => {});
    engine.seek(400_000);
    await vi.advanceTimersByTimeAsync(0);
    const lead = (prepares.at(-1)?.positionMs ?? 0) - 400_000;
    expect(lead).toBeGreaterThanOrEqual(5000);
    expect(lead).toBeLessThanOrEqual(7000);
    // Party sync asking again while it prepares, a little further on, doesn't prepare again.
    const count = prepares.length;
    // (Within 8 s of where it was asked, though more than 8 s short of where it was put.)
    engine.seek(397_000);
    engine.seek(396_500);
    await vi.advanceTimersByTimeAsync(0);
    expect(prepares).toHaveLength(count);
  });
  it('waits, paused where it was put, until the party gets there', async () => {
    let playing = false;
    const { engine, api } = setup({ partyPlaying: () => playing });
    starting(api, [{ version: 1, stage: 'ready', ready: true, failure: null }]);
    const first = start(engine, 10_000);
    await vi.advanceTimersByTimeAsync(0);
    await first;
    playing = true;
    vi.setSystemTime(Date.now());
    const asked = Date.now();
    starting(api, [{ version: 1, stage: 'ready', ready: true, failure: null }]);
    engine.seek(200_000);
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(asked + 6000);
    fakes.raw!.emit({ type: 'state', state: { waiting: false } });
    // Put 6 s ahead, ready at once: it loads paused, and a resume meanwhile waits.
    starting(api, [{ version: 1, stage: 'ready', ready: true, failure: null }]);
    engine.seek(400_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(fakes.raw!.loads.at(-1)?.paused).toBe(true);
    fakes.raw!.setPaused.mockClear();
    engine.setPaused(false);
    expect(fakes.raw!.setPaused).not.toHaveBeenCalledWith(false);
    await vi.advanceTimersByTimeAsync(6500);
    expect(fakes.raw!.setPaused).toHaveBeenCalledWith(false);
  });
  /**
   * A guest that learned its source takes about 20 s from asking to playable, while the party
   * plays (learned three times over: leads are kept per title, across engines).
   */
  async function withLead(
    api: GuestApi,
    engine: ReturnType<typeof setup>['engine']
  ): Promise<void> {
    starting(api, [{ version: 1, stage: 'ready', ready: true, failure: null }]);
    const first = start(engine, 10_000);
    await vi.advanceTimersByTimeAsync(0);
    await first;
    for (let i = 0; i < 3; i++) {
      vi.setSystemTime(Date.now());
      const asked = Date.now();
      starting(api, [
        { version: 1, stage: 'ready', ready: true, failure: null },
      ]);
      engine.seek(200_000 + i * 100_000);
      await vi.advanceTimersByTimeAsync(0);
      vi.setSystemTime(asked + 20_000);
      fakes.raw!.emit({ type: 'state', state: { waiting: false } });
    }
  }
  it('with a long lead, a seek to where the party is now, while it prepares, keeps the projection', async () => {
    const { engine, api } = setup({ partyPlaying: () => true });
    await withLead(api, engine);
    let answer!: (state: object) => void;
    starting(api, []);
    (api as unknown as { state: () => Promise<object> }).state = () =>
      new Promise((resolve) => (answer = resolve));
    const asked = Date.now();
    engine.seek(1_000_000);
    await vi.advanceTimersByTimeAsync(0);
    const count = prepares.length;
    const lead = (prepares.at(-1)?.positionMs ?? 0) - 1_000_000;
    expect(lead).toBeGreaterThan(15_000);
    // 12 s on, party sync asks for where the party is.
    vi.setSystemTime(asked + 12_000);
    engine.seek(1_012_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(prepares).toHaveLength(count);
    answer({ version: 1, stage: 'ready', ready: true, failure: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(fakes.raw!.loads.at(-1)?.startMs).toBe(1_000_000 + lead);
  });
  it('with a long lead, a seek to where the party is now leaves the stream waiting for it', async () => {
    const { engine, api } = setup({ partyPlaying: () => true });
    await withLead(api, engine);
    starting(api, [{ version: 1, stage: 'ready', ready: true, failure: null }]);
    const asked = Date.now();
    engine.seek(1_000_000);
    await vi.advanceTimersByTimeAsync(0);
    const count = prepares.length;
    expect(prepares.at(-1)!.positionMs - 1_000_000).toBeGreaterThan(15_000);
    vi.setSystemTime(asked + 12_000);
    const seeks = (fakes.raw!.seek as unknown as ReturnType<typeof vi.fn>).mock
      .calls.length;
    engine.seek(1_012_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(prepares).toHaveLength(count);
    expect(
      (fakes.raw!.seek as unknown as ReturnType<typeof vi.fn>).mock.calls.length
    ).toBe(seeks);
  });
  it('with a long lead, a stream that has yet to load starts where it was put', async () => {
    const { engine, api } = setup({ partyPlaying: () => true });
    await withLead(api, engine);
    starting(api, [{ version: 1, stage: 'ready', ready: true, failure: null }]);
    const asked = Date.now();
    engine.seek(1_000_000);
    await vi.advanceTimersByTimeAsync(0);
    const count = prepares.length;
    const lead = prepares.at(-1)!.positionMs - 1_000_000;
    expect(lead).toBeGreaterThan(15_000);
    // The party is there: the hold is over, and the stream hasn't loaded yet.
    vi.setSystemTime(asked + lead + 1000);
    await vi.advanceTimersByTimeAsync(0);
    engine.seek(1_000_000 + lead + 1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(prepares).toHaveLength(count);
  });
  it('learns nothing from a prepare while the party is paused', async () => {
    const { engine, api } = setup({ partyPlaying: () => false });
    starting(api, [{ version: 1, stage: 'ready', ready: true, failure: null }]);
    const first = start(engine, 10_000);
    await vi.advanceTimersByTimeAsync(0);
    await first;
    vi.setSystemTime(Date.now() + 20_000);
    fakes.raw!.emit({
      type: 'state',
      state: { paused: false, waiting: false },
    });
    engine.seek(400_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(prepares.at(-1)?.positionMs).toBe(400_000);
  });
});

describe('a full transcoder', () => {
  const full = (retryAfter?: number) =>
    Object.assign(new Error('Conversion capacity reached'), {
      status: 503,
      retryAfter,
    });
  it('is reported at once, with a retry, rather than waited for', async () => {
    const { engine, api, failures } = setup();
    vi.mocked(api.prepare).mockRejectedValueOnce(full(10));
    await start(engine);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(api.prepare).toHaveBeenCalledTimes(1);
    expect(failures()).toHaveLength(1);
    expect(failures()[0].retry).toBeTruthy();
  });
  it('is reported at once when it gives no time to come back', async () => {
    const { engine, api, failures } = setup();
    vi.mocked(api.prepare).mockRejectedValueOnce(full(undefined));
    await start(engine);
    expect(failures()).toHaveLength(1);
  });
});

describe('a subtitle still being extracted', () => {
  it('is added once ready, while the stream plays', async () => {
    const answers = [
      new Response('{}', { status: 425, headers: { 'Retry-After': '5' } }),
      new Response('WEBVTT\n\n00:01.000 --> 00:02.000\nHi', { status: 200 }),
    ];
    const fetches = vi.fn(async () => answers.shift()!);
    vi.stubGlobal('fetch', fetches);
    vi.stubGlobal(
      'URL',
      Object.assign(URL, { createObjectURL: () => 'blob:vtt' })
    );
    const { engine, api } = setup();
    await start(engine);
    vi.mocked(api.prepare).mockResolvedValueOnce({
      mode: 'audio',
      spec: specOf({}, 'audio'),
      effective: specOf({}, 'audio'),
      url: '/party/guest/media/job/manifest.mpd?token=t&lease=l',
      subtitleUrl: '/party/guest/subtitle/3?token=t&lease=l',
      offsetMs: 0,
      lease: 'l'.repeat(43),
    } as never);
    engine.setSubtitle('3');
    await vi.advanceTimersByTimeAsync(0);
    // The stream started without waiting for it.
    expect(fakes.raw!.loads.at(-1)).toMatchObject({ subtitles: [] });
    expect(fakes.raw!.addServerSubtitle).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetches).toHaveBeenCalledTimes(2);
    expect(fakes.raw!.addServerSubtitle).toHaveBeenCalledWith(
      expect.objectContaining({ id: '3', url: 'blob:vtt' })
    );
    expect(fakes.raw!.setSubtitle).toHaveBeenLastCalledWith('3');
  });
});

describe('ASS and PGS drawn in the browser', () => {
  const answered = (body: string | ArrayBuffer) =>
    vi.fn(async () => new Response(body, { status: 200 }));
  const playWith = async (extra: object) => {
    const { engine, api } = setup();
    await start(engine);
    vi.mocked(api.prepare).mockResolvedValue({
      mode: 'direct',
      spec: specOf({}, 'direct'),
      effective: specOf({}, 'direct'),
      url: '/party/guest/media/original?token=t&lease=l',
      offsetMs: 0,
      lease: 'l'.repeat(43),
      subtitleUrl: '/party/guest/subtitle/3?token=t&lease=l&format=ass',
      ...extra,
    } as never);
    engine.setSubtitle('3');
    await vi.advanceTimersByTimeAsync(0);
    return { engine, api };
  };
  beforeEach(() => {
    renderers.ass = [];
    renderers.pgs = [];
    renderers.fail = false;
  });
  it('asks for them drawn, not burned in', async () => {
    const { engine } = setup();
    await start(engine);
    expect(prepares.at(-1)).toMatchObject({
      capabilities: { subtitles: ['ass', 'pgs'] },
    });
  });
  it('draws ASS with the fonts the file carries', async () => {
    vi.stubGlobal('fetch', answered('[Script Info]\nTitle: x'));
    await playWith({
      subtitleFormat: 'ass',
      fontUrls: ['/party/guest/font/5?token=t&lease=l'],
    });
    expect(renderers.ass).toEqual([
      {
        content: '[Script Info]\nTitle: x',
        fonts: ['https://aio.example/party/guest/font/5?token=t&lease=l'],
        destroyed: false,
      },
    ]);
  });
  it('draws PGS from its bytes', async () => {
    vi.stubGlobal('fetch', answered(new Uint8Array([0x50, 0x47, 1, 2]).buffer));
    await playWith({
      subtitleFormat: 'sup',
      subtitleUrl: '/party/guest/subtitle/3?token=t&lease=l&format=sup',
    });
    expect(renderers.pgs).toEqual([{ bytes: 4, destroyed: false }]);
  });
  it('stops drawing when the stream is replaced or closed', async () => {
    vi.stubGlobal('fetch', answered('[Script Info]'));
    const { engine } = await playWith({ subtitleFormat: 'ass' });
    expect(renderers.ass[0].destroyed).toBe(false);
    // Another subtitle prepares the stream again.
    engine.setSubtitle(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(renderers.ass[0].destroyed).toBe(true);
    engine.close();
    expect(renderers.ass.every((r) => r.destroyed)).toBe(true);
  });
  it('has the track burned in when its renderer fails', async () => {
    renderers.fail = true;
    vi.stubGlobal('fetch', answered('[Script Info]'));
    const { api } = await playWith({ subtitleFormat: 'ass' });
    await vi.advanceTimersByTimeAsync(0);
    // Asked again, now without ASS among what's drawn here, and only once.
    const calls = vi.mocked(api.prepare).mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls.at(-1)![0]).toMatchObject({
      subtitle: 3,
      capabilities: { subtitles: ['pgs'] },
    });
  });
});

describe('closing', () => {
  it('releases the playback, and sends nothing when there was none', async () => {
    const { engine, api } = setup();
    engine.close();
    expect(api.request).not.toHaveBeenCalled();
    await start(engine);
    engine.close();
    expect(api.request).toHaveBeenCalledWith(
      '/touch',
      expect.objectContaining({ release: true, lease: 'l'.repeat(43) })
    );
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

describe('headphones', () => {
  beforeEach(() => {
    asked.headphones = [];
  });
  it('prepares again with surround when headphones turn on, and off', async () => {
    const { engine } = setup();
    await start(engine, 60_000);
    expect(asked.headphones).toEqual([false]);
    // Also how a setting read only after the first prepare arrives.
    headphones.listener!(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(asked.headphones).toEqual([false, true]);
    // The same value again changes nothing.
    headphones.listener!(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(prepares).toHaveLength(2);
    headphones.listener!(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(asked.headphones).toEqual([false, true, false]);
    expect(prepares).toHaveLength(3);
  });
  it('sends only the newest prepare when the setting is read while the first asks the browser', async () => {
    const { engine, api } = setup();
    // As a file opens: the setting loads while the first prepare is still asking the browser.
    engine.load({ startMs: 0, paused: false } as unknown as EngineFile);
    headphones.listener!(true);
    await vi.advanceTimersByTimeAsync(0);
    // Sent after the newer one, the first would reach the server last and replace it.
    expect(asked.headphones).toEqual([false, true]);
    expect(prepares).toHaveLength(1);
    const [, signal] = vi.mocked(api.prepare).mock.calls[0];
    expect(signal?.aborted).toBe(false);
  });
  it('leaves stereo, and audio that is not converted, alone', async () => {
    const { engine } = setup();
    await start(engine);
    engine.setAudio!('2');
    await vi.advanceTimersByTimeAsync(0);
    const before = prepares.length;
    headphones.listener!(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(prepares).toHaveLength(before);
    mode = 'remux';
    const remux = setup();
    await start(remux.engine);
    const remuxed = prepares.length;
    headphones.listener!(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(prepares).toHaveLength(remuxed);
  });
  it('stops listening when closed', async () => {
    const { engine } = setup();
    await start(engine);
    engine.close();
    expect(headphones.listener).toBeNull();
  });

  describe('with the track converted in the page', () => {
    const BOTH = { modes: 0, layout: 'stereo', contents: 'both' } as const;
    const ONE = { modes: 0, layout: '7.1', contents: 'speakers' } as const;
    beforeEach(() => {
      asked.extra = { clientBinaural: ['truehd'] };
      answer = (body) => ({
        clientBinaural: !!body.capabilities?.clientBinaural,
      });
    });
    afterEach(() => {
      localAudio.stopped(localAudio.current!);
    });

    it('switches between the outputs it carries without asking the server', async () => {
      const { engine } = setup();
      await start(engine, 60_000);
      // the transmuxer converting with both outputs
      localAudio.started(BOTH);
      const before = prepares.length;
      headphones.listener!(true);
      await vi.advanceTimersByTimeAsync(0);
      headphones.listener!(false);
      await vi.advanceTimersByTimeAsync(0);
      expect(prepares).toHaveLength(before);
      // what the conversion was asked for: this track's channels, the mode
      expect(localAudio.request).toMatchObject({
        mode: 'mixed',
        trackChannels: 6,
      });
    });

    it('converts again for a new mode, once headphones are on', async () => {
      const { engine } = setup();
      await start(engine, 60_000);
      localAudio.started(BOTH);
      const before = prepares.length;
      // headphones off: the binaural pair isn't heard, so nothing yet
      headphones.listener!(false, 'far');
      await vi.advanceTimersByTimeAsync(0);
      expect(prepares).toHaveLength(before);
      // on: converted again in the new mode, from where it was
      headphones.listener!(true, 'far');
      await vi.advanceTimersByTimeAsync(0);
      expect(prepares).toHaveLength(before + 1);
      expect(localAudio.request).toMatchObject({
        mode: 'far',
        headphones: true,
      });
    });

    it('converts again where the stream carries only one output', async () => {
      const { engine } = setup();
      await start(engine, 60_000);
      localAudio.started(ONE);
      const before = prepares.length;
      headphones.listener!(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(prepares).toHaveLength(before + 1);
    });
  });
});
