import type express from 'express';

/** CORS for the Jellyfin-style API and the app requests beside it. */
export const jellyfinCors: express.RequestHandler = (req, res, next) => {
  // The global middleware sets Allow-Credentials, which browsers reject
  // alongside a wildcard origin, so echo the caller's origin when it has one.
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET, POST, PUT, DELETE, HEAD, OPTIONS'
  );
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Emby-Authorization, X-Emby-Token, X-MediaBrowser-Token, Range, X-AIOStreams-Client, X-AIOStreams-Device, X-AIOStreams-Platform, X-AIOStreams-Network, X-AIOStreams-Purpose'
  );
  res.setHeader(
    'Access-Control-Expose-Headers',
    'Content-Length, Content-Range, Retry-After'
  );
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Max-Age', '86400');
    res.status(204).end();
    return;
  }
  next();
};
