import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import React from 'react';
import { toast } from 'sonner';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@aiostreams/ui/button';
import { Modal } from '@aiostreams/ui/modal';
import { useSession } from '@/lib/jellyfin/session';
import { useKey } from '@/lib/jellyfin/queries';
import { SettingsCard, SettingsRow } from './_components/settings-card';

interface SimklStatus {
  available: boolean;
  account: {
    username: string | null;
    status: 'ok' | 'expired';
    lastError: string | null;
    linkedAt: number;
  } | null;
}

interface SimklCode {
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

type PollResult =
  | { state: 'pending'; interval?: number }
  | { state: 'expired' }
  | { state: 'linked'; username: string | null }
  | { state: 'error'; error: string };

/** Linked per user (and persona with its own history), on the server. */
export function SimklCard() {
  const { client } = useSession();
  const queryClient = useQueryClient();
  const key = [...useKey(), 'simkl'];
  const status = useQuery({
    queryKey: key,
    queryFn: () => client.get<SimklStatus>('/AIOStreams/Simkl'),
    retry: false,
    staleTime: 60_000,
  });
  const [code, setCode] = React.useState<SimklCode | null>(null);
  const [busy, setBusy] = React.useState(false);
  const button = 'w-full rounded-full sm:w-auto';

  if (!status.data?.available) return null;
  const account = status.data.account;
  const username = account?.username ?? '';

  const link = async () => {
    setBusy(true);
    try {
      setCode(await client.post<SimklCode>('/AIOStreams/Simkl/Link'));
    } catch {
      toast.error(t`Couldn't reach Simkl. Try again in a moment.`);
    } finally {
      setBusy(false);
    }
  };
  const unlink = async () => {
    setBusy(true);
    await client.delete('/AIOStreams/Simkl/Link').catch(() => undefined);
    setBusy(false);
    await queryClient.invalidateQueries({ queryKey: key });
  };

  return (
    <SettingsCard
      name="simkl"
      title={t`Simkl`}
      description={t`What you watch, on any device signed in as you, is scrobbled to your Simkl account.`}
    >
      <SettingsRow
        label={
          account
            ? account.status === 'ok'
              ? account.username
                ? t`Linked as ${username}`
                : t`Linked`
              : t`Simkl signed this link out`
            : t`Not linked`
        }
        help={
          account?.status === 'expired'
            ? t`Link it again to carry on scrobbling.`
            : undefined
        }
      >
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
          {(!account || account.status === 'expired') && (
            <Button
              intent="white"
              className={button}
              loading={busy}
              onClick={link}
            >
              {account ? <Trans>Link again</Trans> : <Trans>Link Simkl</Trans>}
            </Button>
          )}
          {account && (
            <Button
              intent="gray-outline"
              className={button}
              loading={busy}
              onClick={unlink}
            >
              <Trans>Unlink</Trans>
            </Button>
          )}
        </div>
      </SettingsRow>
      <LinkDialog
        code={code}
        onClose={() => setCode(null)}
        onLinked={async (username) => {
          setCode(null);
          toast.success(
            username ? t`Simkl linked as ${username}` : t`Simkl linked`
          );
          await queryClient.invalidateQueries({ queryKey: key });
        }}
      />
    </SettingsCard>
  );
}

function LinkDialog({
  code,
  onClose,
  onLinked,
}: {
  code: SimklCode | null;
  onClose(): void;
  onLinked(username: string | null): void;
}) {
  const { client } = useSession();
  const [error, setError] = React.useState<string | null>(null);
  // The poll loop lives as long as the code, not as long as one render.
  const linked = React.useRef(onLinked);
  linked.current = onLinked;

  React.useEffect(() => {
    if (!code) return;
    setError(null);
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async (interval: number) => {
      timer = setTimeout(async () => {
        if (stopped) return;
        const result = await client
          .post<PollResult>('/AIOStreams/Simkl/Link/Poll')
          .catch((): PollResult => ({ state: 'pending' }));
        if (stopped) return;
        if (result.state === 'linked') return linked.current(result.username);
        if (result.state === 'expired')
          return setError(t`The code expired. Close this and try again.`);
        if (result.state === 'error') return setError(result.error);
        void poll(result.interval ?? interval);
      }, interval * 1000);
    };
    void poll(code.interval);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [code, client]);

  const verificationUri = code?.verificationUri;
  return (
    <Modal
      data-ui="dialog"
      data-name="simkl-link"
      open={!!code}
      onOpenChange={(next) => !next && onClose()}
      title={t`Link Simkl`}
      description={t`Approve AIOStreams on Simkl. This closes by itself once you have.`}
    >
      {code && (
        <div className="space-y-4 text-center">
          <Button
            intent="white"
            className="w-full rounded-full"
            onClick={() => window.open(code.verificationUriComplete, '_blank')}
          >
            <Trans>Open Simkl</Trans>
          </Button>
          <p className="text-[--muted]">
            <Trans>
              Or, on another device, go to {verificationUri} and enter
            </Trans>
          </p>
          <p className="font-mono text-3xl tracking-widest">{code.userCode}</p>
          {error && <p className="text-red-300">{error}</p>}
        </div>
      )}
    </Modal>
  );
}
