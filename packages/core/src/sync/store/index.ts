import { config as appConfig } from '../../config/index.js';
import { Cache } from '../../utils/cache.js';
import { getDb } from '../../db/db.js';
import { backendFor } from './persisted.js';
import { RedisBackend } from './redis.js';
import type { SharedBackend } from './types.js';

export * from './types.js';

let backend: SharedBackend | undefined;

/**
 * In Redis when the server has it, so its replicas share parties; otherwise in this process,
 * kept in the server's database so it outlasts a restart.
 */
export function sharedBackend(): SharedBackend {
  return (backend ??= backendFor(
    appConfig.bootstrap.redisUri,
    () => new RedisBackend(() => Cache.getRedisClient()),
    getDb
  ));
}
