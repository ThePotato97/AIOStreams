import { Router, type Request, type Response } from 'express';
import {
  Cache,
  pollSimklDevice,
  SimklAccountRepository,
  simklEnabled,
  startSimklDevice,
  unlinkSimkl,
  type SimklOwner,
} from '@aiostreams/core';
import { jf, type JellyfinRequestContext } from './context.js';

/*
 * Simkl is linked per signed-in user: the account and its personas each have
 * their own link, except that a persona sharing the account's history shares
 * its link too (that is what `ctx.watch` resolves to). Party guests and share
 * links never report playback, so they never reach Simkl.
 */

const router: Router = Router();

interface PendingLink {
  deviceCode: string;
  interval: number;
  expiresAt: number;
  nextPollAt: number;
}

/** The device code stays on the server; the page only polls. */
const pending = Cache.getInstance<string, PendingLink>('simkl-device', 1000);

function keyOf(owner: SimklOwner): string {
  return `${owner.uuid}:${owner.persona}`;
}

function signedIn(
  handler: (
    req: Request,
    res: Response,
    ctx: JellyfinRequestContext
  ) => Promise<void>
) {
  return jf(async (req, res, ctx) => {
    if (ctx.apiKey) {
      res.status(403).json({ Message: 'Not available to API keys' });
      return;
    }
    if (!simklEnabled()) {
      res.status(404).json({ Message: 'Simkl is not set up on this server' });
      return;
    }
    await handler(req, res, ctx);
  });
}

router.get(
  '/AIOStreams/Simkl',
  jf(async (_req, res, ctx) => {
    if (!simklEnabled()) {
      res.json({ available: false, account: null });
      return;
    }
    const account = await SimklAccountRepository.get(ctx.watch);
    res.json({
      available: true,
      account: account && {
        username: account.username,
        status: account.status,
        lastError: account.lastError,
        linkedAt: account.createdAt,
      },
    });
  })
);

router.post(
  '/AIOStreams/Simkl/Link',
  signedIn(async (_req, res, ctx) => {
    const code = await startSimklDevice();
    const now = Date.now();
    await pending.set(
      keyOf(ctx.watch),
      {
        deviceCode: code.deviceCode,
        interval: code.interval,
        expiresAt: now + code.expiresIn * 1000,
        nextPollAt: now + code.interval * 1000,
      },
      code.expiresIn
    );
    res.json({
      userCode: code.userCode,
      verificationUri: code.verificationUri,
      verificationUriComplete: code.verificationUriComplete,
      expiresIn: code.expiresIn,
      interval: code.interval,
    });
  })
);

/* The page calls this every few seconds; it asks Simkl at most at Simkl's pace. */
router.post(
  '/AIOStreams/Simkl/Link/Poll',
  signedIn(async (_req, res, ctx) => {
    const key = keyOf(ctx.watch);
    const link = await pending.get(key);
    const now = Date.now();
    if (!link || now >= link.expiresAt) {
      await pending.delete(key);
      res.json({ state: 'expired' });
      return;
    }
    if (now < link.nextPollAt) {
      res.json({ state: 'pending', interval: link.interval });
      return;
    }
    const result = await pollSimklDevice(
      ctx.watch,
      link.deviceCode,
      link.interval
    );
    if (result.state === 'pending') {
      const interval = result.interval ?? link.interval;
      await pending.set(
        key,
        { ...link, interval, nextPollAt: now + interval * 1000 },
        Math.max(1, Math.ceil((link.expiresAt - now) / 1000))
      );
      res.json({ state: 'pending', interval });
      return;
    }
    await pending.delete(key);
    res.json(result);
  })
);

router.delete(
  '/AIOStreams/Simkl/Link',
  signedIn(async (_req, res, ctx) => {
    await pending.delete(keyOf(ctx.watch));
    await unlinkSimkl(ctx.watch);
    res.status(204).end();
  })
);

export default router;
