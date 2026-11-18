import { getDb } from '../db.js';
import { raw, sql } from '../sql.js';
import { decryptString, encryptString } from '../../utils/crypto.js';

/** `expired`: Simkl refused the tokens; the user has to link again. */
export type SimklAccountStatus = 'ok' | 'expired';

export interface SimklOwner {
  uuid: string;
  /** Empty for the account's own user. */
  persona: string;
}

/** What the configure page may see: no tokens. */
export interface SimklAccount extends SimklOwner {
  username: string | null;
  scope: string;
  status: SimklAccountStatus;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Carries the decrypted tokens. Never sent to a client. */
export interface SimklTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms. */
  expiresAt: number;
  scope: string;
}

interface SimklRow {
  uuid: string;
  persona: string;
  username: string | null;
  access_token: string;
  refresh_token: string;
  expires_at: number | string;
  scope: string;
  status: string;
  last_error: string | null;
  created_at: number | string;
  updated_at: number | string;
  [k: string]: unknown;
}

const COLUMNS = raw(
  'uuid, persona, username, access_token, refresh_token, expires_at, scope, status, last_error, created_at, updated_at'
);

function toAccount(row: SimklRow): SimklAccount {
  return {
    uuid: row.uuid,
    persona: row.persona,
    username: row.username,
    scope: row.scope,
    status: row.status === 'expired' ? 'expired' : 'ok',
    lastError: row.last_error,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function seal(value: string): string {
  const out = encryptString(value);
  if (!out.success) throw new Error('Could not encrypt the Simkl token');
  return out.data;
}

function open(value: string): string | null {
  const out = decryptString(value);
  return out.success ? out.data : null;
}

export class SimklAccountRepository {
  static async get(owner: SimklOwner): Promise<SimklAccount | null> {
    const row = await getDb().maybeOne<SimklRow>(
      sql`SELECT ${COLUMNS} FROM simkl_accounts
           WHERE uuid = ${owner.uuid} AND persona = ${owner.persona}`
    );
    return row ? toAccount(row) : null;
  }

  /** The tokens, or null when unlinked or they no longer decrypt. */
  static async tokens(owner: SimklOwner): Promise<SimklTokens | null> {
    const row = await getDb().maybeOne<SimklRow>(
      sql`SELECT ${COLUMNS} FROM simkl_accounts
           WHERE uuid = ${owner.uuid} AND persona = ${owner.persona}`
    );
    if (!row) return null;
    const accessToken = open(row.access_token);
    const refreshToken = open(row.refresh_token);
    if (!accessToken || !refreshToken) return null;
    return {
      accessToken,
      refreshToken,
      expiresAt: Number(row.expires_at),
      scope: row.scope,
    };
  }

  /** Links (or relinks) the account, which is then `ok`. */
  static async save(
    owner: SimklOwner,
    tokens: SimklTokens,
    username: string | null
  ): Promise<void> {
    const now = Date.now();
    await getDb().exec(
      sql`INSERT INTO simkl_accounts
            (uuid, persona, username, access_token, refresh_token, expires_at,
             scope, status, last_error, created_at, updated_at)
          VALUES (${owner.uuid}, ${owner.persona}, ${username},
                  ${seal(tokens.accessToken)}, ${seal(tokens.refreshToken)},
                  ${tokens.expiresAt}, ${tokens.scope}, 'ok', NULL, ${now}, ${now})
          ON CONFLICT (uuid, persona) DO UPDATE SET
            username = EXCLUDED.username,
            access_token = EXCLUDED.access_token,
            refresh_token = EXCLUDED.refresh_token,
            expires_at = EXCLUDED.expires_at,
            scope = EXCLUDED.scope,
            status = 'ok',
            last_error = NULL,
            updated_at = EXCLUDED.updated_at`
    );
  }

  /** New tokens from a refresh; the account stays as it is otherwise. */
  static async refreshed(
    owner: SimklOwner,
    tokens: SimklTokens
  ): Promise<void> {
    await getDb().exec(
      sql`UPDATE simkl_accounts SET
            access_token = ${seal(tokens.accessToken)},
            refresh_token = ${seal(tokens.refreshToken)},
            expires_at = ${tokens.expiresAt},
            scope = ${tokens.scope},
            status = 'ok',
            last_error = NULL,
            updated_at = ${Date.now()}
          WHERE uuid = ${owner.uuid} AND persona = ${owner.persona}`
    );
  }

  static async expired(owner: SimklOwner, error: string): Promise<void> {
    await getDb().exec(
      sql`UPDATE simkl_accounts SET status = 'expired', last_error = ${error},
            updated_at = ${Date.now()}
          WHERE uuid = ${owner.uuid} AND persona = ${owner.persona}`
    );
  }

  static async remove(owner: SimklOwner): Promise<boolean> {
    const { rowCount } = await getDb().exec(
      sql`DELETE FROM simkl_accounts
           WHERE uuid = ${owner.uuid} AND persona = ${owner.persona}`
    );
    return rowCount > 0;
  }
}
