/*
 * Share links: a title, in the version its owner played, that whoever has the link plays on their
 * own in the web app's player, without an account, until the owner revokes it. The server keeps
 * them as guest shares without a party (`/party/guest/links`).
 */
import { GuestApi } from './api';

export interface ShareLink {
  id: string;
  secret: string;
  title: string;
  createdAt: number;
  /** When it stops working; null, not until it's revoked. */
  expiresAt: number | null;
}

/** The guest routes of the server at `root` (its address without `/jellyfin`), as its user. */
const linksApi = (root: string, token: string) =>
  new GuestApi(`${root}/party/guest`, token);

/** The address that plays a link: the server's guest page, the link and its secret in the hash. */
export function linkUrl(root: string, link: Pick<ShareLink, 'id' | 'secret'>) {
  const hash = new URLSearchParams({ link: link.id, secret: link.secret });
  return `${root}/watch#${hash}`;
}

export function createLink(
  root: string,
  token: string,
  itemId: string,
  sourceId: string | undefined,
  /** How many days it lasts; 0, until it's revoked. */
  days: number
): Promise<ShareLink> {
  return linksApi(root, token).request<ShareLink>('/links', {
    itemId,
    sourceId,
    days: days || null,
  });
}

export async function listLinks(
  root: string,
  token: string
): Promise<ShareLink[]> {
  return (await linksApi(root, token).request<{ links: ShareLink[] }>('/links'))
    .links;
}

export async function revokeLink(
  root: string,
  token: string,
  id: string
): Promise<void> {
  const res = await fetch(`${root}/party/guest/links/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok && res.status !== 404)
    throw Object.assign(new Error(`The server answered ${res.status}`), {
      status: res.status,
    });
}

/** A viewer's session for a link: exchanged with its secret, without an account. */
export async function openLink(
  base: string,
  link: string,
  secret: string
): Promise<string> {
  const { token } = await new GuestApi(base, '').request<{ token: string }>(
    '/links/exchange',
    { link, secret }
  );
  return token;
}
