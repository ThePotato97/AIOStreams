import React from 'react';
import { t } from '@lingui/core/macro';
import { Button } from '@aiostreams/ui/button';
import { copyToClipboard } from '@aiostreams/ui/utils/clipboard';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { SettingsCard } from '@/app/settings/_components/settings-card';
import { GUEST_USER_ID } from '@/lib/guest/guest-client';
import { linkUrl, listLinks, revokeLink } from '@/lib/guest/links';
import { useSession } from '@/lib/jellyfin/session';
import { relayBase } from '@/lib/party/invite';

/**
 * The user's share links (made with the player's Share link button): each one copied again, or
 * revoked, which stops it playing for everyone who has it.
 */
export function ShareLinksCard() {
  const { client, user } = useSession();
  const queryClient = useQueryClient();
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
      description={t`Made with Share link in the player. Whoever has one plays that video on their own, without an account, until you revoke it.`}
    >
      {links.data?.length ? (
        <ul className="space-y-2">
          {links.data.map((link) => (
            <li key={link.id} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate">{link.title}</span>
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
