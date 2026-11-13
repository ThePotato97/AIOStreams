import { PartyLayer } from '../components/party/party-layer';
import React from 'react';
import { t } from '@lingui/core/macro';
import { Button } from '@aiostreams/ui/button';
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { GuestApi, guestBase, type GuestCurrent } from '../lib/guest/api';
import { guestEngine } from '../lib/guest/engine';
import { GuestJellyfinClient, GUEST_USER_ID } from '../lib/guest/guest-client';
import { PlayerEngineOverride } from '../lib/guest/player-engine';
import { partyKeys } from '../lib/party/crypto';
import {
  party,
  playingEntry,
  positionAt,
  useParty,
  usePartyEvent,
} from '../lib/party/party';
import {
  bindPartyPlayback,
  leavePartyPlayback,
  rejoinPartyPlayback,
  usePartyAway,
} from '../lib/party/follow';
import { guestPrefs, rememberingEngine } from '../lib/guest/track-memory';
import { GuestSessionProvider } from '../lib/session';
import { NO_SERVER_INFO, ServerInfoProvider } from '../lib/server-info';
import { PartySheet, openPartySheet } from '../components/party/party-sheet';
import { PlayerPage } from './player';
import { waitForNoPlayer } from '../lib/party/playback';
import { partyWillPlay } from '../lib/playback/convert';
import { setNavigator } from '../lib/paths';
import type { MediaSegmentDto } from '../lib/types';
import type { EngineFactory } from '../lib/playback/engine';

/**
 * The invitation in the page's address: its party code and secret. Read as the page opens: the
 * player page's navigation would replace the address's hash.
 */
const opened = (() => {
  const hash = new URLSearchParams(window.location.hash.slice(1));
  return { code: hash.get('code') ?? '', secret: hash.get('secret') ?? '' };
})();
function invitation() {
  return opened;
}

/**
 * The guest's place in the party, kept in this tab (sessionStorage: a reload keeps it, another
 * tab joins on its own): the guest session, its seat key and name.
 */
interface KeptSeat {
  code: string;
  token: string;
  name: string;
  seat: string | null;
}
const SEAT_KEY = 'aiostreams-web-guest-seat';
function keptSeat(): KeptSeat | null {
  try {
    return JSON.parse(
      sessionStorage.getItem(SEAT_KEY) ?? 'null'
    ) as KeptSeat | null;
  } catch {
    return null;
  }
}
function keepSeat(seat: KeptSeat) {
  try {
    sessionStorage.setItem(SEAT_KEY, JSON.stringify(seat));
  } catch {
    /* private windows and blocked site data: a reload joins again */
  }
}
function forgetSeat() {
  try {
    sessionStorage.removeItem(SEAT_KEY);
  } catch {
    /* as above */
  }
}

export function GuestPage() {
  const [name, setName] = React.useState('');
  const [joining, setJoining] = React.useState(false);
  const [joined, setJoined] = React.useState<{
    api: GuestApi;
    name: string;
  } | null>(null);
  const [error, setError] = React.useState('');
  const [ended, setEnded] = React.useState(false);
  /** Taking a reloaded page's seat back: its failure shows the form, not an ending. */
  const resuming = React.useRef(false);
  usePartyEvent((event) => {
    if (event.type === 'ended') {
      forgetSeat();
      if (resuming.current) return;
      setEnded(true);
      setError(event.reason);
    }
  });
  const leave = React.useCallback((reason?: string) => {
    forgetSeat();
    party.leave();
    setEnded(true);
    if (reason) setError(reason);
  }, []);
  const enter = async (
    code: string,
    displayName: string,
    token: string,
    seat?: string
  ) => {
    const base = guestBase(),
      relay = base.replace(/\/party\/guest$/, '');
    await party.join(
      { relay, code },
      {
        name: displayName,
        avatar: null,
        server: relay,
        userId: 'guest',
        token,
        seat,
      }
    );
    keepSeat({ code, token, name: displayName, seat: party.seat() });
    setJoined({ api: new GuestApi(base, token), name: displayName });
  };
  // A reloaded page takes its seat back, as the same member with the same guest session,
  // rather than joining again beside the one it left (shown away until it's given up).
  React.useEffect(() => {
    const kept = keptSeat();
    if (!kept?.seat || kept.code !== invitation().code) return;
    resuming.current = true;
    setJoining(true);
    setName(kept.name);
    enter(kept.code, kept.name, kept.token, kept.seat)
      .catch(() => forgetSeat())
      .finally(() => {
        resuming.current = false;
        setJoining(false);
      });
    // Once, as the page opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const join = async (event: React.FormEvent) => {
    event.preventDefault();
    if (joining) return;
    setJoining(true);
    setError('');
    try {
      const { code, secret } = invitation();
      if (!/^[0-9A-Z]{10}$/.test(code) || !/^[A-Za-z0-9_-]{43}$/.test(secret))
        throw Error(t`This guest invitation is incomplete`);
      const keys = await partyKeys(code);
      const result = await new GuestApi(guestBase(), '').request<{
        token: string;
      }>('/exchange', { party: keys.id, secret });
      await enter(code, name.trim().slice(0, 60) || t`Guest`, result.token);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setJoining(false);
    }
  };
  // What the player page asks its server for, answered from the title playing and the queue.
  const playing = React.useRef<GuestCurrent | undefined>(undefined);
  const api = React.useRef<GuestApi | null>(null);
  api.current = joined?.api ?? null;
  const client = React.useMemo(
    () =>
      new GuestJellyfinClient(
        guestBase(),
        () => playing.current,
        () =>
          (party.state()?.queue ?? []).flatMap((e) => (e.item ? [e.item] : [])),
        async () =>
          api.current
            ? api.current.request<{ Items: MediaSegmentDto[] }>('/segments')
            : { Items: [] },
        // The host's server's own image route, which serves image tags without a session.
        `${guestBase().replace(/\/party\/guest$/, '')}/jellyfin`
      ),
    []
  );
  // The player page navigates the app's pages, which a guest has none of: the address keeps
  // the invitation, so a reload takes the seat back.
  React.useEffect(() => {
    setNavigator(
      () => {},
      async () => {}
    );
  }, []);
  if (ended)
    return (
      <main className="grid min-h-screen place-items-center p-6">
        <p>{error || t`You left the party`}</p>
      </main>
    );
  if (!joined)
    return (
      <main className="grid min-h-screen place-items-center p-6">
        <form
          onSubmit={(event) => void join(event)}
          className="w-full max-w-sm space-y-5 rounded-2xl bg-white/5 p-6"
        >
          <h1 className="text-2xl font-semibold">{t`You're invited to watch together`}</h1>
          <label className="block space-y-2">
            <span>{t`Your name`}</span>
            <input
              autoComplete="nickname"
              maxLength={60}
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="w-full rounded-lg bg-white/10 p-3"
            />
          </label>
          {error && <p role="alert">{error}</p>}
          <Button type="submit" intent="white" disabled={joining}>
            {joining ? t`Joining…` : t`Join party`}
          </Button>
        </form>
      </main>
    );
  return (
    <ServerInfoProvider value={NO_SERVER_INFO}>
      <GuestSessionProvider client={client} name={joined.name} onLeave={leave}>
        <GuestParty
          api={joined.api}
          client={client}
          playing={playing}
          onLeave={leave}
        />
        <PartySheet />
      </GuestSessionProvider>
    </ServerInfoProvider>
  );
}
function GuestParty({
  api,
  client,
  playing,
  onLeave,
}: {
  api: GuestApi;
  client: GuestJellyfinClient;
  playing: React.MutableRefObject<GuestCurrent | undefined>;
  onLeave(reason?: string): void;
}) {
  const state = useParty();
  const entry = playingEntry(state);
  const away = usePartyAway();
  // Each (re)join, the group waits for this member until told otherwise: before a player takes
  // over, the guest doesn't hold the party.
  const live = state?.status === 'live';
  React.useEffect(() => {
    if (live) waitForNoPlayer();
  }, [live]);
  // The title, as a long poll: asked again as soon as answered, each time with what's known, so
  // it answers when that changes (a title, a version, a failure, a recovery).
  const known = React.useRef('');
  const info = useQuery({
    queryKey: ['guest-current', api.token, entry?.playlistItemId],
    queryFn: async ({ signal }) => {
      const now = await api.current(signal, known.current);
      known.current = now.token ?? '';
      return now;
    },
    refetchInterval: (query) => (query.state.status === 'error' ? 2000 : 50),
    placeholderData: keepPreviousData,
    retry: false,
  });
  React.useEffect(() => {
    if (info.error && [401, 403, 410].includes((info.error as any).status))
      // A session the server dropped in a restart (its first deploy with stored sessions).
      onLeave(
        (info.error as any).code === 'session_restarted'
          ? t`The server restarted; rejoin with the link`
          : undefined
      );
  }, [info.error, onLeave]);
  const last = React.useRef<GuestCurrent | undefined>(undefined);
  // Only a title resolved and probed plays; one resolving or failed is shown while waiting.
  const ready = info.data?.state == null || info.data.state === 'ready';
  if (info.data && ready) last.current = info.data;
  const current = ready ? (info.data ?? last.current) : undefined;
  playing.current = current ?? last.current;
  /** The quality the guest chose, kept from one title to the next. */
  const [quality, setQuality] = React.useState<GuestQuality>('original');
  if (!entry || !current || current.playlistItemId !== entry.playlistItemId)
    return (
      <Waiting
        message={
          info.error
            ? (info.error as Error).message
            : info.data?.state === 'failed'
              ? (info.data.error ?? t`The source couldn't be opened`)
              : info.data?.state === 'resolving'
                ? t`Opening what the host is playing…`
                : t`Waiting for the host to choose a title…`
        }
      />
    );
  if (away)
    return (
      <Waiting
        message={t`You left the party's playback.`}
        action={{ label: t`Back to the party`, run: rejoinPartyPlayback }}
      />
    );
  return (
    <GuestPlayer
      key={current.revision}
      api={api}
      client={client}
      current={current}
      quality={quality}
      onQuality={setQuality}
    />
  );
}

function Waiting({
  message,
  action,
}: {
  message: string;
  action?: { label: string; run(): void };
}) {
  return (
    <main className="grid min-h-screen place-items-center p-6">
      <div className="space-y-4 text-center">
        <p>{message}</p>
        <div className="flex justify-center gap-2">
          {action && (
            <Button intent="white" onClick={action.run}>
              {action.label}
            </Button>
          )}
          <Button intent="gray-outline" onClick={() => openPartySheet()}>
            {t`Watch party`}
          </Button>
        </div>
      </div>
      <PartyLayer />
    </main>
  );
}

type GuestQuality = 'original' | '1080p' | '720p';

/**
 * The party's title on the app's own player page, with the guest engine: it plays what the guest
 * routes prepare, and the page's requests to its server are answered by the guest's client.
 */
function GuestPlayer({
  api,
  client,
  current,
  quality,
  onQuality,
}: {
  api: GuestApi;
  client: GuestJellyfinClient;
  current: GuestCurrent;
  quality: GuestQuality;
  onQuality(quality: GuestQuality): void;
}) {
  const queryClient = useQueryClient();
  const [mode, setMode] = React.useState('');
  // Read live by the party: a converted stream doesn't hold it.
  const modeNow = React.useRef(mode);
  modeNow.current = mode;
  const [loaded, setLoaded] = React.useState(false);
  const [unlocked, setUnlocked] = React.useState(false);
  const currentRef = React.useRef(current);
  currentRef.current = current;
  /** The player page's video, handed to the engine. */
  const video = React.useRef<React.RefObject<HTMLVideoElement | null> | null>(
    null
  );
  const setEngineQuality = React.useRef<(q: GuestQuality) => void>(() => {});
  const startMs = React.useMemo(() => {
    const state = party.state();
    return state?.timeline
      ? positionAt(state.timeline, party.clock()?.now() ?? Date.now())
      : 0;
  }, []);
  // The player page plays the party's title as the party's: paused until the party plays,
  // following it, stepping through its queue.
  const [bound, setBound] = React.useState(false);
  React.useLayoutEffect(() => {
    const source = client.source();
    if (!source) return;
    bindPartyPlayback({
      playlistItemId: current.playlistItemId,
      itemId: current.itemId,
      source,
    });
    setBound(true);
  }, [client, current.playlistItemId, current.itemId]);
  // Its Back leaves the party's playback, going back in the browser's history: an entry of
  // this page's own keeps the guest here, and the browser's own Back does the same.
  React.useEffect(() => {
    if (window.history.state?.guestPlayer !== true)
      window.history.pushState(
        { ...window.history.state, guestPlayer: true },
        '',
        window.location.href
      );
    const left = () => leavePartyPlayback();
    window.addEventListener('popstate', left);
    return () => window.removeEventListener('popstate', left);
  }, []);
  // Made once per title, as the player page makes its engine once.
  const [engine] = React.useState(
    () => (ref: React.RefObject<HTMLVideoElement | null>) => {
      video.current = ref;
      const inner = guestEngine(ref, api, () => currentRef.current, setMode, {
        partyPlaying: partyWillPlay,
      });
      setEngineQuality.current = inner.setQuality;
      // The engine takes a quality once the player page has made it, before it loads.
      const withQuality: EngineFactory = (emit, opts) => {
        const made = inner.factory(emit, opts);
        inner.setQuality(quality);
        return made;
      };
      return rememberingEngine(
        withQuality,
        () => currentRef.current,
        () => setLoaded(true),
        () =>
          queryClient.setQueryData(
            ['jf', client.base, GUEST_USER_ID, 'configuration'],
            guestPrefs()
          )
      );
    }
  );
  // Offered with the player's other options; Original says how this browser gets the file.
  const choice = React.useMemo(
    () => ({
      engine,
      // Until it knows it plays the file itself, it doesn't hold the party: it may convert.
      converted: () => modeNow.current !== 'direct',
      quality: {
        value: quality,
        options: [
          {
            id: 'original',
            label: t`Original`,
            detail:
              mode === 'direct'
                ? t`The file as it is`
                : mode
                  ? t`Converted where your browser needs it`
                  : undefined,
          },
          { id: '1080p', label: '1080p' },
          { id: '720p', label: '720p' },
        ],
        onChange(id: string) {
          const next = id as GuestQuality;
          onQuality(next);
          setEngineQuality.current(next);
        },
      },
    }),
    [engine, quality, mode, onQuality]
  );
  if (!bound) return null;
  return (
    <PlayerEngineOverride.Provider value={choice}>
      <PlayerPage
        itemId={current.itemId}
        sourceId={current.revision}
        startMs={startMs}
        mini={false}
      />
      {!unlocked && loaded && (
        <div className="fixed inset-0 z-20 grid place-items-center bg-black/50">
          <Button
            intent="white"
            onClick={() => {
              const el = video.current?.current;
              void el
                ?.play()
                .then(() => {
                  setUnlocked(true);
                  if (party.state()?.timeline?.playing === false) el.pause();
                })
                .catch(() => {});
            }}
          >{t`Play`}</Button>
        </div>
      )}
    </PlayerEngineOverride.Provider>
  );
}
