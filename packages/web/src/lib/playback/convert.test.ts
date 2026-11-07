/* eslint-disable lingui/no-unlocalized-strings -- test data, not UI text. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const engines = vi.hoisted(() => ({
  made: [] as FakeEngine[],
  guestOptions: undefined as
    | {
        holdUnwritten?: () => boolean;
        convertOnDecodeError?: boolean;
        onExpired?: (message: string) => void;
      }
    | undefined,
  inParty: false,
}));
interface FakeEngine {
  name: string;
  emit: (event: unknown) => void;
  loads: { subtitles?: unknown; startMs?: number; paused?: boolean }[];
  closes: number;
  seek: ReturnType<typeof vi.fn>;
  ownSubtitles?: boolean;
  load(file: unknown): void;
  close(): void;
}
function fake(name: string, emit: (event: unknown) => void): FakeEngine {
  const engine: FakeEngine = {
    name,
    emit,
    loads: [],
    closes: 0,
    seek: vi.fn(),
    ownSubtitles: name === 'converting' ? true : undefined,
    load(file) {
      engine.loads.push(file as FakeEngine['loads'][number]);
    },
    close() {
      engine.closes++;
    },
  };
  engines.made.push(engine);
  return engine;
}
vi.mock('@lingui/core/macro', () => ({
  t: (s: TemplateStringsArray, ...v: unknown[]) => String.raw({ raw: s }, ...v),
}));
vi.mock('sonner', () => ({ toast: { warning: vi.fn(), message: vi.fn() } }));
vi.mock('../guest/engine', () => ({
  guestEngine: (
    _video: unknown,
    _api: unknown,
    _current: unknown,
    _onMode: unknown,
    options: NonNullable<typeof engines.guestOptions>
  ) => {
    engines.guestOptions = options;
    return {
      factory: (emit: (e: unknown) => void) => fake('converting', emit),
    };
  },
}));
vi.mock('./video', () => ({
  videoEngine: () => (emit: (e: unknown) => void) => fake('direct', emit),
}));
vi.mock('../party/party', () => ({
  party: { state: () => (engines.inParty ? {} : null) },
}));
vi.mock('./server-subtitles', () => ({
  serverSubtitles: vi.fn(() => [{ id: 'server:3', embedded: true }]),
}));

import { toast } from 'sonner';
import { convertingEngine } from './convert';
import type { EngineFile } from './engine';
import type { JellyfinClient } from '../client';

const client = {
  base: 'https://aio.example/jellyfin',
  token: 'user-token',
} as unknown as JellyfinClient;
const file = (item = 'a'.repeat(32), source = 'v1') =>
  ({
    url: 'https://aio.example/direct',
    item: { Id: item, Name: 'Episode' },
    source: { Id: source },
    subtitles: [],
    startMs: 0,
  }) as unknown as EngineFile;
const media = {
  durationMs: 1000,
  container: 'mkv',
  bitrate: 1,
  tracks: [],
  chapters: [],
};
type Answer = { status: number; body?: unknown; text?: string };
let answers: Answer[];
let opens: string[];
function answer(next: Answer) {
  return new Response(next.text ?? JSON.stringify(next.body ?? {}), {
    status: next.status,
  });
}
function engineUnderTest() {
  const events: { type: string }[] = [];
  const engine = convertingEngine({ current: null }, client)(
    (e) => events.push(e as { type: string }),
    {}
  );
  const [converting] = engines.made.slice(-1);
  const direct = () => engines.made.find((e) => e.name === 'direct');
  return { engine, events, converting, direct };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  engines.made = [];
  engines.inParty = false;
  answers = [];
  opens = [];
  vi.mocked(toast.warning).mockClear();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    opens.push(String(input));
    return answer(
      answers.shift() ?? {
        status: 200,
        body: { token: 'own.x', revision: 'r', media },
      }
    );
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('convertingEngine', () => {
  it('converts when the server can, and passes calls to the converting engine', async () => {
    const { engine, converting, direct } = engineUnderTest();
    engine.load(file());
    await settle();
    expect(opens).toEqual(['https://aio.example/party/guest/own/open']);
    expect(converting.loads).toHaveLength(1);
    expect(direct()).toBeUndefined();
    engine.seek(5000);
    expect(converting.seek).toHaveBeenCalledWith(5000);
  });

  it('plays directly when conversion cannot open, with the reason', async () => {
    answers = [
      { status: 502, body: { error: 'Source probe failed: Invalid data' } },
    ];
    const { engine, converting, direct } = engineUnderTest();
    engine.load(file());
    await settle();
    expect(converting.loads).toHaveLength(0);
    expect(direct()!.loads).toHaveLength(1);
    expect(toast.warning).toHaveBeenCalledWith(expect.any(String), {
      description: 'Source probe failed: Invalid data',
    });
    // Calls now go to the engine that is playing.
    engine.seek(1000);
    expect(direct()!.seek).toHaveBeenCalledWith(1000);
    expect(converting.seek).not.toHaveBeenCalled();
  });

  it('gives the direct engine every subtitle, embedded ones included', async () => {
    answers = [{ status: 502, body: { error: 'x' } }];
    const { engine, direct } = engineUnderTest();
    engine.load(file());
    await settle();
    expect(direct()!.loads[0].subtitles).toEqual([
      { id: 'server:3', embedded: true },
    ]);
    expect((engine as unknown as FakeEngine).ownSubtitles).toBeUndefined();
  });

  it('falls back when preparing the stream fails before it plays', async () => {
    const { engine, events, converting, direct } = engineUnderTest();
    engine.load(file());
    await settle();
    converting.emit({
      type: 'failed',
      error: 'Media operation failed (ENOTEMPTY in rmdir)',
    });
    expect(direct()!.loads).toHaveLength(1);
    expect(converting.closes).toBe(1);
    expect(events.some((e) => e.type === 'failed')).toBe(false);
  });

  it('plays directly from the same spot when the stream fails while playing', async () => {
    const { engine, events, converting, direct } = engineUnderTest();
    engine.load(file());
    await settle();
    converting.emit({ type: 'loaded' });
    converting.emit({ type: 'state', state: { paused: false } });
    converting.emit({ type: 'position', positionMs: 754_000 });
    converting.emit({ type: 'failed', error: 'bufferAppendError' });
    expect(direct()!.loads).toEqual([
      expect.objectContaining({ startMs: 754_000, paused: false }),
    ]);
    expect(converting.closes).toBe(1);
    expect(toast.warning).toHaveBeenCalledWith(expect.any(String), {
      description: 'bufferAppendError',
    });
    expect(events.some((e) => e.type === 'failed')).toBe(false);
    // Its calls now go to the direct engine.
    engine.seek(800_000);
    expect(direct()!.seek).toHaveBeenCalledWith(800_000);
  });

  it('never converts the video for its own playback', () => {
    engineUnderTest();
    expect(engines.guestOptions?.convertOnDecodeError).toBe(false);
  });

  it('opens a dropped playback again from where it was, once', async () => {
    const { engine, converting, direct } = engineUnderTest();
    engine.load(file());
    await settle();
    converting.emit({ type: 'loaded' });
    converting.emit({ type: 'position', positionMs: 60_000 });
    engines.guestOptions!.onExpired!('This playback has expired');
    await settle();
    expect(opens).toHaveLength(2);
    expect(converting.loads.map((l) => l.startMs)).toEqual([0, 60_000]);
    expect(direct()).toBeUndefined();
    // Lost again before it loaded: it plays directly instead of looping.
    engines.guestOptions!.onExpired!('This playback has expired');
    await settle();
    expect(opens).toHaveLength(2);
    expect(direct()!.loads).toEqual([
      expect.objectContaining({ startMs: 60_000 }),
    ]);
  });

  it('opens it again after a later loss, once it has played', async () => {
    const { engine, converting, direct } = engineUnderTest();
    engine.load(file());
    await settle();
    engines.guestOptions!.onExpired!('gone');
    await settle();
    converting.emit({ type: 'loaded' });
    engines.guestOptions!.onExpired!('gone');
    await settle();
    expect(opens).toHaveLength(3);
    expect(direct()).toBeUndefined();
  });

  it('remembers a version that had to play directly', async () => {
    answers = [{ status: 502, body: { error: 'x' } }];
    const { engine, direct } = engineUnderTest();
    engine.load(file());
    await settle();
    engine.load(file()); // Resume, Retry, or the same version again
    await settle();
    expect(opens).toHaveLength(1);
    expect(direct()!.loads).toHaveLength(2);
    expect(toast.warning).toHaveBeenCalledTimes(1);
    // Another version is tried again.
    engine.load(file('a'.repeat(32), 'v2'));
    await settle();
    expect(opens).toHaveLength(2);
  });

  it('waits while the file downloads, then converts', async () => {
    vi.useFakeTimers();
    answers = [
      {
        status: 425,
        body: { error: 'The file is still downloading', retryAfter: 10 },
      },
      {
        status: 425,
        body: { error: 'The file is still downloading', retryAfter: 10 },
      },
    ];
    const { engine, events, converting, direct } = engineUnderTest();
    engine.load(file());
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toContainEqual({
      type: 'state',
      state: { waiting: true, loaded: false },
    });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(opens).toHaveLength(3);
    expect(converting.loads).toHaveLength(1);
    expect(direct()).toBeUndefined();
  });

  it('plays directly at once when the server has no transcoder (503, no retry time)', async () => {
    answers = [
      {
        status: 503,
        body: { error: 'Conversion is not set up on this server' },
      },
    ];
    const { engine, direct } = engineUnderTest();
    engine.load(file());
    await settle();
    expect(opens).toHaveLength(1);
    expect(direct()!.loads).toHaveLength(1);
  });

  it("treats a proxy's error page as an answer, not a network blip", async () => {
    answers = [{ status: 524, text: '<html>A timeout occurred</html>' }];
    const { engine, direct } = engineUnderTest();
    engine.load(file());
    await settle();
    expect(opens).toHaveLength(1);
    expect(toast.warning).toHaveBeenCalledWith(expect.any(String), {
      description: 'The server answered 524',
    });
    expect(direct()!.loads).toHaveLength(1);
  });

  it('holds seeks past the converted part only during a party', () => {
    engineUnderTest();
    expect(engines.guestOptions?.holdUnwritten?.()).toBe(false);
    engines.inParty = true;
    expect(engines.guestOptions?.holdUnwritten?.()).toBe(true);
  });
});
