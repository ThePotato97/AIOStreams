import React from 'react';
import { t } from '@lingui/core/macro';
import { Button } from '@aiostreams/ui/button';
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { PlayerPage } from '@/app/player/page';
import { GuestApi, guestBase, type GuestCurrent } from '@/lib/guest/api';
import { GuestJellyfinClient, GUEST_USER_ID } from '@/lib/guest/guest-client';
import { openLink } from '@/lib/guest/links';
import { guestPrefs } from '@/lib/guest/track-memory';
import { GuestSessionProvider } from '@/lib/jellyfin/session';
import { NO_SERVER_INFO, ServerInfoProvider } from '@/lib/jellyfin/server-info';
import type { MediaSegmentDto } from '@/lib/jellyfin/types';
import { setNavigator } from '@/lib/paths';

/** The share link in the page's address, read as the page opens (the player replaces the hash). */
const opened = (() => {
  const hash = new URLSearchParams(window.location.hash.slice(1));
  return { link: hash.get('link') ?? '', secret: hash.get('secret') ?? '' };
})();
/** Whether the page was opened from a share link rather than a party's invitation. */
export const openedFromLink = () => !!opened.link;

/** The viewer's session for this link, kept in this tab so a reload plays on without asking again. */
const SESSION_KEY = 'aiostreams-web-link-session';
function keptSession(): string | null {
  try {
    const kept = JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? 'null') as {
      link: string;
      token: string;
    } | null;
    return kept?.link === opened.link ? kept.token : null;
  } catch {
    return null;
  }
}
function keepSession(token: string | null) {
  try {
    if (token)
      sessionStorage.setItem(
        SESSION_KEY,
        JSON.stringify({ link: opened.link, token })
      );
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* private windows: a reload exchanges the link again */
  }
}

const Message = ({ children }: { children: React.ReactNode }) => (
  <main className="grid min-h-screen place-items-center p-6 text-center">
    {children}
  </main>
);

/**
 * A share link's page, at `/watch#link=…&secret=…`: whoever has it plays the title on the app's own
 * player, on their own and without an account, reading the owner's file directly.
 */
export function LinkPage() {
  const [api, setApi] = React.useState<GuestApi | null>(null);
  const [error, setError] = React.useState('');
  const open = React.useCallback(async (fresh: boolean) => {
    try {
      if (
        !/^[A-Za-z0-9_-]{22}$/.test(opened.link) ||
        !/^[A-Za-z0-9_-]{43}$/.test(opened.secret)
      )
        throw Error(t`This link is incomplete`);
      const token =
        (!fresh && keptSession()) ||
        (await openLink(guestBase(), opened.link, opened.secret));
      keepSession(token);
      setApi(new GuestApi(guestBase(), token));
    } catch (e) {
      keepSession(null);
      setError((e as Error).message);
    }
  }, []);
  React.useEffect(() => {
    void open(false);
  }, [open]);
  // The player page navigates the app's pages, which a link's viewer has none of.
  React.useEffect(() => {
    setNavigator(
      () => {},
      async () => {}
    );
  }, []);
  const playing = React.useRef<GuestCurrent | undefined>(undefined);
  const apiRef = React.useRef<GuestApi | null>(null);
  apiRef.current = api;
  const client = React.useMemo(
    () =>
      new GuestJellyfinClient(
        guestBase(),
        () => playing.current,
        () => [],
        async () =>
          apiRef.current
            ? apiRef.current.request<{ Items: MediaSegmentDto[] }>('/segments')
            : { Items: [] },
        `${guestBase().replace(/\/party\/guest$/, '')}/jellyfin`,
        (current) => apiRef.current?.mediaUrl(current.revision) ?? ''
      ),
    []
  );
  const leave = React.useCallback(() => {}, []);
  if (error) return <Message>{error}</Message>;
  if (!api) return <Message>{t`Opening the link…`}</Message>;
  return (
    <ServerInfoProvider value={NO_SERVER_INFO}>
      <GuestSessionProvider client={client} name={t`Guest`} onLeave={leave}>
        <LinkTitle
          api={api}
          client={client}
          playing={playing}
          // A session that lapsed (a day old, or from before a restart): the link again.
          onExpired={() => void open(true)}
          onRevoked={() => setError(t`This link has been revoked`)}
        />
      </GuestSessionProvider>
    </ServerInfoProvider>
  );
}

function LinkTitle({
  api,
  client,
  playing,
  onExpired,
  onRevoked,
}: {
  api: GuestApi;
  client: GuestJellyfinClient;
  playing: React.MutableRefObject<GuestCurrent | undefined>;
  onExpired(): void;
  onRevoked(): void;
}) {
  // As a party's guest asks: a long poll, answered once the title is opened (or fails).
  const known = React.useRef('');
  const info = useQuery({
    queryKey: ['link-current', api.token],
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
    const status = (info.error as { status?: number } | null)?.status;
    if (status === 401) onExpired();
    else if (status === 410 || status === 403) onRevoked();
  }, [info.error, onExpired, onRevoked]);
  const last = React.useRef<GuestCurrent | undefined>(undefined);
  const ready = info.data?.state == null || info.data.state === 'ready';
  if (info.data && ready) last.current = info.data;
  const current = ready ? (info.data ?? last.current) : undefined;
  playing.current = current ?? last.current;
  if (!current)
    return (
      <Message>
        {info.error
          ? (info.error as Error).message
          : info.data?.state === 'failed'
            ? (info.data.error ?? t`The source couldn't be opened`)
            : t`Opening the video…`}
      </Message>
    );
  return (
    <LinkPlayer key={current.revision} client={client} current={current} />
  );
}

/** Whether the page has had a click or key, which a browser asks for before it plays sound. */
const activated = () => navigator.userActivation?.hasBeenActive ?? true;

function LinkPlayer({
  client,
  current,
}: {
  client: GuestJellyfinClient;
  current: GuestCurrent;
}) {
  const queryClient = useQueryClient();
  const [started, setStarted] = React.useState(activated);
  // The languages the viewer last picked, which the title opens with.
  React.useLayoutEffect(() => {
    queryClient.setQueryData(
      ['jf', client.base, GUEST_USER_ID, 'configuration'],
      guestPrefs()
    );
  }, [queryClient, client.base]);
  if (!started)
    return (
      <Message>
        <div className="space-y-4">
          <p className="text-xl font-semibold">{current.title}</p>
          <Button intent="white" onClick={() => setStarted(true)}>
            {t`Play`}
          </Button>
        </div>
      </Message>
    );
  return (
    <PlayerPage
      itemId={current.itemId}
      sourceId={current.revision}
      startMs={0}
      mini={false}
    />
  );
}
