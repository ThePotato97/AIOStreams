import http from 'node:http';
import https from 'node:https';
import { randomBytes } from 'node:crypto';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** What a reader of the source gets of AIOStreams' answer. */
const PASSED = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'etag',
  'last-modified',
];
/** The file's whole size, from a 206's Content-Range or a whole 200's Content-Length. */
function sizeOf(res) {
  const range = /\/(\d+)$/.exec(String(res.headers['content-range'] ?? ''));
  if (range) return Number(range[1]);
  if (res.statusCode === 200 && res.headers['content-length'] != null)
    return Number(res.headers['content-length']);
  return null;
}
/** `bytes=N-` or `bytes=N-M`; anything else reads the whole file. */
function parseRange(header) {
  const m = /^bytes=(\d+)-(\d*)$/.exec(String(header ?? ''));
  return m ? { start: Number(m[1]), end: m[2] ? Number(m[2]) : null } : null;
}

/**
 * Where FFmpeg reads a source: a local pass-through to AIOStreams' `/source/<handle>`.
 *
 * FFmpeg's own reconnects back off (0, 1, 3, 7, 15, 31, 63 s), so after AIOStreams restarts it
 * can stay silent for up to a minute after AIOStreams is back. Here, while AIOStreams can't be
 * reached (or answers 5xx and its source status isn't `failed`), the request is held open and
 * tried again every second, up to `maxWaitMs`; a response cut part-way is reopened at the byte
 * already sent, provided the file is still the same (its size, and its ETag where it has one).
 * FFmpeg sees one continuous response. What can't go on is recorded as the source's failure
 * (`failure(input)`), and FFmpeg's request is failed.
 *
 * @param {{
 *   status: (input: string) => Promise<{ state: string }>,
 *   onWaiting?: (input: string, waiting: boolean) => void,
 *   retryMs?: number,
 *   maxWaitMs?: number,
 * }} options
 */
export function createPassThrough({
  status,
  onWaiting = () => {},
  retryMs = 1000,
  maxWaitMs = 120_000,
}) {
  /** id → { input, failure? }; one id per source. */
  const byId = new Map();
  const byInput = new Map();
  const server = http.createServer((req, res) => {
    serve(req, res).catch(() => res.destroy());
  });
  /** Listening: the process starts it long before any job asks for a URL. */
  const ready = new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(undefined))
  );
  server.unref();

  /** One request to AIOStreams, from `offset`; rejects when AIOStreams can't be reached. */
  function open(input, method, offset, end) {
    const url = new URL(input);
    const headers = {};
    if (offset > 0 || end !== null)
      headers.range = `bytes=${offset}-${end ?? ''}`;
    return new Promise((resolve, reject) => {
      const req = (url.protocol === 'https:' ? https : http).request(
        url,
        { method, headers },
        resolve
      );
      req.on('error', reject);
      req.end();
    });
  }

  /** Sends what AIOStreams sends until it ends (`complete`), is cut (`cut`), or FFmpeg goes. */
  function pump(up, res, sent) {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (how) => {
        if (settled) return;
        settled = true;
        res.off('close', gone);
        resolve(how);
      };
      const gone = () => settle('closed');
      res.on('close', gone);
      up.on('data', (chunk) => {
        sent(chunk.length);
        if (!res.write(chunk)) {
          up.pause();
          res.once('drain', () => up.resume());
        }
      });
      up.on('end', () => settle(up.complete ? 'complete' : 'cut'));
      up.on('aborted', () => settle('cut'));
      up.on('error', () => settle('cut'));
      up.on('close', () => settle(up.complete ? 'complete' : 'cut'));
    });
  }

  async function serve(req, res) {
    const entry = byId.get(String(req.url).replace(/^\/s\//, ''));
    if (!entry) return void res.writeHead(404).end();
    if (!['GET', 'HEAD'].includes(req.method ?? ''))
      return void res.writeHead(405).end();
    const range = parseRange(req.headers.range);
    let offset = range?.start ?? 0;
    const end = range?.end ?? null;
    let closed = false;
    res.on('close', () => (closed = true));
    /** The first answer's file: what a reopened read must still be. */
    let first = null;
    let waitingSince = null;
    const failWith = (failure) => {
      entry.failure = failure;
      if (res.headersSent) res.destroy();
      else res.writeHead(failure.status ?? 502).end();
    };
    /** Waits a second for AIOStreams, unless the source failed or it's been too long. */
    const wait = async () => {
      if (waitingSince === null) {
        waitingSince = Date.now();
        onWaiting(entry.input, true);
      }
      if (Date.now() - waitingSince >= maxWaitMs) {
        failWith({
          state: 'failed',
          class: 'source',
          status: 502,
          code: 'source_unreachable',
          message: 'AIOStreams did not answer for the source',
        });
        return false;
      }
      const now = await status(entry.input).catch(() => ({ state: 'unknown' }));
      if (now.state === 'failed') {
        failWith(now);
        return false;
      }
      await sleep(retryMs);
      return !closed;
    };
    for (;;) {
      if (closed) return;
      let up;
      try {
        up = await open(entry.input, req.method, offset, end);
      } catch {
        if (!(await wait())) return;
        continue;
      }
      if (closed) return void up.destroy();
      if (up.statusCode >= 500) {
        up.resume();
        if (!(await wait())) return;
        continue;
      }
      if (waitingSince !== null) {
        waitingSince = null;
        onWaiting(entry.input, false);
      }
      if (!first) {
        // Refused (a handle AIOStreams no longer knows), or only asked about: as it is.
        if (up.statusCode >= 300 || req.method === 'HEAD') {
          const headers = {};
          for (const name of PASSED)
            if (up.headers[name] != null) headers[name] = up.headers[name];
          res.writeHead(up.statusCode, headers);
          if (req.method === 'HEAD') {
            up.resume();
            return void res.end();
          }
          up.pipe(res);
          return;
        }
        first = { size: sizeOf(up), etag: up.headers.etag ?? null };
        entry.failure = undefined;
        const headers = {};
        for (const name of PASSED)
          if (up.headers[name] != null) headers[name] = up.headers[name];
        res.writeHead(up.statusCode, headers);
      } else if (
        up.statusCode !== 206 ||
        sizeOf(up) !== first.size ||
        (first.etag !== null && up.headers.etag !== first.etag)
      ) {
        up.destroy();
        return failWith({
          state: 'failed',
          class: 'source',
          status: 502,
          code: 'source_failed',
          message: 'The source changed while it was read',
        });
      }
      const how = await pump(up, res, (n) => (offset += n));
      if (how === 'complete') return void res.end();
      up.destroy();
      if (how === 'closed') return;
      // Cut part-way: read on from here, if the file says how big it is.
      if (first.size === null) return void res.destroy();
    }
  }

  return {
    ready,
    /** The local URL FFmpeg reads `input` (AIOStreams' source URL) at. */
    url(input) {
      let id = byInput.get(input);
      if (!id) {
        id = randomBytes(16).toString('hex');
        byInput.set(input, id);
        byId.set(id, { input });
      }
      const address = /** @type {import('node:net').AddressInfo | null} */ (
        server.address()
      );
      if (!address) throw Error('The source pass-through is not listening yet');
      const { port } = address;
      return `http://127.0.0.1:${port}/s/${id}`;
    },
    /** Why reading `input` last failed here, if it did and nothing has been read since. */
    failure(input) {
      const id = byInput.get(input);
      return id ? byId.get(id)?.failure : undefined;
    },
    /** Forgets a source no job reads any more. */
    forget(input) {
      const id = byInput.get(input);
      if (!id) return;
      byInput.delete(input);
      byId.delete(id);
    },
    close() {
      server.close();
    },
  };
}
