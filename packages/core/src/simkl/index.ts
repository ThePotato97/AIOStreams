import { config as appConfig } from '../config/index.js';
import { createLogger } from '../logging/logger.js';
import {
  SimklAccountRepository,
  type SimklOwner,
  type SimklTokens,
} from '../db/repositories/simkl-accounts.js';

import { simklRequestOf, type SimklPlaybackEvent } from './requests.js';
export * from './requests.js';

const logger = createLogger('simkl');

const API = 'https://api.simkl.com';
const TIMEOUT_MS = 15_000;
/** Refreshed this long before the access token would lapse. */
const REFRESH_EARLY_MS = 24 * 60 * 60 * 1000;
export const SIMKL_SCOPE = 'media:read media:write';

export function simklClientId(): string {
  return appConfig.watchState.simklClientId.trim();
}

export function simklEnabled(): boolean {
  return simklClientId() !== '';
}

function url(path: string): string {
  const u = new URL(path, API);
  u.searchParams.set('client_id', simklClientId());
  u.searchParams.set('app-name', 'aiostreams');
  u.searchParams.set('app-version', appConfig.bootstrap.version);
  return u.toString();
}

interface SimklResponse {
  status: number;
  body: any;
}

async function call(
  path: string,
  init: {
    form?: Record<string, string>;
    json?: unknown;
    token?: string;
    method?: string;
  }
): Promise<SimklResponse> {
  const headers: Record<string, string> = {
    'User-Agent': `AIOStreams/${appConfig.bootstrap.version}`,
    Accept: 'application/json',
  };
  let body: string | undefined;
  if (init.form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(init.form).toString();
  } else if (init.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.json);
  }
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  const res = await fetch(url(path), {
    method: init.method ?? (body === undefined ? 'GET' : 'POST'),
    headers,
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

function errorOf(res: SimklResponse): string {
  const b = res.body;
  return (
    (b &&
      typeof b === 'object' &&
      (b.error_description || b.error || b.message)) ||
    `HTTP ${res.status}`
  );
}

/* ---------------------------------------------------------------- device flow */

export interface SimklDeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

export async function startSimklDevice(): Promise<SimklDeviceCode> {
  const res = await call('/oauth2/device', {
    form: { client_id: simklClientId(), scope: SIMKL_SCOPE },
  });
  const b = res.body;
  if (res.status >= 300 || !b?.device_code)
    throw new Error(`Simkl refused to start linking: ${errorOf(res)}`);
  return {
    deviceCode: b.device_code,
    userCode: b.user_code,
    verificationUri: b.verification_uri,
    verificationUriComplete: b.verification_uri_complete ?? b.verification_uri,
    expiresIn: Number(b.expires_in) || 900,
    interval: Number(b.interval) || 5,
  };
}

export type SimklPollResult =
  | { state: 'pending'; interval?: number }
  | { state: 'expired' }
  | { state: 'linked'; username: string | null }
  | { state: 'error'; error: string };

function tokensFrom(b: any): SimklTokens {
  return {
    accessToken: b.access_token,
    refreshToken: b.refresh_token,
    expiresAt: Date.now() + (Number(b.expires_in) || 7 * 86400) * 1000,
    scope: typeof b.scope === 'string' ? b.scope : '',
  };
}

/** One poll of the token endpoint; links the account when the user approved. */
export async function pollSimklDevice(
  owner: SimklOwner,
  deviceCode: string,
  interval: number
): Promise<SimklPollResult> {
  const res = await call('/oauth2/token', {
    form: {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: simklClientId(),
      device_code: deviceCode,
    },
  });
  const b = res.body;
  if (res.status < 300 && b?.access_token) {
    const tokens = tokensFrom(b);
    if (!tokens.scope.split(/\s+/).includes('media:write'))
      return { state: 'error', error: 'Simkl did not grant write access' };
    const username = await usernameOf(tokens.accessToken);
    await SimklAccountRepository.save(owner, tokens, username);
    return { state: 'linked', username };
  }
  switch (b?.error) {
    case 'authorization_pending':
      return { state: 'pending' };
    case 'slow_down':
      return { state: 'pending', interval: interval + 5 };
    case 'expired_token':
      return { state: 'expired' };
    default:
      return { state: 'error', error: errorOf(res) };
  }
}

async function usernameOf(token: string): Promise<string | null> {
  try {
    const res = await call('/users/settings', { token });
    return res.body?.user?.name ?? null;
  } catch {
    return null;
  }
}

export async function unlinkSimkl(owner: SimklOwner): Promise<void> {
  const tokens = await SimklAccountRepository.tokens(owner).catch(() => null);
  await SimklAccountRepository.remove(owner);
  if (!tokens) return;
  // Best effort: the link is gone here whether or not Simkl hears it.
  await call('/oauth2/revoke', {
    form: { client_id: simklClientId(), token: tokens.refreshToken },
  }).catch(() => undefined);
}

/* ---------------------------------------------------------------- per-owner lane */

/**
 * Every call for one account runs in order. A refresh cancels the previous
 * access token, so two refreshing at once would sign each other out; and the
 * API holds one scrobble per user at a time.
 */
const lanes = new Map<string, Promise<unknown>>();

function inLane<T>(owner: SimklOwner, fn: () => Promise<T>): Promise<T> {
  const key = `${owner.uuid}\u0000${owner.persona}`;
  const prev = lanes.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  lanes.set(key, next);
  void next.finally(() => {
    if (lanes.get(key) === next) lanes.delete(key);
  });
  return next;
}

async function accessToken(owner: SimklOwner): Promise<string | null> {
  const tokens = await SimklAccountRepository.tokens(owner);
  if (!tokens) return null;
  if (tokens.expiresAt - Date.now() > REFRESH_EARLY_MS)
    return tokens.accessToken;
  const res = await call('/oauth2/token', {
    form: {
      grant_type: 'refresh_token',
      client_id: simklClientId(),
      refresh_token: tokens.refreshToken,
    },
  });
  if (res.status < 300 && res.body?.access_token) {
    const next = tokensFrom(res.body);
    // The refresh token slides and may not come back.
    next.refreshToken ||= tokens.refreshToken;
    next.scope ||= tokens.scope;
    await SimklAccountRepository.refreshed(owner, next);
    return next.accessToken;
  }
  if (res.status === 400 || res.status === 401) {
    await SimklAccountRepository.expired(owner, errorOf(res));
    return null;
  }
  // Simkl unreachable: the old token may still be good.
  return tokens.expiresAt > Date.now() ? tokens.accessToken : null;
}

/* ---------------------------------------------------------------- scrobbling */

/**
 * Sends one playback event to the owner's linked Simkl account, if any.
 * Never throws: Simkl must not fail a client's playstate call.
 */
export function scrobbleToSimkl(
  owner: SimklOwner,
  event: SimklPlaybackEvent
): void {
  if (!simklEnabled()) return;
  const request = simklRequestOf(event);
  if (!request) return;
  void inLane(owner, async () => {
    const account = await SimklAccountRepository.get(owner);
    if (!account || account.status !== 'ok') return;
    const token = await accessToken(owner);
    if (!token) return;
    const res = await call(request.path, { json: request.body, token });
    if (res.status === 401) {
      await SimklAccountRepository.expired(owner, errorOf(res));
      return;
    }
    // 409: this session was already completed; 404: Simkl doesn't know the title.
    if (res.status >= 300 && res.status !== 409)
      logger.debug(
        { path: request.path, status: res.status, err: errorOf(res) },
        'simkl rejected an event'
      );
  }).catch((error) =>
    logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      'failed to send an event to simkl'
    )
  );
}
