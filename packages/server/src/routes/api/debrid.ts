import { Router, Request, Response, NextFunction } from 'express';
import {
  APIError,
  constants,
  createLogger,
  createProxy,
  DebridError,
  decodeFallbackKey,
  decodeFileInfo,
  describeChainItem,
  getPlayChain,
  parsePlaybackUrl,
  resolvePlaybackTarget,
  resolveExternalTarget,
  runPlayChain,
  getSimpleTextHash,
  DistributedLock,
  type FailoverAttempt,
  type FailoverContentType,
  type PlayChainItem,
  type PlaybackTarget,
  maskSensitiveInfo,
  onPlay,
  withPlayPath,
  probeResolvedLink,
  USENET_STREAM_PATH_PREFIX,
} from '@aiostreams/core';
import { ZodError } from 'zod';
import { StaticFiles, sendPlaybackError } from '../../utils/static-errors.js';
import { corsMiddleware } from '../../middlewares/cors.js';
const router: Router = Router();
const logger = createLogger('server');

/**
 * Links resolved by a playback check from AIOStreams' own apps, by playback
 * path and client, for the player's request that follows it.
 */
interface CheckedPlayback {
  url: string;
  played?: { target: PlaybackTarget; url: string };
  viaProxy: boolean;
  expires: number;
}
const CHECKED_TTL_MS = 2 * 60_000;
const checked = new Map<string, CheckedPlayback>();

function takeChecked(key: string): CheckedPlayback | undefined {
  const now = Date.now();
  for (const [k, v] of checked) if (v.expires <= now) checked.delete(k);
  const hit = checked.get(key);
  checked.delete(key);
  return hit;
}

router.use(corsMiddleware);

// block HEAD requests
router.use((req: Request, res: Response, next: NextFunction) => {
  if (req.method === 'HEAD') {
    res.status(405).send('Method not allowed');
  } else {
    next();
  }
});

interface PlaybackParams {
  encryptedStoreAuth: string;
  fallbackKey?: string;
  fileInfo: string;
  metadataId: string;
  filename: string;
}

router.get(
  [
    '/playback/:encryptedStoreAuth/:fallbackKey/:fileInfo/:metadataId/:filename',
    // Legacy
    '/playback/:encryptedStoreAuth/:fileInfo/:metadataId/:filename',
  ],
  async (req: Request<PlaybackParams>, res: Response, next: NextFunction) => {
    try {
      const {
        encryptedStoreAuth,
        fallbackKey,
        fileInfo: fileInfoRaw,
        metadataId,
        filename,
      } = req.params;

      // Validate the clicked item decodes (preserves the 400 contract) and tells
      // us which kind it is for cross-type filtering.
      const fileInfo = await decodeFileInfo(fileInfoRaw);
      if (!fileInfo) {
        next(
          new APIError(
            constants.ErrorCode.BAD_REQUEST,
            undefined,
            'Failed to parse file info and not found in store.'
          )
        );
        return;
      }
      const clickedType: FailoverContentType =
        fileInfo.type === 'usenet' ? 'usenet' : 'debrid';

      const decodedFbk = decodeFallbackKey(fallbackKey);
      const chain = decodedFbk
        ? await getPlayChain(decodedFbk, clickedType)
        : undefined;
      const fallbacks = chain?.fallbacks ?? [];
      const hasFailover = fallbacks.length > 0;

      if (!hasFailover && !decodedFbk) {
        logger.debug(
          { clickedType, hasFallbackKey: !!fallbackKey },
          'clicked item has no failover chain reference'
        );
      }

      const clientIp = req.userIp;
      // Where this sends a player on, our own routes learn it came from the
      // Jellyfin path too, so they also answer AIOStreams' apps with real errors.
      const toPlayPath = (url: string) =>
        req.query[constants.PLAY_PATH_MARKER] === 'jellyfin'
          ? withPlayPath(url, 'jellyfin')
          : url;

      // AIOStreams' own apps ask first, and are answered with the error rather
      // than an error video; the player's request then takes what they found.
      const checking = req.query[constants.PLAYBACK_CHECK_MARKER] !== undefined;
      const checkKey = `${req.path}|${clientIp ?? '-'}`;
      const found = checking ? undefined : takeChecked(checkKey);
      if (found) {
        logger.debug(
          { url: maskSensitiveInfo(found.url) },
          'playing the link a playback check resolved'
        );
        res.setHeader('Cache-Control', 'no-store');
        res.redirect(307, toPlayPath(found.url));
        if (found.played) {
          void onPlay({
            path:
              req.query[constants.PLAY_PATH_MARKER] === 'jellyfin'
                ? 'jellyfin'
                : 'stremio',
            target: found.played.target,
            resolvedUrl: found.played.url,
            viaProxy: found.viaProxy,
          });
        }
        return;
      }

      const arrivedViaOurProxy = !!req.query[constants.INTERNAL_PROXY_MARKER];
      const playPath =
        req.query[constants.PLAY_PATH_MARKER] === 'jellyfin'
          ? 'jellyfin'
          : 'stremio';
      const proxyConfig = chain?.proxyConfig;

      // Wrap a resolved (CDN) URL in a proxy URL when the source item should be
      // proxied and we didn't arrive via our proxy. Fail-open to the raw URL.
      const maybeProxy = async (
        resolvedUrl: string | undefined,
        itemProxied: boolean | undefined
      ): Promise<string | undefined> => {
        if (!resolvedUrl) return resolvedUrl; // still downloading
        if (arrivedViaOurProxy || !itemProxied || !proxyConfig?.enabled) {
          return resolvedUrl;
        }
        if (resolvedUrl.includes(constants.BUILTIN_PROXY_PATH_PREFIX)) {
          return resolvedUrl;
        }
        try {
          const out = await createProxy(proxyConfig).generateUrls([
            { url: resolvedUrl, filename, type: 'stream' },
          ]);
          if (Array.isArray(out) && out[0]) return out[0];
          logger.warn(
            { err: out && 'error' in out ? out.error : 'no url returned' },
            'failed to proxy failover-resolved url; serving raw url'
          );
        } catch (err: any) {
          logger.warn(
            { err: err?.message ?? String(err) },
            'error proxying failover-resolved url; serving raw url'
          );
        }
        return resolvedUrl; // fail-open
      };

      // Served URL -> what it resolved from, for the media info probe.
      const resolvedFrom = new Map<
        string,
        { target: PlaybackTarget; url: string }
      >();
      const resolveOwned = async (
        target: PlaybackTarget,
        proxied: boolean | undefined,
        signal?: AbortSignal
      ): Promise<string | undefined> => {
        const url = await resolvePlaybackTarget(target, { clientIp }, signal);
        const served = await maybeProxy(url, proxied);
        if (url && served) resolvedFrom.set(served, { target, url });
        return served;
      };

      // Resolve a chain item (or variant), branching on owned vs external, then
      // proxying the result when configured.
      const resolveTarget =
        (item: PlayChainItem) =>
        async (signal?: AbortSignal): Promise<string | undefined> => {
          if (item.kind === 'external') {
            return resolveExternalTarget(item.url, { clientIp }, signal).then(
              (url) => maybeProxy(url, item.proxied)
            );
          }
          const target = parsePlaybackUrl(item.url);
          return target
            ? resolveOwned(target, item.proxied, signal)
            : Promise.reject(new Error('unparseable fallback url'));
        };

      const attempts: FailoverAttempt[] = [
        {
          label: chain?.clicked
            ? describeChainItem(chain.clicked, 'clicked')
            : describeChainItem({ type: clickedType, filename }, 'clicked'),
          rank: 0,
          resolve: (signal) =>
            resolveOwned(
              { encryptedStoreAuth, fileInfoRaw, metadataId, filename },
              chain?.clickedProxied,
              signal
            ),
        },
        ...fallbacks.map((f): FailoverAttempt => ({
          label: describeChainItem(f),
          rank: f.rank,
          resolve: resolveTarget(f),
        })),
      ];

      const runCfg = {
        parallel: chain?.parallel ?? 1,
        staggerMs: chain?.staggerMs ?? 0,
        preferredGraceMs: chain?.preferredGraceMs ?? 0,
        maxWaitMs: chain?.maxWaitMs ?? 60_000,
        duplicateStaggerMs: chain?.duplicateStaggerMs ?? 0,
      };

      if (hasFailover) {
        logger.info(
          {
            attempts: attempts.length,
            parallel: runCfg.parallel,
            clickedType,
            chain: attempts.map((a, i) => {
              const label = a.label ?? 'unknown';
              // Index 0 is the clicked item, the fallbacks follow in order.
              // Variants are indented under the release they belong to.
              return i > 0 && fallbacks[i - 1]?.isVariant
                ? `  ↳ ${label}`
                : label;
            }),
          },
          'resolving failover chain'
        );
      } else {
        logger.debug(
          { clickedType, attempt: attempts[0].label },
          'no failover targets; resolving the clicked item only'
        );
      }

      const run = () => runPlayChain(attempts, runCfg);

      // Share one running chain across concurrent requests for the same click.
      const result = hasFailover
        ? (
            await DistributedLock.getInstance().withLock(
              `failover:${getSimpleTextHash(
                encryptedStoreAuth + metadataId + filename + fallbackKey
              )}:${clientIp ?? '-'}`,
              run,
              {
                timeout: Math.max(runCfg.maxWaitMs, 180_000),
                ttl: Math.max(runCfg.maxWaitMs, 185_000),
              }
            )
          ).result
        : await run();

      if (result.error) {
        const err = result.error;
        // A malformed clicked item with no chain to fall back to is a 400,
        // not a static video.
        if (
          err instanceof DebridError &&
          err.code === 'BAD_REQUEST' &&
          !hasFailover
        ) {
          next(
            new APIError(
              constants.ErrorCode.BAD_REQUEST,
              undefined,
              err.message
            )
          );
          return;
        }
        if (err instanceof DebridError) {
          logger.error({ err }, `error during debrid resolve: ${err.message}`);
          sendPlaybackError(req, res, { code: err.code, message: err.message });
          return;
        }
        logger.error(
          { err },
          `got unknown error during debrid resolve: ${err.message}`
        );
        sendPlaybackError(req, res, {
          code: 'INTERNAL_SERVER_ERROR',
          message: err.message,
          file: StaticFiles.INTERNAL_SERVER_ERROR,
        });
        return;
      }

      if (!result.url) {
        sendPlaybackError(req, res, {
          code: 'DOWNLOADING',
          message: 'Still downloading to the service; try again shortly.',
          file: StaticFiles.DOWNLOADING,
        });
        return;
      }

      const played = resolvedFrom.get(result.url);
      if (checking) {
        // A service can hand back a link that's dead, expired or its own error
        // clip: the check opens it. Our own routes (usenet engine, proxy) check
        // their releases themselves.
        const link = played?.url ?? result.url;
        const ours =
          link.includes(USENET_STREAM_PATH_PREFIX) ||
          link.includes(constants.BUILTIN_PROXY_PATH_PREFIX);
        const problem = ours
          ? null
          : await probeResolvedLink(link, { clientIp });
        if (problem) {
          logger.info({ problem }, 'playback check: resolved link won’t play');
          sendPlaybackError(req, res, {
            code: 'DOWNLOAD_FAILED',
            message: `This version can't be played: ${problem}.`,
          });
          return;
        }
        // The player's own request comes next: it takes this rather than
        // resolving the release again.
        checked.set(checkKey, {
          url: result.url,
          played,
          viaProxy:
            arrivedViaOurProxy ||
            result.url.includes(constants.BUILTIN_PROXY_PATH_PREFIX),
          expires: Date.now() + CHECKED_TTL_MS,
        });
        res.setHeader('Cache-Control', 'no-store');
        res.json({ ok: true });
        return;
      }

      logger.debug(
        {
          url: maskSensitiveInfo(result.url),
          label: result.label,
          failedOver: result.failedOver,
        },
        'Debrid resolve succeeded, redirecting'
      );

      res.setHeader('Cache-Control', 'no-store');
      res.redirect(307, toPlayPath(result.url));

      if (played) {
        void onPlay({
          path: playPath,
          target: played.target,
          resolvedUrl: played.url,
          viaProxy:
            arrivedViaOurProxy ||
            result.url.includes(constants.BUILTIN_PROXY_PATH_PREFIX),
        });
      }
    } catch (error: any) {
      if (error instanceof APIError || error instanceof ZodError) {
        next(error);
      } else {
        logger.error(
          { err: error },
          `got unexpected error during debrid resolve: ${error.message}`
        );
        next(
          new APIError(
            constants.ErrorCode.INTERNAL_SERVER_ERROR,
            undefined,
            error.message
          )
        );
      }
    }
  }
);

export default router;
