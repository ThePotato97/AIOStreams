import React from 'react';
import { plural, t } from '@lingui/core/macro';
import { Button } from '@aiostreams/ui/button';
import { Select } from '@aiostreams/ui/select';
import { copyToClipboard } from '@aiostreams/ui/utils/clipboard';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { SettingsCard } from '@/app/settings/_components/settings-card';
import { GUEST_USER_ID } from '@/lib/guest/guest-client';
import { linkUrl, listLinks, revokeLink } from '@/lib/guest/links';
import { useSession } from '@/lib/jellyfin/session';
import { relayBase } from '@/lib/party/invite';
import { SHARE_LINK_DAYS, settings, useSetting } from '@/lib/settings';

/**
 * The user's share links (made with Copy share link in a title's versions list): each one copied again, or
 * revoked, which stops it playing for everyone who has it.
 */
export function ShareLinksCard() {
  const { client, user } = useSession();
  const queryClient = useQueryClient();
  const [days, setDays] = useSetting(settings.share.linkDays);
  const root = relayBase(client.base) ?? client.base;
  const signedIn = user.Id !== GUEST_USER_ID && !!client.token;
  const queryKey = ['share-links', root, user.Id];
  const links = useQuery({
    queryKey,
    queryFn: () => listLinks(root, client.token!),
    enabled: signedIn,
    retry: false,
  });
  const revoke = useMutation({
    mutationFn: (id: string) => revokeLink(root, client.token!, id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
    onError: (error) => toast.error((error as Error).message),
  });
  // A server without guest streaming has no share links to list.
  if (!signedIn || links.isError) return null;
  return (
    <SettingsCard
      name="share-links"
      title={t`Share links`}
      description={t`Made with Copy share link in a title's versions list. Whoever has one plays that video on their own, without an account, until it expires or you revoke it.`}
    >
      <Select
        label={t`New links expire after`}
        options={SHARE_LINK_DAYS.map((d) => ({
          value: String(d),
          label: daysLabel(d),
        }))}
        value={String(days)}
        onValueChange={(v) => setDays(Number(v))}
      />
      {links.data?.length ? (
        <ul className="space-y-2">
          {links.data.map((link) => (
            <li key={link.id} className="flex items-center gap-2">
              <span className="min-w-0 flex-1">
                <span className="block truncate">{link.title}</span>
                <span className="block text-xs text-[--muted]">
                  {expiryLabel(link.expiresAt)}
                </span>
              </span>
              <Button
                size="sm"
                intent="gray-outline"
                onClick={() =>
                  void copyToClipboard(linkUrl(root, link)).then(() =>
                    toast.success(t`Share link copied`)
                  )
                }
              >
                {t`Copy`}
              </Button>
              <Button
                size="sm"
                intent="alert-subtle"
                loading={revoke.isPending && revoke.variables === link.id}
                onClick={() => revoke.mutate(link.id)}
              >
                {t`Revoke`}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-[--muted]">
          {links.isPending ? t`Loading…` : t`No share links yet.`}
        </p>
      )}
    </SettingsCard>
  );
}

const daysLabel = (days: number) =>
  days === 0 ? t`Never` : plural(days, { one: '# day', other: '# days' });

function expiryLabel(expiresAt: number | null): string {
  if (!expiresAt) return t`Never expires`;
  const when = new Date(expiresAt).toLocaleString();
  return t`Expires ${when}`;
}
