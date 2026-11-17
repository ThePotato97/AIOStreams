import type { Migration } from './types.js';

/**
 * A Simkl account linked to a user (and persona), which their playback is
 * scrobbled to. The tokens are encrypted with the server's key; the rest is
 * what the configure page shows.
 */
const ddl = (int: string) => `
      CREATE TABLE IF NOT EXISTS simkl_accounts (
        uuid              TEXT NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
        persona           TEXT NOT NULL,
        username          TEXT,
        access_token      TEXT NOT NULL,
        refresh_token     TEXT NOT NULL,
        expires_at        ${int} NOT NULL,
        scope             TEXT NOT NULL,
        status            TEXT NOT NULL,
        last_error        TEXT,
        created_at        ${int} NOT NULL,
        updated_at        ${int} NOT NULL,
        PRIMARY KEY (uuid, persona)
      );
`;

export const simklAccounts: Migration = {
  id: 51,
  name: 'simkl_accounts',
  up: { sqlite: ddl('INTEGER'), postgres: ddl('BIGINT') },
};
