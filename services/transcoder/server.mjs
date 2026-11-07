import http from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm, readFile, stat, readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import {
  metadata,
  ffmpegArgs,
  select,
  manifestReady,
  manifestStart,
  subtitleKind,
  videoCodec,
  withFullDuration,
  withVideoCodec,
} from './media.mjs';

const exec = promisify(execFile);
const secret = process.env.TRANSCODER_SECRET ?? '';
const root = process.env.CACHE_DIR ?? '/tmp/aiostreams-transcoder';
/** Conversions that encode video, which load the CPU or GPU. */
const limit = Math.max(1, Number(process.env.TRANSCODER_MAX_JOBS ?? 2));
/** All conversions: copying video and converting audio costs little. */
const copyLimit = Math.max(
  limit,
  Number(process.env.TRANSCODER_MAX_COPY_JOBS ?? 8)
);
const maxBytes = Math.max(
  1024 * 1024,
  Number(process.env.TRANSCODER_CACHE_BYTES ?? 10 * 1024 ** 3)
);
/** Exported for tests. */
export const jobs = new Map();
const probes = new Map();
const pending = new Map();
/** Extracted subtitles and fonts: key → { path, ready, error }. */
const extracted = new Map();
let extractions = 0;
/** At most this many files are kept; the oldest goes first. */
const EXTRACTED_FILES = 32;
/** Reading a whole remote file for its subtitles can take a while. */
const EXTRACTION_TIMEOUT_MS = 30 * 60_000;
const SUBTITLE_FORMATS = {
  vtt: { kind: 'text', muxer: 'webvtt', codec: [], type: 'text/vtt' },
  ass: {
    kind: 'ass',
    muxer: 'ass',
    codec: ['-c:s', 'copy'],
    type: 'text/x-ssa',
  },
  sup: {
    kind: 'pgs',
    muxer: 'sup',
    codec: ['-c:s', 'copy'],
    type: 'application/octet-stream',
  },
};
let cacheBytes = 0;
const maximumPosition = (job) =>
  Math.max(0, ...[...job.viewers.values()].map((v) => v.positionMs));
const id = () => randomBytes(24).toString('base64url');
const hash = (value) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
function authorized(req) {
  const got = Buffer.from(req.headers.authorization ?? '');
  const expected = Buffer.from(`Bearer ${secret}`);
  return (
    !!secret && got.length === expected.length && timingSafeEqual(got, expected)
  );
}
function inputUrl(value) {
  const url = new URL(value);
  const allowed = new URL(
    process.env.AIOSTREAMS_INTERNAL_URL ?? 'http://aiostreams:3000'
  );
  if (
    url.origin !== allowed.origin ||
    !url.pathname.startsWith(
      `${allowed.pathname.replace(/\/$/, '')}/party/guest/source/`
    ) ||
    url.username ||
    url.password
  )
    throw Error('Invalid source handle');
  return url.href;
}
/**
 * Why ffprobe failed, safe to pass on: its last error line with every URL
 * replaced. ffprobe only ever sees AIOStreams' source handle, but a handle is
 * still a credential, and nothing upstream belongs in an error.
 */
/** A native error's code and operation, the only parts safe to pass on. */
export function mediaError(error) {
  const code = /^[A-Z0-9_]+$/.test(String(error?.code ?? ''))
    ? error.code
    : undefined;
  const syscall = /^[a-z]+$/.test(String(error?.syscall ?? ''))
    ? error.syscall
    : undefined;
  const detail = [code, syscall].filter(Boolean).join(' in ');
  return detail
    ? `Media operation failed (${detail})`
    : 'Media operation failed';
}
export function probeFailure(error) {
  if (error?.killed || error?.signal === 'SIGTERM')
    return 'Source probe timed out';
  const line =
    String(error?.stderr ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .pop() ?? '';
  const reason = line
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+?(?=:?\s|:?$)/gi, 'source')
    .replace(/^source:\s*/i, '')
    .slice(0, 160);
  return reason ? `Source probe failed: ${reason}` : 'Source probe failed';
}
async function json(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 65536) throw Error('Request too large');
  }
  return JSON.parse(text || '{}');
}
async function probe(input) {
  inputUrl(input);
  if (!probes.has(input)) {
    const task = exec(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_format',
        '-show_streams',
        '-show_chapters',
        '-of',
        'json',
        input,
      ],
      // AIOStreams retries once and must answer within Cloudflare's 100 s.
      { timeout: 30000, maxBuffer: 4 * 1024 * 1024 }
    )
      .then(({ stdout }) => metadata(JSON.parse(stdout)))
      .catch((error) => {
        probes.delete(input);
        throw Error(probeFailure(error));
      });
    probes.set(input, task);
    if (probes.size > 200) probes.delete(probes.keys().next().value);
  }
  return probes.get(input);
}
const running = (child) =>
  !!child && child.exitCode === null && child.signalCode === null;
/**
 * Stops a job's FFmpeg and resolves once it has exited: SIGTERM, then SIGKILL
 * after 3 s. Its files can only be removed after that, since FFmpeg still
 * writes the last segment and playlist while it shuts down.
 */
export function stop(job) {
  const child = job.child;
  if (!running(child)) return Promise.resolve();
  const exited = new Promise((resolve) => child.once('exit', resolve));
  if (job.paused) child.kill('SIGCONT');
  child.kill('SIGTERM');
  const timer = setTimeout(() => {
    if (running(child)) child.kill('SIGKILL');
  }, 3000);
  timer.unref();
  return exited.finally(() => clearTimeout(timer));
}
const removeDir = (dir) =>
  rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
/** Forgets a job, waits for its FFmpeg to exit, then removes its files. */
export async function drop(job) {
  jobs.delete(job.id);
  await stop(job);
  await removeDir(job.dir);
}
/**
 * Starts FFmpeg for a job. A GPU conversion that fails before its first
 * segment runs again with the tone map on the CPU (an HDR source), then all
 * on the CPU.
 */
function start(job, encoder, tonemap = 'gpu') {
  const command = ffmpegArgs(
    job.input,
    job.meta,
    job.request,
    job.dir,
    encoder,
    { tonemap }
  );
  job.offsetMs = command.offsetMs;
  job.mode = command.policy.mode;
  job.reasons = {
    video: command.policy.videoReason,
    audio: command.policy.audioReason,
  };
  job.encoder = encoder;
  job.tonemap = command.tonemap;
  const args = [...command.args];
  args.splice(args.length - 1, 0, '-progress', 'pipe:3');
  const child = spawn('ffmpeg', args, {
    stdio: ['ignore', 'ignore', 'pipe', 'pipe'],
  });
  job.child = child;
  let progress = '';
  child.stdio[3].on('data', (chunk) => {
    progress += chunk;
    const lines = progress.split('\n');
    progress = lines.pop() ?? '';
    for (const line of lines) {
      if (line.startsWith('speed=')) job.speed = line.slice(6);
      if (line.startsWith('out_time_us=')) {
        job.producedMs = job.offsetMs + Number(line.slice(12)) / 1000;
        if (!job.paused && job.producedMs > maximumPosition(job) + 120000) {
          child.kill('SIGSTOP');
          job.paused = true;
        }
      }
    }
  });
  // Do not log FFmpeg stderr: it can contain credentials from upstream errors.
  child.stderr.resume();
  child.on('error', () => {
    job.error = 'FFmpeg could not start';
  });
  child.on('exit', async (code) => {
    if (!jobs.has(job.id) || job.child !== child) return;
    job.child = null;
    if (code !== 0 && encoder !== 'cpu' && !job.ready) {
      await rm(job.dir, { recursive: true, force: true });
      await mkdir(job.dir, { recursive: true });
      if (!jobs.has(job.id)) return;
      if (command.tonemap === 'gpu') start(job, encoder, 'cpu');
      else start(job, 'cpu');
    } else if (code !== 0) job.error = 'Conversion failed';
    // A clean exit well before the end: the source stopped sending.
    else if (stoppedEarly(job)) job.error = 'The source stopped before the end';
    else job.finished = true;
  });
}
/**
 * Starts writing a file with FFmpeg, once per key. Until it's written the
 * caller is told to come back: reading a whole remote file can take
 * minutes, more than a request should wait.
 */
function extract(key, args) {
  const id = hash(key);
  const known = extracted.get(id);
  if (known && !known.error) return known;
  if (extractions >= 2) {
    const error = Error('Subtitle extraction capacity reached');
    error.status = 503;
    error.retryAfter = 10;
    throw error;
  }
  const entry = { path: `${root}/extracted/${id}`, ready: false, error: null };
  extracted.set(id, entry);
  extractions++;
  void mkdir(`${root}/extracted`, { recursive: true })
    .then(() =>
      exec('ffmpeg', args(entry.path), {
        timeout: EXTRACTION_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      }).catch(async (error) => {
        // dump_attachment writes its file, then exits for want of an output.
        if (!(await stat(entry.path).catch(() => null))?.size) throw error;
      })
    )
    .then(() => {
      entry.ready = true;
    })
    .catch(() => {
      entry.error = 'Subtitle extraction failed';
      void rm(entry.path, { force: true });
    })
    .finally(() => extractions--);
  while (extracted.size > EXTRACTED_FILES) {
    const [oldest, old] = extracted.entries().next().value;
    extracted.delete(oldest);
    void rm(old.path, { force: true });
  }
  return entry;
}
async function sendExtracted(res, entry, type) {
  if (entry.error) {
    const error = Error(entry.error);
    error.status = 502;
    throw error;
  }
  if (!entry.ready) {
    res.writeHead(425, {
      'Content-Type': 'application/json',
      'Retry-After': '5',
    });
    res.end(JSON.stringify({ error: 'Still extracting', retryAfter: 5 }));
    return;
  }
  const size = await stat(entry.path);
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': size.size });
  await pipeline(createReadStream(entry.path), res);
}
/** How far before the source's end a finished conversion may stop. */
const END_MARGIN_MS = 30_000;
export function stoppedEarly(job) {
  const total = job.meta?.durationMs;
  return total > 0 && (job.producedMs ?? 0) < total - END_MARGIN_MS;
}
async function prepare(body) {
  const input = inputUrl(body.input);
  const meta = await probe(input);
  const request = body.request ?? {};
  if (
    !['original', '1080p', '720p'].includes(request.quality) ||
    !Number.isFinite(request.positionMs) ||
    request.positionMs < 0 ||
    // Some sources report no duration (0); don't bound those.
    (meta.durationMs > 0 && request.positionMs > meta.durationMs + 4000)
  )
    throw Error('Invalid playback request');
  if (
    typeof body.viewer !== 'string' ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(body.viewer)
  )
    throw Error('Invalid viewer');
  const policy = select(meta, request);
  if (!policy.video) throw Error('Source has no video');
  if (policy.mode === 'direct') return { mode: 'direct', meta };
  const key = hash([
    input,
    request.quality,
    request.audio,
    request.subtitle,
    policy.copyVideo,
    policy.copyAudio,
    policy.burn,
  ]);
  const positionMs = request.positionMs;
  let job = [...jobs.values()].find(
    (j) =>
      j.key === key &&
      !j.error &&
      // Its real start can be a frame past the position asked for.
      positionMs >= j.offsetMs - 1000 &&
      positionMs <= (j.producedMs ?? j.offsetMs) + 8000
  );
  if (!job) {
    for (const old of [...jobs.values()])
      if (!old.viewers.size || old.error) await drop(old);
    const encodes = (j) => j.mode === 'video';
    const encoding = select(meta, request).mode === 'video';
    if (
      jobs.size >= copyLimit ||
      (encoding && [...jobs.values()].filter(encodes).length >= limit)
    ) {
      const err = Error(
        'Conversion capacity reached; try Original or retry later'
      );
      err.status = 503;
      // Viewers who left free their place within a minute.
      err.retryAfter = 10;
      throw err;
    }
    const jobId = id();
    job = {
      id: jobId,
      key,
      input,
      meta,
      request,
      dir: `${root}/${jobId}`,
      viewers: new Map(),
      last: Date.now(),
      offsetMs: Math.floor(positionMs / 4000) * 4000,
      producedMs: Math.floor(positionMs / 4000) * 4000,
    };
    jobs.set(jobId, job);
    try {
      await mkdir(job.dir, { recursive: true });
      start(job, process.env.TRANSCODER_ENCODER ?? 'cpu');
    } catch (error) {
      await drop(job);
      throw error;
    }
  }
  if (
    typeof body.viewer !== 'string' ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(body.viewer)
  )
    throw Error('Invalid viewer');
  job.viewers.set(body.viewer, { positionMs, at: Date.now() });
  job.last = Date.now();
  if (job.paused && job.producedMs < maximumPosition(job) + 120000) {
    job.child?.kill('SIGCONT');
    job.paused = false;
  }
  for (let i = 0; i < 300; i++) {
    if (job.error) throw Error(job.error);
    const mpd = await readFile(`${job.dir}/manifest.mpd`, 'utf8').catch(
      () => ''
    );
    if (manifestReady(mpd)) {
      if (!job.ready) {
        const start = manifestStart(mpd);
        if (start != null && start >= 0)
          job.offsetMs = Math.round(start * 1000);
      }
      job.ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!job.ready) {
    const error = Error('Conversion is still starting; retry shortly');
    error.status = 503;
    throw error;
  }
  // Shaka plays the source's own timestamps: the player needs no offset.
  return {
    id: job.id,
    mode: job.mode,
    offsetMs: 0,
    startMs: job.offsetMs,
    meta,
  };
}
export function createServer() {
  return http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!authorized(req)) {
      res.writeHead(401).end();
      return;
    }
    try {
      const url = new URL(req.url, 'http://worker');
      const send = (body) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(body));
      };
      if (req.method === 'GET' && url.pathname === '/health')
        return send({
          ok: true,
          cacheBytes,
          maxCacheBytes: maxBytes,
          maxJobs: limit,
          jobs: [...jobs.values()].map((j) => ({
            id: j.id,
            mode: j.mode,
            // Why video/audio are converted (null: copied).
            reasons: j.reasons,
            encoder: j.encoder,
            tonemap: j.tonemap,
            viewers: j.viewers.size,
            producedMs: j.producedMs,
            speed: j.speed,
            error: j.error,
          })),
        });
      if (req.method === 'POST' && url.pathname === '/probe')
        return send(await probe(inputUrl((await json(req)).input)));
      if (req.method === 'POST' && url.pathname === '/subtitle') {
        // A subtitle track as a file: WebVTT for text, the track itself for
        // ASS and PGS, which the browser draws.
        const body = await json(req);
        const input = inputUrl(body.input);
        const format = SUBTITLE_FORMATS[body.format ?? 'vtt'];
        if (!format) throw Error('Unknown subtitle format');
        const meta = await probe(input);
        const track = meta.tracks.find(
          (t) => t.type === 'subtitle' && t.index === body.index
        );
        if (!track || subtitleKind(track.codec) !== format.kind)
          throw Error('Unknown subtitle track');
        return sendExtracted(
          res,
          extract(
            [input, 'subtitle', body.index, body.format ?? 'vtt'],
            (path) => [
              '-v',
              'error',
              '-i',
              input,
              '-map',
              `0:${body.index}`,
              ...format.codec,
              '-f',
              format.muxer,
              '-y',
              path,
            ]
          ),
          format.type
        );
      }
      if (req.method === 'POST' && url.pathname === '/font') {
        // A font attached to the file, which its ASS subtitles use. MKV
        // keeps attachments at its start, so this reads little of it.
        const body = await json(req);
        const input = inputUrl(body.input);
        const font = (await probe(input)).fonts.find(
          (f) => f.index === body.index
        );
        if (!font) throw Error('Unknown font');
        return sendExtracted(
          res,
          extract([input, 'font', body.index], (path) => [
            '-v',
            'error',
            `-dump_attachment:${body.index}`,
            path,
            '-y',
            '-i',
            input,
          ]),
          font.mimetype
        );
      }
      if (req.method === 'POST' && url.pathname === '/prepare') {
        const body = await json(req);
        // Serialize admission so simultaneous requests cannot exceed the job limit.
        const previous = pending.get('prepare') ?? Promise.resolve();
        const task = previous.catch(() => {}).then(() => prepare(body));
        pending.set('prepare', task);
        try {
          return send(await task);
        } finally {
          if (pending.get('prepare') === task) pending.delete('prepare');
        }
      }
      const match = /^\/jobs\/([A-Za-z0-9_-]+)(?:\/([\w.-]+))?$/.exec(
        url.pathname
      );
      const job = match && jobs.get(match[1]);
      if (!job) {
        res.writeHead(404).end();
        return;
      }
      if (req.method === 'POST' && match[2] === 'touch') {
        const body = await json(req);
        if (!job.viewers.has(body.viewer)) {
          res.writeHead(403).end();
          return;
        }
        if (body.release) job.viewers.delete(body.viewer);
        else if (Number.isFinite(body.positionMs))
          job.viewers.set(body.viewer, {
            positionMs: body.positionMs,
            at: Date.now(),
          });
        job.last = Date.now();
        if (job.paused && job.producedMs < maximumPosition(job) + 120000) {
          job.child?.kill('SIGCONT');
          job.paused = false;
        }
        return send({ ok: true });
      }
      if (
        req.method === 'GET' &&
        /^(manifest\.mpd|init-\d+\.m4s|chunk-\d+-\d+\.m4s)$/.test(
          match[2] ?? ''
        )
      ) {
        if (job.error) throw Error(job.error);
        const file = `${job.dir}/${match[2]}`;
        const size = await stat(file).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
          const missing = Error('Not written yet');
          missing.status = 404;
          throw missing;
        });
        if (match[2] === 'manifest.mpd') {
          // The video is representation 0, its init segment written first.
          job.videoCodec ??= videoCodec(
            await readFile(`${job.dir}/init-0.m4s`).catch(() => Buffer.alloc(0))
          );
          const mpd = withFullDuration(
            withVideoCodec(await readFile(file, 'utf8'), job.videoCodec),
            job.meta.durationMs
          );
          res.setHeader('Content-Type', 'application/dash+xml');
          res.end(mpd);
          return;
        }
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Length', size.size);
        await pipeline(createReadStream(file), res);
        return;
      }
      res.writeHead(404).end();
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(error.status ?? 400, {
        'Content-Type': 'application/json',
        ...(error.retryAfter
          ? { 'Retry-After': String(error.retryAfter) }
          : {}),
      });
      // Native errors may contain source URLs: pass on only their code.
      const native = !!(error.code || error.cmd);
      const message = native ? mediaError(error) : error.message;
      if (native)
        console.warn(
          JSON.stringify({
            level: 'warn',
            msg: 'media operation failed',
            method: req.method,
            path: new URL(req.url, 'http://worker').pathname,
            code: error.code,
            syscall: error.syscall,
          })
        );
      res.end(JSON.stringify({ error: message, retryAfter: error.retryAfter }));
    }
  });
}
async function sweep() {
  let bytes = 0;
  const sizes = new Map();
  for (const job of [...jobs.values()]) {
    for (const [viewer, state] of job.viewers)
      if (Date.now() - state.at > 60000) job.viewers.delete(viewer);
    if (!job.viewers.size && Date.now() - job.last > 60000) {
      await drop(job);
      continue;
    }
    const files = await readdir(job.dir).catch(() => []);
    let size = 0;
    for (const file of files)
      size += (await stat(`${job.dir}/${file}`).catch(() => ({ size: 0 })))
        .size;
    sizes.set(job, size);
    bytes += size;
  }
  // Evict the least recently used jobs, only until the cache fits again.
  for (const job of [...sizes.keys()].sort((a, b) => a.last - b.last)) {
    if (bytes <= maxBytes) break;
    job.error = 'Segment cache capacity reached';
    await stop(job);
    await removeDir(job.dir);
    bytes -= sizes.get(job);
  }
  cacheBytes = bytes;
}
/**
 * Empties the cache left by a previous run. The directory itself is kept:
 * it is usually a volume mount point, and removing one fails with EBUSY.
 */
export async function clearCache(dir) {
  await mkdir(dir, { recursive: true });
  for (const entry of await readdir(dir))
    await rm(`${dir}/${entry}`, { recursive: true, force: true });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (secret.length < 32)
    throw Error('TRANSCODER_SECRET must contain at least 32 characters');
  await clearCache(root);
  const server = createServer();
  server.listen(Number(process.env.PORT ?? 3100), '0.0.0.0');
  const timer = setInterval(() => void sweep().catch(() => {}), 5000);
  timer.unref();
  for (const signal of ['SIGTERM', 'SIGINT'])
    process.on(signal, () => {
      clearInterval(timer);
      for (const j of jobs.values()) stop(j);
      server.close(() => process.exit());
      setTimeout(() => process.exit(), 5000).unref();
    });
}
