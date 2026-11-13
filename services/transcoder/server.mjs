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
  streamArgs,
  composeManifest,
  parseTimeline,
  tracksOf,
  demuxArgs,
  rendererArgs,
  firstPacketTime,
  playbackSpec,
  modeOf,
  outTimeMs,
  subtitleKind,
  videoCodec,
  initLayout,
  audioCodec,
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
    throw Object.assign(Error('Invalid source handle'), { status: 400 });
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
    if (text.length > 65536)
      throw Object.assign(Error('Request too large'), { status: 400 });
  }
  try {
    return JSON.parse(text || '{}');
  } catch {
    throw Object.assign(Error('Invalid JSON'), { status: 400 });
  }
}
/**
 * The source reader's state, from AIOStreams (`<source>/status`): read when an FFmpeg reading the
 * source exits with an error, since FFmpeg's stderr isn't read (it can carry credentials). It
 * tells a source that failed (`failed`, with the status and code AIOStreams gives) from one that
 * is still resolving or was fine. Never throws: `unknown` when AIOStreams doesn't answer.
 */
export async function sourceStatus(input) {
  try {
    const url = new URL(input);
    url.pathname = `${url.pathname.replace(/\/$/, '')}/status`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { state: 'unknown', httpStatus: res.status };
    return await res.json();
  } catch {
    return { state: 'unknown' };
  }
}
/** Source states read after probes failed, newest last; without the handle (a credential). */
const probeSources = [];
/** Keeps the source's state on a job whose FFmpeg (`which`) exited with an error. */
function noteSource(job, which) {
  void sourceStatus(job.input).then((status) => {
    job.source = { ...status, after: which, at: Date.now() };
  });
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
      .then(async ({ stdout }) => ({
        ...JSON.parse(stdout),
        // The first video frame's side data (HDR10+), which the streams don't list. Without it
        // (no video, a frame that doesn't decode) the file is described all the same.
        frames: await exec(
          'ffprobe',
          [
            '-v',
            'error',
            '-select_streams',
            'v:0',
            '-show_frames',
            '-read_intervals',
            '%+#1',
            '-show_entries',
            'frame=stream_index,side_data_list',
            '-of',
            'json',
            input,
          ],
          { timeout: 30000, maxBuffer: 1024 * 1024 }
        )
          .then(({ stdout: frames }) => JSON.parse(frames).frames ?? [])
          .catch(() => []),
      }))
      .then((raw) => metadata(raw))
      .catch(async (error) => {
        probes.delete(input);
        const source = await sourceStatus(input);
        probeSources.push({ ...source, at: Date.now() });
        if (probeSources.length > 20) probeSources.shift();
        throw Object.assign(Error(probeFailure(error)), { source });
      });
    probes.set(input, task);
    if (probes.size > 200) probes.delete(probes.keys().next().value);
  }
  return probes.get(input);
}
const running = (child) =>
  !!child && child.exitCode === null && child.signalCode === null;
/** Kills a process started in its own group (`detached`) and everything in that group. */
function killGroup(child) {
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}
/** Stops a binaural audio job's demuxer and renderer. */
function killHelpers(job) {
  const helpers = job.helpers;
  if (!helpers) return;
  job.helpers = null;
  helpers.stopping = true;
  clearTimeout(helpers.timer);
  if (running(helpers.demux)) helpers.demux.kill('SIGKILL');
  // The renderer's whole group: its decoding FFmpeg would otherwise be orphaned.
  if (running(helpers.renderer)) killGroup(helpers.renderer);
}
/**
 * Stops a job's FFmpeg and resolves once it has exited: SIGTERM, then SIGKILL
 * after 3 s. Its files can only be removed after that, since FFmpeg still
 * writes the last segment and playlist while it shuts down.
 */
export function stop(job) {
  killHelpers(job);
  const child = job.child;
  if (!running(child)) return Promise.resolve();
  job.stopping = true;
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

/*
 * Stream jobs. Each job makes one stream: a video job the picture (copied or encoded, with any
 * burned-in subtitle), an audio job one audio track (copied, converted, or rendered binaural), a
 * subtitle job one subtitle track as a file. A viewer (a lease) holds a video job, an audio job
 * when the audio is converted, and a subtitle job when one is extracted; its manifest is written
 * here from its jobs' segments. Viewers with the same needs share jobs: a job is keyed by what it
 * writes (`keyOf`), and covers a span of the source.
 */
const viewers = new Map();
/** Segments ending this far behind the slowest viewer counted are deleted. */
const WINDOW_BEHIND_MS = 60_000;
/** A viewer this far behind a job's furthest stops counting for it (its own job, next time). */
const STRAGGLER_MS = 5 * 60_000;
/** A job pauses when what it has written is this far ahead of its furthest viewer. */
const AHEAD_MS = 120_000;
/** A segment's length, and the slack a job's coverage and the disk reservation allow. */
const MARGIN_MS = 8_000;
/** What a job can hold on disk under these rules, in seconds of its stream. */
const RESERVE_S =
  (WINDOW_BEHIND_MS + STRAGGLER_MS + AHEAD_MS + MARGIN_MS) / 1000;
/** A running job without progress this long asks AIOStreams about its source. */
const STALL_MS = 5000;
/** A viewer without a heartbeat this long has gone. */
const VIEWER_TTL_MS = 60_000;
/** How long a state request waits for a change. */
const STATE_WAIT_MS = 25_000;
/** At most this many subtitle extractions run at once (each reads the whole file). */
const SUBTITLE_RUNS = 2;
/** The order a job's stages come in, for a viewer's combined stage (the earliest). */
const STAGES = [
  'opening',
  'waitingAudio',
  'rendering',
  'waitingSource',
  'encoding',
  'ready',
  'paused',
  'finished',
];
const SUBTITLE_FILES = {
  text: 'vtt',
  ass: 'ass',
  pgs: 'sup',
};

/**
 * Audio tracks whose binaural rendering failed once playing: converted
 * without it from then on (the player's virtualiser takes over), rather than
 * failing the same way again. Bounded; the oldest is forgotten first.
 */
const binauralFailed = new Set();
const binauralKey = (input, spec) => `${input}#${spec.audio?.track}`;
/**
 * The spec a playback asks for: from its request, and what the transcoder knows. Binaural
 * rendering isn't asked of the renderer for a track it failed on (`binauralFailed`).
 */
function specFor(meta, request, input) {
  const spec = playbackSpec(meta, request);
  if (spec.audio?.where !== 'server-render') return spec;
  return binauralFailed.has(binauralKey(input, spec))
    ? playbackSpec(meta, request, { binauralFailed: true })
    : spec;
}
/**
 * A job's key: its source, and the fields of its stream's spec that decide what it writes. What
 * the page does with the same output (Dolby Vision drawn or not, audio rendered by the page) and
 * the quality asked for (already in the encode's scale and cap) are left out, so viewers who
 * differ only there share the job.
 */
function keyOf(kind, input, spec, file) {
  if (kind === 'video') {
    const v = spec.video;
    const burn =
      spec.subtitle?.where === 'server-burn' ? spec.subtitle.track : null;
    return hash([input, 'video', v.track, v.where, v.encode ?? null, burn]);
  }
  if (kind === 'audio') {
    const a = spec.audio;
    const where = a.where === 'page-original' ? 'server-copy' : a.where;
    return hash([
      input,
      'audio',
      a.track,
      where,
      a.convert ?? null,
      a.render ?? null,
    ]);
  }
  return hash(['subtitle', file, spec.subtitle.track, spec.subtitle.format]);
}
/** Bits per second a job's stream takes, for its disk reservation. */
function bitrateOf(kind, meta, spec) {
  const { video, audio } = tracksOf(meta, spec);
  if (kind === 'video') {
    const source =
      video?.bitrate ||
      Math.max(0, (meta.bitrate || 0) - (audio?.bitrate || 0));
    if (spec.video.where !== 'server-encode') return source || 40e6;
    const cap = spec.video.encode?.maxBitrate;
    return cap ? parseInt(cap, 10) * 1e6 : source || 40e6;
  }
  if (kind === 'audio') {
    const out = spec.audio.convert ?? spec.audio.render;
    if (!out) return audio?.bitrate || (audio?.codec === 'truehd' ? 6e6 : 2e6);
    if (out.codec === 'flac') return (out.channels ?? 2) * 48000 * 24 * 0.7;
    return (parseInt(out.bitrate, 10) || 640) * 1000;
  }
  return 0;
}
const reserveOf = (job) =>
  job.kind === 'subtitle'
    ? 16 * 1024 ** 2
    : Math.ceil((bitrateOf(job.kind, job.meta, job.spec) / 8) * RESERVE_S);

function notify(viewer) {
  if (!viewer) return;
  viewer.version++;
  for (const wake of viewer.waiters.splice(0)) wake();
}
function changed(job) {
  for (const lease of job.viewers) notify(viewers.get(lease));
}
/** Sets a job's stage where its event happens, with the time, and tells its viewers. */
function setStage(job, stage, detail) {
  if (job.stage === stage && !detail) return;
  job.stage = stage;
  job.stages.push({ stage, at: Date.now(), ...detail });
  if (job.stages.length > 40) job.stages.splice(0, job.stages.length - 40);
  changed(job);
}
/**
 * A job that won't produce: `class` says why. `source`: the source failed (AIOStreams' reader
 * says so), not the conversion; it isn't tried again. `encoder`: the GPU failed once playing.
 * `conversion`: anything else.
 */
function failJob(job, failure) {
  job.failure = failure;
  setStage(job, 'failed', { class: failure.class });
}
const SOURCE_FAILURE = (status) => ({
  class: 'source',
  status: 502,
  code: status.code ?? 'source_failed',
  reason: status.message ?? 'The source could not be read',
});
/** Asks AIOStreams about the source after an FFmpeg reading it failed; kept on the job. */
async function sourceOf(job, which) {
  const status = await sourceStatus(job.input);
  job.source = { ...status, after: which, at: Date.now() };
  return status;
}
/** Starts a job again, from nothing, as it now is (its spec, key and stage). */
async function restart(job, start, detail) {
  killHelpers(job);
  const child = job.child;
  job.child = null;
  if (running(child)) {
    if (job.paused) child.kill('SIGCONT');
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
  }
  job.paused = false;
  job.ready = false;
  job.segments = [];
  job.firstKept = 1;
  job.writtenMs = null;
  job.startMs = null;
  job.videoCodec = undefined;
  await rm(job.dir, { recursive: true, force: true });
  await mkdir(job.dir, { recursive: true });
  if (!jobs.has(job.id)) return;
  setStage(job, 'opening', detail);
  start();
}

/** Spawns a stream job's FFmpeg with its progress on pipe:3. */
function spawnStream(job, args, stdin = 'ignore') {
  const command = [...args];
  command.splice(command.length - 1, 0, '-progress', 'pipe:3');
  const child = spawn('ffmpeg', command, {
    stdio: [stdin, 'ignore', 'pipe', 'pipe'],
  });
  job.child = child;
  job.stopping = false;
  job.progressAt = Date.now();
  let progress = '';
  child.stdio[3].on('data', (chunk) => {
    progress += chunk;
    const lines = progress.split('\n');
    progress = lines.pop() ?? '';
    for (const line of lines) {
      if (line.startsWith('speed=')) job.speed = line.slice(6);
      // "N/A" until FFmpeg has written something.
      const outMs = outTimeMs(line);
      if (outMs == null) continue;
      if (job.producedMs !== job.offsetMs + outMs) job.progressAt = Date.now();
      job.producedMs = job.offsetMs + outMs;
      if (['opening', 'rendering', 'waitingSource'].includes(job.stage))
        setStage(job, job.ready ? 'ready' : 'encoding');
    }
  });
  // Do not log FFmpeg stderr: it can contain credentials from upstream errors.
  child.stderr.resume();
  child.on('error', () =>
    failJob(job, {
      class: 'conversion',
      status: 500,
      reason: 'FFmpeg could not start',
    })
  );
  return child;
}

/**
 * A video job. Encoding on the GPU that fails before its first segment runs again with the
 * video decoded on the CPU, then with the tone map on the CPU too (an HDR source), then all on
 * the CPU; only a command that used the GPU falls back.
 */
function startVideo(job, encoder, gpu = { decode: 'gpu', tonemap: 'gpu' }) {
  const command = streamArgs(
    'video',
    job.input,
    job.meta,
    job.spec,
    job.dir,
    encoder,
    {
      ...gpu,
      positionMs: job.positionMs,
    }
  );
  job.offsetMs = command.offsetMs;
  job.encoder = encoder;
  job.tonemap = command.tonemap;
  job.decode = command.decode;
  const child = spawnStream(job, command.args);
  child.on('exit', async (code) => {
    if (!jobs.has(job.id) || job.child !== child || job.stopping) return;
    job.child = null;
    if (code === 0) return void (await finished(job));
    const status = await sourceOf(job, 'main');
    if (status.state === 'failed') return failJob(job, SOURCE_FAILURE(status));
    if (command.gpu && !job.ready) {
      const next =
        command.decode === 'gpu'
          ? () => startVideo(job, encoder, { decode: 'cpu', tonemap: 'gpu' })
          : command.tonemap === 'gpu'
            ? () => startVideo(job, encoder, { decode: 'cpu', tonemap: 'cpu' })
            : () => startVideo(job, 'cpu');
      return restart(job, next, { fallback: 'encoder' });
    }
    failJob(job, {
      class: command.gpu ? 'encoder' : 'conversion',
      status: 500,
      reason: 'Conversion failed',
    });
  });
}
/** A clean exit: finished, or (well before the end) the source stopped sending. */
async function finished(job) {
  if (!stoppedEarly(job)) return setStage(job, 'finished');
  const status = await sourceOf(job, 'main');
  failJob(
    job,
    status.state === 'failed'
      ? SOURCE_FAILURE(status)
      : {
          class: 'source',
          status: 502,
          code: 'source_unreachable',
          reason: 'The source stopped before the end',
        }
  );
}
/** An audio job that copies or converts its track. */
function startAudio(job) {
  const command = streamArgs(
    'audio',
    job.input,
    job.meta,
    job.spec,
    job.dir,
    'cpu',
    {
      positionMs: job.positionMs,
      videoCopied: job.spec.video?.where !== 'server-encode',
    }
  );
  job.offsetMs = command.offsetMs;
  const child = spawnStream(job, command.args);
  child.on('exit', async (code) => {
    if (!jobs.has(job.id) || job.child !== child || job.stopping) return;
    job.child = null;
    if (code === 0) return void (await finished(job));
    const status = await sourceOf(job, 'main');
    if (status.state === 'failed') return failJob(job, SOURCE_FAILURE(status));
    failJob(job, {
      class: 'conversion',
      status: 500,
      reason: 'Conversion failed',
    });
  });
}
/** A binaural audio job's renderer failed: the track converted instead, as the job now is. */
function withoutBinaural(job) {
  if (job.helpers?.fallingBack) return;
  if (job.helpers) job.helpers.fallingBack = true;
  if (job.ready) {
    binauralFailed.add(binauralKey(job.input, job.spec));
    if (binauralFailed.size > 200)
      binauralFailed.delete(binauralFailed.values().next().value);
  }
  job.spec = playbackSpec(job.meta, job.request, { binauralFailed: true });
  job.key = keyOf('audio', job.input, job.spec);
  void restart(job, () => startAudio(job), { fallback: 'renderer' });
}
/** How long a binaural job waits for its first audio packet. */
const AUDIO_START_TIMEOUT_MS = 60_000;
/**
 * A binaural audio job: FFmpeg demuxing the track, atmos-render, and FFmpeg writing the rendered
 * audio, placed at the first packet's source timestamp. If the demuxer or renderer fails (and
 * the source didn't), the job runs again converting the track without binaural rendering.
 */
function startRender(job) {
  const offset = Math.floor(Math.max(0, job.positionMs ?? 0) / 1000 / 4) * 4;
  job.offsetMs = offset * 1000;
  const demux = spawn(
    'ffmpeg',
    demuxArgs(job.input, job.meta, job.spec, offset),
    {
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    }
  );
  const renderer = spawn(
    process.env.ATMOS_RENDER ?? 'atmos-render',
    rendererArgs(job.meta, job.spec),
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      // Its own process group, with the FFmpeg it decodes E-AC-3, AC-3 and DTS with.
      detached: true,
    }
  );
  const helpers = {
    demux,
    renderer,
    stopping: false,
    fallingBack: false,
    timer: null,
  };
  job.helpers = helpers;
  setStage(job, 'waitingAudio');
  // Do not log their stderr: FFmpeg's can contain credentials.
  demux.stderr.resume();
  renderer.stderr.resume();
  renderer.stdin.on('error', () => {});
  demux.stdout.pipe(renderer.stdin);
  const helperFailed = async (which) => {
    if (helpers.stopping || job.helpers !== helpers) return;
    if (which === 'demux') {
      const status = await sourceOf(job, 'demux');
      if (status.state === 'failed') {
        killHelpers(job);
        if (running(job.child)) job.child.kill('SIGKILL');
        return failJob(job, SOURCE_FAILURE(status));
      }
    }
    withoutBinaural(job);
  };
  demux.on('error', () => helperFailed('demux'));
  renderer.on('error', () => helperFailed('renderer'));
  demux.on('exit', (code) => code !== 0 && helperFailed('demux'));
  renderer.on('exit', (code) => code !== 0 && helperFailed('renderer'));
  let held = [];
  const hold = (chunk) => held.push(chunk);
  renderer.stdout.on('data', hold);
  helpers.timer = setTimeout(
    () => helperFailed('renderer'),
    AUDIO_START_TIMEOUT_MS
  );
  helpers.timer.unref();
  let text = '';
  let child = null;
  demux.stdio[3].on('data', (chunk) => {
    if (child || helpers.stopping) return; // drained, so the demuxer never blocks on it
    text += chunk;
    const audioStart = firstPacketTime(text);
    if (audioStart == null) return;
    clearTimeout(helpers.timer);
    const command = streamArgs(
      'audio',
      job.input,
      job.meta,
      job.spec,
      job.dir,
      'cpu',
      {
        positionMs: job.positionMs,
        audioStart,
      }
    );
    setStage(job, 'rendering');
    child = spawnStream(job, command.args, 'pipe');
    child.stdin.on('error', () => {});
    renderer.stdout.off('data', hold);
    for (const c of held) child.stdin.write(c);
    held = [];
    renderer.stdout.pipe(child.stdin);
    child.on('exit', async (code) => {
      if (!jobs.has(job.id) || job.child !== child || job.stopping) return;
      job.child = null;
      if (code === 0) {
        killHelpers(job);
        return void (await finished(job));
      }
      const status = await sourceOf(job, 'main');
      if (status.state === 'failed') {
        killHelpers(job);
        return failJob(job, SOURCE_FAILURE(status));
      }
      if (!job.ready) return withoutBinaural(job);
      killHelpers(job);
      failJob(job, {
        class: 'conversion',
        status: 500,
        reason: 'Conversion failed',
      });
    });
  });
}
/** A subtitle job: the track written out as a file, served as it grows. */
function startSubtitle(job) {
  const format = SUBTITLE_FORMATS[job.format];
  job.file = `${job.dir}/subtitle.${job.format}`;
  const child = spawn(
    'ffmpeg',
    [
      ...['-hide_banner', '-v', 'error', '-nostdin', '-y'],
      ...['-i', job.input, '-map', `0:${job.spec.subtitle.track}`],
      ...format.codec,
      ...['-flush_packets', '1', '-f', format.muxer, job.file],
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );
  job.child = child;
  job.stopping = false;
  child.stderr.resume();
  const growing = setInterval(async () => {
    if (
      (await stat(job.file).catch(() => null))?.size &&
      job.stage === 'opening'
    )
      setStage(job, 'encoding');
  }, 500);
  growing.unref();
  const timer = setTimeout(() => child.kill('SIGKILL'), EXTRACTION_TIMEOUT_MS);
  timer.unref();
  child.on('error', () =>
    failJob(job, {
      class: 'conversion',
      status: 500,
      reason: 'Subtitle extraction failed',
    })
  );
  child.on('exit', async (code) => {
    clearInterval(growing);
    clearTimeout(timer);
    if (!jobs.has(job.id) || job.child !== child || job.stopping) return;
    job.child = null;
    if (code === 0) {
      job.ready = true;
      return setStage(job, 'finished');
    }
    const status = await sourceOf(job, 'subtitle');
    failJob(
      job,
      status.state === 'failed'
        ? SOURCE_FAILURE(status)
        : {
            class: 'conversion',
            status: 500,
            reason: 'Subtitle extraction failed',
          }
    );
  });
}
function startJob(job) {
  if (job.kind === 'video')
    startVideo(job, process.env.TRANSCODER_ENCODER ?? 'cpu');
  else if (job.kind === 'subtitle') startSubtitle(job);
  else if (job.spec.audio.where === 'server-render') startRender(job);
  else startAudio(job);
}

/** Where a job is written to, as far as anyone may play from it. */
const endOf = (job) => job.writtenMs ?? job.offsetMs ?? 0;
/** The positions of a job's viewers, furthest first, and those that still count for it. */
function positionsOf(job) {
  const all = [...job.viewers]
    .map((lease) => viewers.get(lease)?.positionMs)
    .filter((p) => Number.isFinite(p))
    .sort((a, b) => b - a);
  const furthest = all[0];
  return { furthest, counted: all.filter((p) => p >= furthest - STRAGGLER_MS) };
}
/** Where a job's kept segments start: its start until the window deletes some. */
function keptStartOf(job) {
  const first =
    (job.firstKept ?? 1) > 1
      ? job.segments.find((s) => s.number >= job.firstKept)
      : null;
  return first
    ? Math.round((first.t / job.timescale) * 1000)
    : (job.startMs ?? job.offsetMs);
}
/** An existing job a viewer at `positionMs` can play: same key, working, covering it. */
export function matching(kind, key, positionMs) {
  return [...jobs.values()].find((j) => {
    if (j.kind !== kind || j.key !== key || j.failure) return false;
    if (kind === 'subtitle') return true;
    // From its first segment still kept: those behind it were deleted.
    const start = keptStartOf(j);
    if (positionMs < start - 1000 || positionMs > endOf(j) + MARGIN_MS)
      return false;
    // Too far behind its viewers: it would hold the window back. A job of its own.
    const { furthest } = positionsOf(j);
    return !(furthest - positionMs > STRAGGLER_MS);
  });
}
function newJob(kind, key, { input, meta, request, spec, positionMs, format }) {
  const jobId = id();
  const job = {
    id: jobId,
    kind,
    key,
    input,
    meta,
    request,
    spec,
    format,
    positionMs,
    dir: `${root}/${jobId}`,
    viewers: new Set(),
    last: Date.now(),
    stage: null,
    stages: [],
    failure: null,
    ready: false,
    segments: [],
    firstKept: 1,
    offsetMs: Math.floor(positionMs / 4000) * 4000,
    producedMs: null,
    writtenMs: null,
    startMs: null,
  };
  job.reservedBytes = reserveOf(job);
  return job;
}
/** A request error: 400. */
const bad = (message) => Object.assign(Error(message), { status: 400 });
/** A probe, its failure classed: the source's (502, its code) when AIOStreams says so. */
async function probed(input) {
  try {
    return await probe(input);
  } catch (error) {
    if (error.source?.state === 'failed')
      throw Object.assign(Error(error.message), SOURCE_FAILURE(error.source));
    throw Object.assign(Error(error.message), {
      status: 502,
      class: 'conversion',
    });
  }
}
const capacityError = (message) =>
  Object.assign(Error(message), {
    status: 503,
    retryAfter: 10,
    class: 'capacity',
  });
/**
 * Admits a playback: its viewer and the jobs it needs, existing ones where they cover its
 * position, new ones within the limits and the disk budget. Jobs held only by the playback it
 * `replaces` count as free, and go once this one is admitted (a seek or a switch at capacity).
 */
function admit(body, meta) {
  const input = inputUrl(body.input);
  const request = body.request ?? {};
  if (
    !['original', '1080p', '720p'].includes(request.quality) ||
    !Number.isFinite(request.positionMs) ||
    request.positionMs < 0 ||
    // Some sources report no duration (0); don't bound those.
    (meta.durationMs > 0 && request.positionMs > meta.durationMs + 4000)
  )
    throw bad('Invalid playback request');
  if (
    typeof body.viewer !== 'string' ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(body.viewer)
  )
    throw bad('Invalid viewer');
  if (viewers.has(body.viewer)) throw bad('Viewer already admitted');
  const replaced =
    typeof body.replaces === 'string' ? viewers.get(body.replaces) : null;
  const asked = playbackSpec(meta, request);
  const requested = specFor(meta, request, input);
  if (!asked.video) throw bad('Source has no video');
  if (asked.video.where === 'page-original') {
    if (replaced) releaseViewer(replaced.lease);
    return { mode: 'direct', spec: requested, effective: requested, meta };
  }
  const positionMs = request.positionMs;
  const kinds = ['video'];
  if (requested.audio) kinds.push('audio');
  const subtitleFormat =
    requested.subtitle?.where === 'page'
      ? SUBTITLE_FILES[requested.subtitle.format]
      : null;
  if (subtitleFormat && typeof body.file === 'string') kinds.push('subtitle');
  const extracting = () =>
    [...jobs.values()].filter(
      (j) => j.kind === 'subtitle' && !j.ready && !j.failure
    ).length;
  const plan = {};
  const fresh = [];
  for (const kind of kinds) {
    const key = keyOf(kind, input, requested, body.file);
    let job = matching(kind, key, positionMs);
    // Extraction is full: the page asks for the subtitle again later (/subtitle).
    if (!job && kind === 'subtitle' && extracting() >= SUBTITLE_RUNS) continue;
    if (!job) {
      job = newJob(kind, key, {
        input,
        meta,
        request,
        spec: requested,
        positionMs,
        format: subtitleFormat,
      });
      fresh.push(job);
    }
    plan[kind] = job;
  }
  // What's held: not the jobs only the replaced playback holds, nor those nobody holds (they
  // go when their room is needed, oldest first; until then a returning viewer can use them).
  const replacedOnly = (j) =>
    !!replaced &&
    j.viewers.size > 0 &&
    [...j.viewers].every((l) => l === replaced.lease);
  const used = Object.values(plan);
  const idle = [...jobs.values()]
    .filter((j) => !j.viewers.size && !j.failure && !used.includes(j))
    .sort((a, b) => a.last - b.last);
  const held = [...jobs.values()].filter(
    (j) =>
      used.includes(j) || (!replacedOnly(j) && !j.failure && !idle.includes(j))
  );
  const encodes = (j) =>
    j.kind === 'video' && j.spec.video.where === 'server-encode';
  const over = (list) =>
    list.filter((j) => j.kind === 'video').length > copyLimit ||
    list.filter(encodes).length > limit ||
    list.filter((j) => j.kind === 'audio').length > copyLimit;
  const after = [...held, ...fresh];
  if (over(after))
    throw capacityError(
      'Conversion capacity reached; try Original or retry later'
    );
  const reserved = (list) => list.reduce((n, j) => n + j.reservedBytes, 0);
  if (reserved(after) > maxBytes)
    throw capacityError(
      'Conversion disk space is reserved; try Original or retry later'
    );
  // Idle jobs make room, oldest first, only as far as needed.
  const keep = [...idle];
  while (
    keep.length &&
    (over([...after, ...keep]) || reserved([...after, ...keep]) > maxBytes)
  )
    void drop(keep.shift());
  const viewer = {
    lease: body.viewer,
    input,
    meta,
    requested,
    jobs: {
      video: plan.video.id,
      audio: plan.audio?.id,
      subtitle: plan.subtitle?.id,
    },
    positionMs,
    at: Date.now(),
    version: 0,
    waiters: [],
  };
  viewers.set(viewer.lease, viewer);
  for (const job of Object.values(plan)) {
    job.viewers.add(viewer.lease);
    job.last = Date.now();
  }
  for (const job of fresh) {
    jobs.set(job.id, job);
    setStage(job, 'opening');
  }
  if (replaced) {
    const old = Object.values(replaced.jobs)
      .map((jobId) => jobs.get(jobId))
      .filter(Boolean);
    releaseViewer(replaced.lease);
    for (const job of old) if (!job.viewers.size) void drop(job);
  }
  return { viewer, fresh };
}
async function launch(fresh) {
  for (const job of fresh) {
    try {
      await mkdir(job.dir, { recursive: true });
      startJob(job);
    } catch (error) {
      failJob(job, {
        class: 'conversion',
        status: 500,
        reason: 'Conversion could not start',
      });
      throw error;
    }
  }
}
function releaseViewer(lease) {
  const viewer = viewers.get(lease);
  if (!viewer) return false;
  viewers.delete(lease);
  for (const jobId of Object.values(viewer.jobs)) {
    const job = jobs.get(jobId);
    if (!job) continue;
    job.viewers.delete(lease);
    job.last = Date.now();
  }
  notify(viewer);
  return true;
}
/** A viewer's jobs, by kind (a dropped one is missing). */
function jobsOf(viewer) {
  return {
    video: jobs.get(viewer.jobs.video),
    audio: viewer.jobs.audio ? jobs.get(viewer.jobs.audio) : null,
    subtitle: viewer.jobs.subtitle ? jobs.get(viewer.jobs.subtitle) : null,
  };
}
/**
 * A viewer's state: ready once its video and audio are; failed if either failed (or went); else
 * the earlier of their stages. The effective spec is what its jobs now make.
 */
function stateOf(viewer) {
  const { video, audio, subtitle } = jobsOf(viewer);
  const streams = viewer.jobs.audio ? [video, audio] : [video];
  const gone = streams.some((j) => !j);
  const failed = streams.find((j) => j?.failure);
  const ready = !gone && streams.every((j) => j.ready);
  const stage =
    gone || failed
      ? 'failed'
      : ready
        ? 'ready'
        : (STAGES[
            Math.min(
              ...streams
                .map((j) => STAGES.indexOf(j.stage))
                .filter((i) => i >= 0)
            )
          ] ?? 'opening');
  const effective = {
    ...viewer.requested,
    video: video?.spec.video ?? viewer.requested.video,
    audio: audio?.spec.audio ?? viewer.requested.audio,
  };
  const describe = (j) => j && { id: j.id, stage: j.stage, failure: j.failure };
  return {
    version: viewer.version,
    stage,
    ready,
    mode: modeOf(effective),
    spec: viewer.requested,
    effective,
    startMs: ready ? Math.max(...streams.map((j) => j.startMs ?? 0)) : null,
    failure: gone
      ? { class: 'conversion', status: 410, reason: 'The conversion ended' }
      : (failed?.failure ?? null),
    jobs: {
      video: describe(video),
      audio: describe(audio),
      subtitle: describe(subtitle),
    },
  };
}
/** Waits for a viewer's state to change past `after` (at most STATE_WAIT_MS). */
async function stateAfter(viewer, after) {
  if (!(viewer.version <= after)) return stateOf(viewer);
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, STATE_WAIT_MS);
    viewer.waiters.push(() => {
      clearTimeout(timer);
      resolve();
    });
  });
  return stateOf(viewer);
}

/**
 * Every half second, for each running stream job: its segments (from its manifest), readiness,
 * the window (segments far behind its viewers deleted), pausing on what it has written, and a
 * stalled source.
 */
async function tick() {
  for (const job of [...jobs.values()]) {
    try {
      await tickJob(job);
    } catch (error) {
      if (process.env.DEBUG_STATE) console.error('tick', job.id, error);
    }
  }
}
async function tickJob(job) {
  {
    if (job.kind === 'subtitle' || job.failure) return;
    const mpd = job.parsedFinal
      ? ''
      : await readFile(`${job.dir}/manifest.mpd`, 'utf8').catch(() => '');
    const timeline = mpd ? parseTimeline(mpd) : null;
    if (timeline?.segments.length) {
      job.timescale = timeline.timescale;
      job.segments = timeline.segments;
      const last = timeline.segments.at(-1);
      job.writtenMs = Math.round(
        ((last.t + last.d) / timeline.timescale) * 1000
      );
      if (job.stage === 'finished') job.parsedFinal = true;
      if (!job.ready) {
        job.ready = true;
        job.startMs = Math.round(
          (timeline.segments[0].t / timeline.timescale) * 1000
        );
        if (job.stage !== 'finished') setStage(job, 'ready');
        else changed(job);
      }
    }
    const { furthest, counted } = positionsOf(job);
    // The window: segments ending a minute behind the slowest viewer counted go.
    if (job.ready && counted.length) {
      const cutoff = Math.min(...counted) - WINDOW_BEHIND_MS;
      for (const s of job.segments) {
        if (s.number < job.firstKept) continue;
        if (((s.t + s.d) / job.timescale) * 1000 >= cutoff) break;
        await rm(
          `${job.dir}/chunk-0-${String(s.number).padStart(5, '0')}.m4s`,
          { force: true }
        );
        job.firstKept = s.number + 1;
      }
    }
    if (!running(job.child)) return;
    // Pausing on what it has written, never before its first segment.
    if (job.ready && Number.isFinite(furthest)) {
      const ahead = (job.writtenMs ?? 0) > furthest + AHEAD_MS;
      if (ahead && !job.paused) {
        job.child.kill('SIGSTOP');
        job.paused = true;
        setStage(job, 'paused');
      } else if (!ahead && job.paused) {
        job.child.kill('SIGCONT');
        job.paused = false;
        job.progressAt = Date.now();
        setStage(job, 'ready');
      }
    }
    // No progress: AIOStreams says whether its source is resolving (or AIOStreams is away).
    if (
      !job.paused &&
      Date.now() - job.progressAt > STALL_MS &&
      !job.checking
    ) {
      job.checking = true;
      void sourceStatus(job.input)
        .then((status) => {
          if (
            !running(job.child) ||
            job.paused ||
            Date.now() - job.progressAt <= STALL_MS
          )
            return;
          if (status.state === 'resolving' || status.state === 'unknown')
            setStage(job, 'waitingSource', { source: status.state });
          // The source failed while FFmpeg reconnects to it: the job fails as the source's, and
          // isn't tried again.
          else if (status.state === 'failed') {
            job.source = { ...status, after: 'stalled', at: Date.now() };
            killHelpers(job);
            const child = job.child;
            job.child = null;
            if (job.paused) child.kill('SIGCONT');
            child.kill('SIGKILL');
            failJob(job, SOURCE_FAILURE(status));
          }
        })
        .finally(() => {
          job.checking = false;
        });
    }
  }
}
/** Viewers without a heartbeat go, and jobs nobody has held for a minute. */
async function sweep() {
  for (const viewer of [...viewers.values()])
    if (Date.now() - viewer.at > VIEWER_TTL_MS) releaseViewer(viewer.lease);
  let bytes = 0;
  for (const job of [...jobs.values()]) {
    if (!job.viewers?.size && Date.now() - job.last > VIEWER_TTL_MS) {
      await drop(job);
      continue;
    }
    for (const file of await readdir(job.dir).catch(() => []))
      bytes += (await stat(`${job.dir}/${file}`).catch(() => ({ size: 0 })))
        .size;
  }
  cacheBytes = bytes;
}
/** A viewer's manifest, from its video and audio jobs. */
async function manifestOf(viewer) {
  const { video, audio } = jobsOf(viewer);
  const parts = [];
  for (const [kind, job] of [
    ['video', video],
    ['audio', audio],
  ]) {
    if (!job) continue;
    const mpd = await readFile(`${job.dir}/manifest.mpd`, 'utf8').catch(
      () => ''
    );
    if (!mpd) continue;
    if (kind === 'video' && job.videoCodec == null) {
      const init = await readFile(`${job.dir}/init-0.m4s`).catch(() =>
        Buffer.alloc(0)
      );
      job.videoCodec = videoCodec(init);
      // Without it the browser gets FFmpeg's bare "hvc1" and may refuse the video: say what the
      // init segment holds, once per job.
      if (job.videoCodec == null && init.length && !job.loggedInit) {
        job.loggedInit = true;
        console.warn(
          JSON.stringify({
            level: 'warn',
            msg: 'no codec string for the video',
            job: job.id,
            init: initLayout(init),
          })
        );
      }
    }
    parts.push({
      kind,
      id: job.id,
      mpd,
      firstKept: job.firstKept,
      codec: kind === 'video' ? job.videoCodec : audioCodec(job.meta, job.spec),
    });
  }
  return composeManifest(parts, {
    durationMs: viewer.meta.durationMs,
    windowMs: WINDOW_BEHIND_MS,
  });
}

/**
 * Starts writing a file with FFmpeg, once per key (fonts). Until it's written the caller is told
 * to come back.
 */
function extract(key, args) {
  const id = hash(key);
  const known = extracted.get(id);
  if (known && !known.error) return known;
  if (extractions >= 2) {
    const error = Error('Font extraction capacity reached');
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
      entry.error = 'Extraction failed';
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
/**
 * A subtitle job's file: whole once written; with `partial`, what's written so far
 * (`X-Complete: 0`); otherwise 425 until it's complete.
 */
async function sendSubtitle(res, job, partial) {
  if (job.failure) {
    const error = Error(job.failure.reason);
    error.status = job.failure.status ?? 502;
    error.class = job.failure.class;
    error.code = job.failure.code;
    throw error;
  }
  const type = SUBTITLE_FORMATS[job.format].type;
  if (!job.ready && !partial) {
    res.writeHead(425, {
      'Content-Type': 'application/json',
      'Retry-After': '5',
    });
    res.end(JSON.stringify({ error: 'Still extracting', retryAfter: 5 }));
    return;
  }
  const data = await readFile(job.file).catch(() => Buffer.alloc(0));
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': data.length,
    'X-Complete': job.ready ? '1' : '0',
  });
  res.end(data);
}
/** How far before the source's end a finished conversion may stop. */
const END_MARGIN_MS = 30_000;
export function stoppedEarly(job) {
  const total = job.meta?.durationMs;
  return (
    total > 0 && (job.writtenMs ?? job.producedMs ?? 0) < total - END_MARGIN_MS
  );
}
/** What /health says about a job. */
const healthOf = (j) => ({
  id: j.id,
  kind: j.kind,
  stage: j.stage,
  stages: j.stages,
  failure: j.failure,
  mode: j.spec ? modeOf(j.spec) : undefined,
  reasons: {
    video: j.spec?.video?.reason ?? null,
    audio: j.spec?.audio?.reason ?? null,
  },
  encoder: j.encoder,
  tonemap: j.tonemap,
  decode: j.decode,
  effective: j.spec,
  viewers: j.viewers?.size ?? 0,
  startMs: j.startMs,
  producedMs: j.producedMs,
  writtenMs: j.writtenMs,
  firstKept: j.firstKept,
  paused: !!j.paused,
  reservedBytes: j.reservedBytes,
  speed: j.speed,
  // The source's state when an FFmpeg reading it last failed.
  source: j.source ?? null,
});
/** The half-second tick and the five-second sweep, started with the first server. */
let timers = null;
function startTimers() {
  if (timers) return;
  timers = [
    setInterval(() => void tick().catch(() => {}), 500),
    setInterval(() => void sweep().catch(() => {}), 5000),
  ];
  for (const timer of timers) timer.unref();
}
export function createServer() {
  startTimers();
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
          reservedBytes: [...jobs.values()].reduce(
            (n, j) => n + (j.reservedBytes ?? 0),
            0
          ),
          maxJobs: limit,
          maxCopyJobs: copyLimit,
          viewers: viewers.size,
          jobs: [...jobs.values()].map(healthOf),
          probeSources,
        });
      if (req.method === 'POST' && url.pathname === '/probe')
        return send(await probed(inputUrl((await json(req)).input)));
      if (req.method === 'POST' && url.pathname === '/subtitle') {
        // A subtitle track as a file, extracted once per file (`file`: the source file's
        // identity, the same across new links to it): WebVTT for text, the track itself for ASS
        // and PGS, which the browser draws.
        const body = await json(req);
        const input = inputUrl(body.input);
        const format = SUBTITLE_FORMATS[body.format ?? 'vtt'];
        if (!format) throw bad('Unknown subtitle format');
        if (typeof body.file !== 'string' || !body.file)
          throw bad('Unknown source file');
        const meta = await probe(input);
        const track = meta.tracks.find(
          (t) => t.type === 'subtitle' && t.index === body.index
        );
        if (!track || subtitleKind(track.codec) !== format.kind)
          throw bad('Unknown subtitle track');
        const spec = {
          subtitle: { track: body.index, where: 'page', format: format.kind },
        };
        const key = keyOf('subtitle', input, spec, body.file);
        let job = matching('subtitle', key, 0);
        if (!job) {
          const running = [...jobs.values()].filter(
            (j) => j.kind === 'subtitle' && !j.ready && !j.failure
          );
          if (running.length >= SUBTITLE_RUNS)
            throw capacityError('Subtitle extraction capacity reached');
          job = newJob('subtitle', key, {
            input,
            meta,
            request: {},
            spec,
            positionMs: 0,
            format: body.format ?? 'vtt',
          });
          jobs.set(job.id, job);
          setStage(job, 'opening');
          await launch([job]);
        }
        // Held by the viewer asking, released with its other jobs.
        const viewer =
          typeof body.viewer === 'string' ? viewers.get(body.viewer) : null;
        if (viewer && !job.viewers.has(viewer.lease)) {
          job.viewers.add(viewer.lease);
          viewer.jobs.subtitle = job.id;
        }
        job.last = Date.now();
        return sendSubtitle(res, job, !!body.partial);
      }
      if (req.method === 'POST' && url.pathname === '/font') {
        // A font attached to the file, which its ASS subtitles use. MKV
        // keeps attachments at its start, so this reads little of it.
        const body = await json(req);
        const input = inputUrl(body.input);
        const font = (await probe(input)).fonts.find(
          (f) => f.index === body.index
        );
        if (!font) throw bad('Unknown font');
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
        // Answers at once: the viewer, its jobs and the spec asked for. The state says when it
        // plays (`/viewers/:lease/state`).
        const body = await json(req);
        const meta = await probed(inputUrl(body.input));
        const admitted = admit(body, meta);
        if (admitted.mode === 'direct') return send(admitted);
        await launch(admitted.fresh);
        const { viewer } = admitted;
        return send({
          lease: viewer.lease,
          ...stateOf(viewer),
          meta,
        });
      }
      const viewerMatch =
        /^\/viewers\/([A-Za-z0-9_-]+)\/(state|touch|release|manifest\.mpd)$/.exec(
          url.pathname
        );
      if (viewerMatch) {
        const viewer = viewers.get(viewerMatch[1]);
        const what = viewerMatch[2];
        if (what === 'release' && req.method === 'POST')
          return send({ released: releaseViewer(viewerMatch[1]) });
        if (!viewer) {
          const gone = Error('Unknown viewer');
          gone.status = 404;
          throw gone;
        }
        if (what === 'state' && req.method === 'GET')
          return send(
            await stateAfter(
              viewer,
              Number(url.searchParams.get('after') ?? -1)
            )
          );
        if (what === 'touch' && req.method === 'POST') {
          const body = await json(req);
          viewer.at = Date.now();
          if (Number.isFinite(body.positionMs))
            viewer.positionMs = body.positionMs;
          for (const job of Object.values(jobsOf(viewer)))
            if (job) job.last = Date.now();
          return send({ ok: true });
        }
        if (what === 'manifest.mpd' && req.method === 'GET') {
          const state = stateOf(viewer);
          if (state.failure) {
            const error = Error(state.failure.reason);
            Object.assign(error, state.failure);
            throw error;
          }
          if (!state.ready) {
            const missing = Error('Not written yet');
            missing.status = 404;
            throw missing;
          }
          res.setHeader('Content-Type', 'application/dash+xml');
          res.end(await manifestOf(viewer));
          return;
        }
      }
      const match =
        /^\/jobs\/([A-Za-z0-9_-]+)\/(init-0\.m4s|chunk-0-(\d+)\.m4s)$/.exec(
          url.pathname
        );
      const job = match && jobs.get(match[1]);
      if (!job || req.method !== 'GET') {
        res.writeHead(404).end();
        return;
      }
      if (job.failure)
        throw Object.assign(Error(job.failure.reason), job.failure);
      // Behind the window: deleted, and not coming back.
      if (match[3] && Number(match[3]) < (job.firstKept ?? 1)) {
        const gone = Error('Segment left the window');
        gone.status = 410;
        throw gone;
      }
      const file = `${job.dir}/${match[2]}`;
      const size = await stat(file).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
        const missing = Error('Not written yet');
        missing.status = 404;
        throw missing;
      });
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Length', size.size);
      await pipeline(createReadStream(file), res);
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      // Native errors may contain source URLs: pass on only their code.
      const native = !!(error.code && error.syscall) || !!error.cmd;
      // Request errors say 400 (`bad`), capacity 503, a failed source 502; anything else is ours.
      const status = error.status ?? 500;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        ...(error.retryAfter
          ? { 'Retry-After': String(error.retryAfter) }
          : {}),
      });
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
      res.end(
        JSON.stringify({
          error: message,
          retryAfter: error.retryAfter,
          class: error.class,
          code: native ? undefined : error.code,
        })
      );
    }
  });
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

  for (const signal of ['SIGTERM', 'SIGINT'])
    process.on(signal, () => {
      for (const timer of timers ?? []) clearInterval(timer);
      for (const j of jobs.values()) stop(j);
      server.close(() => process.exit());
      setTimeout(() => process.exit(), 5000).unref();
    });
}
