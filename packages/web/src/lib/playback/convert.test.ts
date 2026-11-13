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
const partyMock = vi.hoisted(() => ({
  state: null as null | Record<string, unknown>,
  listeners: new Set<() => void>(),
  events: new Set<(event: unknown) => void>(),
}));
vi.mock('../party/party', () => ({
  party: {
    state: () => partyMock.state ?? (engines.inParty ? {} : null),
    subscribe: (listener: () => void) => {
      partyMock.listeners.add(listener);
      return () => partyMock.listeners.delete(listener);
    },
    on: (listener: (event: unknown) => void) => {
      partyMock.events.add(listener);
      return () => partyMock.events.delete(listener);
    },
  },
}));

import { toast } from 'sonner';
import { convertingEngine, partyWillPlay } from './convert';
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
interface Event {
  type: string;
  error?: string;
  transcoder?: boolean;
  retry?: { label: string; run(): void };
}
function engineUnderTest() {
  const events: Event[] = [];
  const engine = convertingEngine({ current: null }, client)(
    (e) => events.push(e as Event),
    {}
  );
  const [converting] = engines.made.slice(-1);
  const failure = () => events.find((e) => e.type === 'failed');
  return { engine, events, converting, failure };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  engines.made = [];
  engines.inParty = false;
  answers = [];
  opens = [];
  vi.mocked(toast.warning).mockClear();
  vi.mocked(toast.message).mockClear();
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
    const { engine, converting } = engineUnderTest();
    engine.load(file());
    await settle();
    expect(opens).toEqual(['https://aio.example/party/guest/own/open']);
    expect(converting.loads).toHaveLength(1);
    engine.seek(5000);
    expect(converting.seek).toHaveBeenCalledWith(5000);
  });

  it("says why when conversion can't open, and tries again on request", async () => {
    answers = [
      { status: 502, body: { error: 'Source probe failed: Invalid data' } },
    ];
    const { engine, converting, failure } = engineUnderTest();
    engine.load(file());
    await settle();
    expect(converting.loads).toHaveLength(0);
    expect(failure()?.error).toContain('Source probe failed: Invalid data');
    // the file's problem: other versions may help
    expect(failure()?.transcoder).toBe(false);
    expect(failure()?.retry?.label).toBe('Try again');
    // nothing plays the file without its audio
    expect(engines.made.map((e) => e.name)).toEqual(['converting']);
    failure()!.retry!.run();
    await settle();
    expect(opens).toHaveLength(2);
    expect(converting.loads).toHaveLength(1);
  });

  it('blames a failed source on the source, and offers other versions, not the same download', async () => {
    answers = [
      {
        status: 502,
        body: {
          error: 'The download failed; pick another source',
          code: 'source_failed',
        },
      },
    ];
    const { engine, failure } = engineUnderTest();
    engine.load(file());
    await settle();
    // not "this browser can't play this file's audio"
    expect(failure()?.error).toBe('The download failed; pick another source');
    expect(failure()?.transcoder).toBe(false);
    // the same download would fail again: the screen leads with other versions
    expect(failure()?.retry).toBeUndefined();
  });

  it('offers to try an unreachable source again', async () => {
    answers = [
      {
        status: 502,
        body: {
          error: 'The source could not be reached',
          code: 'source_unreachable',
        },
      },
    ];
    const { engine, failure } = engineUnderTest();
    engine.load(file());
    await settle();
    expect(failure()?.error).toBe('The source could not be reached');
    expect(failure()?.retry?.label).toBe('Try again');
  });

  it('reports a stream that fails before it plays', async () => {
    const { engine, converting, failure } = engineUnderTest();
    engine.load(file());
    await settle();
    converting.emit({
      type: 'failed',
      error: 'Media operation failed (ENOTEMPTY in rmdir)',
      transcoder: true,
    });
    expect(converting.closes).toBe(1);
    expect(failure()?.error).toContain('ENOTEMPTY');
    expect(failure()?.transcoder).toBe(true);
    expect(opens).toHaveLength(1);
  });

  it('reconnects once from the same spot when the stream fails while playing', async () => {
    const { engine, converting, failure } = engineUnderTest();
    engine.load(file());
    await settle();
    converting.emit({ type: 'loaded' });
    converting.emit({ type: 'state', state: { paused: false } });
    converting.emit({ type: 'position', positionMs: 754_000 });
    converting.emit({ type: 'failed', error: 'bufferAppendError' });
    await settle();
    expect(opens).toHaveLength(2);
    expect(converting.loads).toEqual([
      expect.objectContaining({ startMs: 0 }),
      expect.objectContaining({ startMs: 754_000, paused: false }),
    ]);
    expect(toast.message).toHaveBeenCalledWith(expect.any(String), {
      description: 'bufferAppendError',
    });
    expect(failure()).toBeUndefined();
    // lost again before it played: reported, not reconnected in a loop
    converting.emit({ type: 'failed', error: 'bufferAppendError' });
    await settle();
    expect(opens).toHaveLength(2);
    expect(failure()?.error).toContain('bufferAppendError');
  });

  it('never converts the video for its own playback', () => {
    engineUnderTest();
    expect(engines.guestOptions?.convertOnDecodeError).toBe(false);
  });

  it('opens a dropped playback again from where it was, once', async () => {
    const { engine, converting, failure } = engineUnderTest();
    engine.load(file());
    await settle();
    converting.emit({ type: 'loaded' });
    converting.emit({ type: 'position', positionMs: 60_000 });
    engines.guestOptions!.onExpired!('This playback has expired');
    await settle();
    expect(opens).toHaveLength(2);
    expect(converting.loads.map((l) => l.startMs)).toEqual([0, 60_000]);
    // lost again before it loaded: the transcoder's failure, said so
    engines.guestOptions!.onExpired!('This playback has expired');
    await settle();
    expect(opens).toHaveLength(2);
    expect(failure()?.transcoder).toBe(true);
  });

  it('opens it again after a later loss, once it has played', async () => {
    const { engine, converting, failure } = engineUnderTest();
    engine.load(file());
    await settle();
    converting.emit({ type: 'loaded' });
    engines.guestOptions!.onExpired!('gone');
    await settle();
    converting.emit({ type: 'loaded' });
    engines.guestOptions!.onExpired!('gone');
    await settle();
    expect(opens).toHaveLength(3);
    expect(failure()).toBeUndefined();
  });

  it('tries the conversion again on the next load after a failure', async () => {
    answers = [{ status: 502, body: { error: 'x' } }];
    const { engine, converting } = engineUnderTest();
    engine.load(file());
    await settle();
    engine.load(file()); // Resume, or the same version again
    await settle();
    expect(opens).toHaveLength(2);
    expect(converting.loads).toHaveLength(1);
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
    const { engine, events, converting, failure } = engineUnderTest();
    engine.load(file());
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toContainEqual({
      type: 'state',
      state: { waiting: true, loaded: false },
    });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(opens).toHaveLength(3);
    expect(converting.loads).toHaveLength(1);
    expect(failure()).toBeUndefined();
  });

  it('waits for an unreachable transcoder, saying so, then converts', async () => {
    vi.useFakeTimers();
    const down = {
      status: 503,
      body: {
        error: "The transcoder isn't reachable",
        retryAfter: 5,
        code: 'transcoder_unreachable',
      },
    };
    answers = [down, down, down];
    const { engine, converting, failure } = engineUnderTest();
    engine.load(file());
    await vi.advanceTimersByTimeAsync(0);
    expect(toast.message).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.message).mock.calls[0][0]).toContain('transcoder');
    await vi.advanceTimersByTimeAsync(15_000);
    expect(opens).toHaveLength(4);
    expect(converting.loads).toHaveLength(1);
    // said once, not on every attempt
    expect(toast.message).toHaveBeenCalledTimes(1);
    expect(failure()).toBeUndefined();
  });

  it("reports a server without a transcoder at once, as the transcoder's failure", async () => {
    answers = [
      {
        status: 503,
        body: { error: 'Conversion is not set up on this server' },
      },
    ];
    const { engine, failure } = engineUnderTest();
    engine.load(file());
    await settle();
    expect(opens).toHaveLength(1);
    expect(failure()?.error).toContain('Conversion is not set up');
    expect(failure()?.transcoder).toBe(true);
  });

  it("treats a proxy's error page as an answer, not a network blip", async () => {
    answers = [{ status: 524, text: '<html>A timeout occurred</html>' }];
    const { engine, failure } = engineUnderTest();
    engine.load(file());
    await settle();
    expect(opens).toHaveLength(1);
    expect(failure()?.error).toContain('The server answered 524');
  });

  it('holds seeks past the converted part only during a party', () => {
    engineUnderTest();
    expect(engines.guestOptions?.holdUnwritten?.()).toBe(false);
    engines.inParty = true;
    expect(engines.guestOptions?.holdUnwritten?.()).toBe(true);
  });
});

describe('where the party will be', () => {
  const set = (state: Record<string, unknown> | null) => {
    partyMock.state = state;
    for (const listener of partyMock.listeners) listener();
  };
  const command = (name: string) => {
    for (const listener of partyMock.events)
      listener({ type: 'command', command: { command: name } });
  };
  afterEach(() => set(null));
  it('plays on after a seek while it played: the seek holds it only a moment', () => {
    set({ group: 'Playing', timeline: { playing: true } });
    expect(partyWillPlay()).toBe(true);
    command('Seek');
    set({ group: 'Playing', timeline: { playing: false } });
    expect(partyWillPlay()).toBe(true);
  });
  it('stays paused after a seek while paused', () => {
    set({ group: 'Playing', timeline: { playing: true } });
    command('Pause');
    set({ group: 'Paused', timeline: { playing: false } });
    command('Seek');
    expect(partyWillPlay()).toBe(false);
  });
  it('plays nothing without a timeline', () => {
    set({ group: 'Idle' });
    expect(partyWillPlay()).toBe(false);
  });
});
