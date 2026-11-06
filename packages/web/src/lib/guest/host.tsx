import React from 'react';
import { t } from '@lingui/core/macro';
import { Button } from '@aiostreams/ui/button';
import { toast } from 'sonner';
import { copyToClipboard } from '@aiostreams/ui/utils/clipboard';
import { party, useParty } from '../party/party';
import { usePartyIdentity } from '../party/actions';
import { playbackNow } from '../playback/session';
import { partyItemTitle } from '../party/items';
import { GuestApi } from './api';

const active = new Set<string>();
const links = new Map<string, string>();
/**
 * Bumped whenever the server binding is (re)created. A new binding starts with
 * no entries, so the queue must be published again even if it is unchanged.
 */
let binding = 0;
export function useGuestPublication() {
  const state = useParty();
  const identity = usePartyIdentity();
  React.useEffect(() => {
    if (
      !state ||
      state.you !== state.host ||
      state.invite.relay !== identity.server ||
      !identity.token
    )
      return;
    const base = `${state.invite.relay}/party/guest`;
    const api = new GuestApi(base, identity.token);
    let stopped = false,
      busy = false,
      last = '';
    const publish = async () => {
      const proof = party.hostProof();
      if (!proof || !active.has(proof.party) || stopped || busy) return;
      const current = party.state();
      if (!current) return;
      const now = playbackNow();
      const entries = current.queue.flatMap((entry) =>
        entry.item
          ? [
              {
                ref: entry.ref,
                itemId: entry.item.id,
                title: partyItemTitle(entry.item),
                filename: entry.item.version?.filename,
                sourceId:
                  now?.itemId === entry.item.id ? now.sourceId : undefined,
              },
            ]
          : []
      );
      const serialized = `${binding}\n${JSON.stringify(entries)}`;
      if (serialized === last) return;
      busy = true;
      try {
        await api.request('/publish', { ...proof, entries });
        last = serialized;
      } catch (error) {
        if ((error as { status?: number }).status === 404) {
          // The server lost the binding (disabled elsewhere or restarted).
          active.delete(proof.party);
          links.delete(proof.party);
          last = '';
        }
        if (!stopped) toast.error((error as Error).message);
      } finally {
        busy = false;
      }
    };
    void publish();
    const timer = setInterval(() => void publish(), 2000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [state?.invite.code, state?.host, state?.you, identity]);
}
export function GuestInvite() {
  const state = useParty();
  const identity = usePartyIdentity();
  const [available, setAvailable] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [link, setLink] = React.useState(() => {
    const proof = party.hostProof();
    return proof ? (links.get(proof.party) ?? '') : '';
  });
  const local =
    !!state &&
    state.invite.relay === identity.server &&
    !!identity.token &&
    state.you === state.host;
  React.useEffect(() => {
    if (!local || !state) return;
    let stopped = false;
    void fetch(`${state.invite.relay}/party/guest/available`)
      .then((r) => r.json())
      .then((r) => {
        if (!stopped) setAvailable(r.enabled);
      })
      .catch(() => {});
    return () => {
      stopped = true;
    };
  }, [local, state?.invite.relay]);
  if (!local || !available || !state) return null;
  const enable = async () => {
    const proof = party.hostProof();
    if (!proof) return;
    setBusy(true);
    try {
      const api = new GuestApi(
        `${state.invite.relay}/party/guest`,
        identity.token!
      );
      const result = await api.request<{ secret: string }>('/host', proof);
      // The server may have restarted with an empty binding even when this
      // party still looks active here; an extra publish is harmless.
      binding++;
      active.add(proof.party);
      const next = `${state.invite.relay}/watch#${new URLSearchParams({ code: state.invite.code, secret: result.secret })}`;
      links.set(proof.party, next);
      setLink(next);
      await copyToClipboard(next, {
        onSuccess: () => toast.success(t`Guest link copied`),
      });
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const disable = async () => {
    const proof = party.hostProof();
    if (!proof) return;
    setBusy(true);
    try {
      await new GuestApi(
        `${state.invite.relay}/party/guest`,
        identity.token!
      ).request('/disable', proof);
      active.delete(proof.party);
      links.delete(proof.party);
      setLink('');
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="my-4 space-y-2 rounded-xl bg-white/5 p-3">
      <p className="text-sm">{t`Let guests watch your stream in a browser without signing in.`}</p>
      <Button
        intent="gray-outline"
        size="sm"
        disabled={busy}
        onClick={() => void enable()}
      >
        {link ? t`Copy guest link` : t`Allow guests and copy link`}
      </Button>
      {link && (
        <Button
          intent="gray-outline"
          size="sm"
          disabled={busy}
          onClick={() => void disable()}
        >{t`Stop guest streaming`}</Button>
      )}
    </div>
  );
}
