import { PartyLayer } from '../components/party/party-layer';
import React from 'react';
import { t } from '@lingui/core/macro';
import { Button } from '@aiostreams/ui/button';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { GuestApi, guestBase, type GuestCurrent } from '../lib/guest/api';
import { guestEngine } from '../lib/guest/engine';
import { partyKeys } from '../lib/party/crypto';
import {
  party,
  playingEntry,
  positionAt,
  useParty,
  usePartyEvent,
} from '../lib/party/party';
import { usePartyPlayer } from '../lib/party/playback';
import { guestPrefs, rememberingTracks } from '../lib/guest/track-memory';
import { usePlayer } from '../lib/playback/use-player';
import { GuestSessionProvider } from '../lib/session';
import { JellyfinClient } from '../lib/client';
import { NO_SERVER_INFO, ServerInfoProvider } from '../lib/server-info';
import { PlayerControls } from '../components/player/controls';
import { PartySheet, openPartySheet } from '../components/party/party-sheet';
import type { BaseItemDto, SourceInfo } from '../lib/types';

/** The invitation in the page's address: its party code and secret. */
function invitation() {
  const hash = new URLSearchParams(window.location.hash.slice(1));
  return { code: hash.get('code') ?? '', secret: hash.get('secret') ?? '' };
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
  const leave = React.useCallback(() => {
    forgetSeat();
    party.leave();
    setEnded(true);
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
  const client = React.useMemo(() => new JellyfinClient(guestBase()), []);
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
        <GuestParty api={joined.api} client={client} onLeave={leave} />
        <PartySheet />
        <PartyLayer />
      </GuestSessionProvider>
    </ServerInfoProvider>
  );
}
function GuestParty({
  api,
  client,
  onLeave,
}: {
  api: GuestApi;
  client: JellyfinClient;
  onLeave(): void;
}) {
  const state = useParty();
  const entry = playingEntry(state);
  const info = useQuery({
    queryKey: ['guest-current', api.token, entry?.playlistItemId],
    queryFn: ({ signal }) => api.current(signal),
    refetchInterval: 2000,
    placeholderData: keepPreviousData,
    retry: false,
  });
  React.useEffect(() => {
    if (info.error && [401, 403, 410].includes((info.error as any).status))
      onLeave();
  }, [info.error, onLeave]);
  const last = React.useRef<GuestCurrent | undefined>(undefined);
  if (info.data) last.current = info.data;
  const current = info.data ?? last.current;
  if (!entry || !current)
    return (
      <main className="grid min-h-screen place-items-center p-6">
        <div className="space-y-4 text-center">
          <p>
            {info.error
              ? (info.error as Error).message
              : t`Waiting for the host to choose a title…`}
          </p>
          <Button
            intent="gray-outline"
            onClick={() => openPartySheet()}
          >{t`Watch party`}</Button>
        </div>
      </main>
    );
  return (
    <GuestPlayer
      api={api}
      client={client}
      current={current}
      onLeave={onLeave}
    />
  );
}
function GuestPlayer({
  api,
  client,
  current,
  onLeave,
}: {
  api: GuestApi;
  client: JellyfinClient;
  current: GuestCurrent;
  onLeave(): void;
}) {
  const state = useParty();
  const details = state?.queue.find(
    (e) => e.playlistItemId === current.playlistItemId
  )?.item;
  const video = React.useRef<HTMLVideoElement>(null);
  const [mode, setMode] = React.useState('');
  const [unlocked, setUnlocked] = React.useState(false);
  const currentRef = React.useRef(current);
  currentRef.current = current;
  const startMs = React.useMemo(() => {
    const state = party.state();
    return state?.timeline
      ? positionAt(state.timeline, party.clock()?.now() ?? Date.now())
      : 0;
  }, [current.revision]);
  const [engine] = React.useState(() =>
    guestEngine(video, api, () => currentRef.current, setMode)
  );
  const item = React.useMemo<BaseItemDto>(
    () => ({
      Id: current.itemId,
      Name: current.title,
      Type: details?.type === 'Episode' ? 'Episode' : 'Movie',
      SeriesName: details?.seriesName,
      ParentIndexNumber: details?.season,
      IndexNumber: details?.episode,
      RunTimeTicks: current.media.durationMs * 10000,
    }),
    [current.itemId, current.title, current.media.durationMs, details]
  );
  const source = React.useMemo<SourceInfo>(
    () => ({
      Id: current.revision,
      RunTimeTicks: current.media.durationMs * 10000,
      MediaStreams: [],
    }),
    [current.revision, current.media.durationMs]
  );
  const own = usePlayer(engine.factory, {
    client,
    item,
    source,
    url: current.revision,
    startMs,
    startPaused: true,
    // the track languages this guest last picked, read as each file opens
    prefs: guestPrefs(),
    onEnded: () => {
      const state = party.state();
      if (!state) return;
      party.request(
        state.queue.length > state.playingIndex + 1
          ? { type: 'NextItem', playlistItemId: current.playlistItemId }
          : { type: 'Stop' }
      );
    },
  });
  const partyPlayer = usePartyPlayer(own, current.playlistItemId);
  const player = React.useMemo(
    () => rememberingTracks(partyPlayer),
    [partyPlayer]
  );
  const at = state?.playingIndex ?? 0;
  return (
    <main className="fixed inset-0 bg-black">
      <video ref={video} playsInline className="h-full w-full object-contain" />
      <PlayerControls
        item={item}
        player={player}
        segments={null}
        onBack={onLeave}
        onParty={() => openPartySheet()}
        onPrevious={
          at > 0
            ? () =>
                party.request({
                  type: 'PreviousItem',
                  playlistItemId: current.playlistItemId,
                })
            : undefined
        }
        onNext={
          state && at < state.queue.length - 1
            ? () =>
                party.request({
                  type: 'NextItem',
                  playlistItemId: current.playlistItemId,
                })
            : undefined
        }
      />
      <div className="absolute left-4 top-4 z-20 flex items-center gap-2 rounded-lg bg-black/70 p-2 text-sm">
        <label>
          {t`Quality`}{' '}
          <select
            aria-label={t`Quality`}
            className="rounded bg-neutral-800 p-1"
            defaultValue="original"
            onChange={(event) =>
              engine.setQuality(
                event.target.value as 'original' | '1080p' | '720p'
              )
            }
          >
            <option value="original">{t`Original`}</option>
            <option value="1080p">1080p</option>
            <option value="720p">720p</option>
          </select>
        </label>
        <span>
          {mode === 'direct'
            ? t`Original stream`
            : mode
              ? t`Optimized for your browser`
              : ''}
        </span>
      </div>
      {!unlocked && own.state.loaded && (
        <div className="absolute inset-0 z-30 grid place-items-center bg-black/50">
          <Button
            intent="white"
            onClick={() => {
              void video.current
                ?.play()
                .then(() => {
                  setUnlocked(true);
                  if (party.state()?.timeline?.playing === false)
                    video.current?.pause();
                })
                .catch(() => {});
            }}
          >{t`Play`}</Button>
        </div>
      )}
    </main>
  );
}
