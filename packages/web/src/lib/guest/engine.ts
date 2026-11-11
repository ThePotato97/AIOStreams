import { t } from '@lingui/core/macro';
import { toast } from 'sonner';
import type React from 'react';
import type { GuestPlayback } from '@aiostreams/core';
import type {
  EngineFactory,
  EngineFile,
  EngineEvent,
  EngineTrack,
} from '../playback/engine';
import { chooseTracks } from '../playback/track-picks';
import { videoEngine } from '../playback/video';
import {
  clearBufferError,
  lastBufferError,
  watchBufferErrors,
} from '../playback/media-errors';
import { explainFailure } from './explain';
import { DoviCapture } from '../playback/dovi/capture';
import { DoviView } from '../playback/dovi/view';
import {
  registerBinauralTransmuxer,
  renderSpeed,
  TRANSMUXING_FAILED,
} from '../playback/binaural/transmuxer';
import { bufferReason } from './buffering';
import { watchHeadphones } from '../playback/headphone-setting';
import {
  localAudio,
  surroundOutput,
  type HeadphoneMode,
} from '../playback/binaural/local-audio';
import { sceneStore } from '../playback/binaural/objects';
import { browserCapabilities } from './capabilities';
import type { GuestApi, GuestCurrent } from './api';
import { sleep, whenReady } from './ready';
import { renderAss, renderPgs, type Renderer } from './subtitle-renderer';
import {
  afterFailure,
  CRITICAL,
  elementFailure,
  interrupted,
  recovery,
  sessionGone,
  shakaFailure,
  rejectedMedia,
  type Failure,
  type ShakaError,
  type Tries,
} from './failure';

/** The parts of Shaka Player used here (its own types are `any`). */
interface ShakaPlayer extends EventTarget {
  configure(config: object): boolean;
  attach(video: HTMLMediaElement): Promise<void>;
  load(uri: string, startTime?: number | null): Promise<void>;
  retryStreaming(retryDelaySeconds?: number): boolean;
  destroy(): Promise<void>;
  getManifest(): {
    presentationTimeline?: { getMaxSegmentEndTime(): number | null };
  } | null;
  getNetworkingEngine?(): {
    registerResponseFilter(filter: DoviCapture['filter']): void;
  } | null;
  /** The connection's estimate and the playing stream's bitrate, in bits a second. */
  getStats?(): { estimatedBandwidth?: number; streamBandwidth?: number };
}
type Shaka = {
  Player: { new (): ShakaPlayer; isBrowserSupported(): boolean };
  polyfill: { installAll(): void };
} & Parameters<typeof registerBinauralTransmuxer>[0];
const isShakaError = (error: unknown): error is ShakaError =>
  typeof (error as ShakaError)?.category === 'number' &&
  typeof (error as ShakaError)?.code === 'number';
/** How long a media failure waits for the element's own error (the browser's reason). */
const ELEMENT_ERROR_WAIT_MS = 1000;
/** How often the reason a converted stream is buffering is worked out again, while it is. */
const REASON_MS = 2000;
/** Retries for one manifest or segment request, before the player reports it. */
const RETRY = {
  maxAttempts: 4,
  baseDelay: 1000,
  backoffFactor: 2,
  timeout: 30000,
};
/**
 * A converted stream is a DASH manifest still being written ("dynamic"). The
 * manifest's presentation delay and minimum buffer (FFmpeg writes 10 s and
 * twice a segment) are ignored: playback can start as soon as a segment is
 * written, and party sync keeps its own margin from the newest one.
 */
const SHAKA_CONFIG = {
  manifest: {
    retryParameters: RETRY,
    defaultPresentationDelay: 0,
    dash: { ignoreMinBufferTime: true, ignoreSuggestedPresentationDelay: true },
  },
  streaming: {
    retryParameters: RETRY,
    bufferingGoal: 60,
    rebufferingGoal: 2,
    bufferBehind: 30,
  },
};

/** A target this little past what is written is waited for, not re-prepared. */
const UNWRITTEN_WAIT_MS = 60_000;
/** The longest a full transcoder is waited for before reporting it. */
const CAPACITY_WAIT_MS = 5 * 60_000;
/** Stays this far behind the newest written segment so playback doesn't stall at once. */
const EDGE_MARGIN_MS = 2_000;

/** Converts media-element time to the party's original-file timeline. */
export function guestEngine(
  video: React.RefObject<HTMLVideoElement | null>,
  api: GuestApi,
  current: () => GuestCurrent,
  onMode: (mode: string) => void,
  options: {
    /**
     * Whether a seek just past what is written waits for it rather than
     * converting from there. On for party sync, which asks again every couple
     * of seconds; off for a viewer's own seeks, which should land where asked.
     */
    holdUnwritten?: () => boolean;
    /**
     * Whether a stream the browser can't decode is converted in full before
     * playback is reported failed. Off for a user's own playback, which then
     * plays the file directly instead.
     */
    convertOnDecodeError?: boolean;
    /** The error shown once playback fails, from what failed. */
    failedMessage?: (detail: string) => string;
    /** The playback session is gone; reported as failed unless handled. */
    onExpired?: (message: string) => void;
  } = {}
) {
  const holdUnwritten = options.holdUnwritten ?? (() => true);
  const convertOnDecodeError = options.convertOnDecodeError ?? true;
  const failedMessage =
    options.failedMessage ??
    ((detail: string) =>
      t`${detail}. Try another quality or ask the host to select another source.`);
  let changeQuality: (
    quality: 'original' | '1080p' | '720p'
  ) => void = () => {};
  const factory: EngineFactory = (emit) => {
    let playback: GuestPlayback | null = null;
    let file: EngineFile | null = null;
    let generation = 0;
    let controller: AbortController | undefined;
    let player: ShakaPlayer | undefined;
    /** The manifest the player plays, for reloading it. */
    let manifest = '';
    /** Errors already handled: a failed load also reports its error. */
    const handled = new WeakSet<object>();
    let force = false;
    /** `force` came from the audio failing: another audio track starts without it. */
    let forcedByAudio = false;
    /** The browser's own binaural rendering failed: the server renders this audio track. */
    let serverBinaural = false;
    /** Binaural audio failed to play: this audio track plays without it, the browser's virtualiser on. */
    let noBinaural = false;
    /** Drawing Dolby Vision here failed: the server handles it for the rest of this file. */
    let noDovi = false;
    let doviView: DoviView | null = null;
    /** Recoveries tried since a fragment last played. */
    let tries: Tries = { network: 0, media: 0 };
    /** The prepare whose playback has been reported failed, once. */
    let failedAt = -1;
    let quality: 'original' | '1080p' | '720p' = 'original';
    let audio: number | undefined, subtitle: number | undefined;
    let paused = true,
      preparing = false;
    /** Where the in-flight prepare should start playing; seeks move it. */
    let target = 0;
    const position = () =>
      (video.current?.currentTime ?? 0) * 1000 + (playback?.offsetMs ?? 0);
    /** The file's audio and subtitle tracks, as the player lists them. */
    const engineTracks = (): EngineTrack[] =>
      current()
        .media.tracks.filter((t) => t.type === 'audio' || t.type === 'subtitle')
        .map((t) => ({
          id: String(t.index),
          type: t.type as 'audio' | 'subtitle',
          label: t.title,
          title: t.title,
          codec: t.codec,
          profile: t.profile,
          channels: t.channels,
          layout: t.layout,
          lang: t.language,
          default: t.default,
          forced: t.forced,
          hearingImpaired: t.hearingImpaired,
          visualImpaired: t.visualImpaired,
        }));
    /**
     * The tracks a file opens with, from the user's settings (languages, track types, the default
     * track setting, subtitle mode) as the player picks them for any engine, starting from the
     * file's default audio track. A server subtitle is left to the player, which adds it once
     * the file plays.
     */
    const pickTracks = (next: EngineFile) => {
      const tracks = engineTracks();
      const audios = tracks.filter((t) => t.type === 'audio');
      const fileDefault = (audios.find((t) => t.default) ?? audios[0])?.id;
      const picks = chooseTracks(
        tracks,
        next.subtitles ?? [],
        { audio: fileDefault ?? null, subtitle: null },
        next.prefs ?? {},
        next.source ?? {},
        false
      );
      const own = (id: string | null, type: 'audio' | 'subtitle') =>
        id != null && tracks.some((t) => t.type === type && t.id === id)
          ? Number(id)
          : undefined;
      return {
        audio:
          own(picks.audio, 'audio') ??
          (fileDefault == null ? undefined : Number(fileDefault)),
        subtitle: own(picks.subtitle, 'subtitle'),
      };
    };
    const listTracks = () => {
      const tracks = engineTracks();
      emit({ type: 'tracks', tracks });
      emit({ type: 'chapters', chapters: current().media.chapters });
      emit({
        type: 'state',
        state: {
          audio: audio == null ? null : String(audio),
          subtitle: subtitle == null ? null : String(subtitle),
        },
      });
    };
    const expired = (message: string) => {
      if (failedAt === generation) return;
      failedAt = generation;
      if (options.onExpired) options.onExpired(message);
      else emit({ type: 'failed', error: message });
    };
    /** Playback failed past recovering: convert all of it, or report it. */
    const fail = (failure: Failure) => {
      if (failedAt === generation) return;
      if (sessionGone(failure.status)) return expired(failure.detail);
      const at = position();
      if (
        playback &&
        afterFailure(failure, { forced: force, convertOnDecodeError }) ===
          'convert-all'
      ) {
        force = true;
        forcedByAudio =
          failure.kind === 'media' && failure.media?.stream === 'audio';
        void prepare(at);
        return;
      }
      failedAt = generation;
      emit({
        type: 'failed',
        error: failedMessage(explainFailure(failure)),
        retry: { label: t`Retry`, run: () => void prepare(at) },
        // The converted stream couldn't be fetched: the server or transcoder failed.
        transcoder:
          failure.kind === 'network' &&
          (failure.status == null || failure.status >= 500),
      });
    };
    /** Loads the manifest at a position; a failure goes to recovery. */
    const play = (at: number, startTime: number | null) => {
      const current = player;
      if (!current) return;
      current.load(manifest, startTime).catch((error: unknown) => {
        if (at !== generation || current !== player) return;
        if (isShakaError(error)) {
          if (interrupted(error) || handled.has(error)) return;
          handled.add(error);
          if (binauralFailed(error)) return;
          report(error, () => at === generation && current === player);
        } else fail({ kind: 'other', detail: (error as Error).message });
      });
    };
    /**
     * A Shaka error to recovery, with what the browser says about it: where it rejected media, its
     * element error (the browser's reason) usually comes just after Shaka's, so it's waited for
     * briefly.
     */
    const report = (error: ShakaError, live: () => boolean) => {
      const now = () =>
        recover(
          shakaFailure(error, {
            element: video.current?.error,
            buffer: lastBufferError(),
          })
        );
      const el = video.current;
      if (
        !rejectedMedia(error) ||
        !el ||
        el.error ||
        typeof el.addEventListener !== 'function'
      )
        return now();
      const done = () => {
        el.removeEventListener('error', done);
        clearTimeout(timer);
        if (live()) now();
      };
      const timer = setTimeout(done, ELEMENT_ERROR_WAIT_MS);
      el.addEventListener('error', done);
    };
    /** What the player tries first: fetch the stream again, or reload it where it was. */
    /** The browser couldn't render the audio to binaural: the server does it instead, from here. */
    const binauralFailed = (error: ShakaError) => {
      if (error.code !== TRANSMUXING_FAILED || !playback?.clientBinaural)
        return false;
      serverBinaural = true;
      void prepare(position());
      return true;
    };
    /**
     * The binaural audio (the server's or this browser's) failed to play: the file goes on from
     * where it was without it, rather than stopping. A failure of the video isn't its doing.
     */
    const dropBinaural = (failure: Failure) => {
      if (
        noBinaural ||
        failure.kind !== 'media' ||
        failure.media?.stream === 'video' ||
        !(playback?.binaural || playback?.clientBinaural)
      )
        return false;
      noBinaural = true;
      toast.message(
        t`Binaural audio couldn't play, so it's off for this audio track`,
        {
          description: explainFailure(failure),
        }
      );
      void prepare(position());
      return true;
    };
    /**
     * Drawing Dolby Vision here failed. Where the server sent it as it is for this browser to draw
     * (profile 5, whose picture is wrong without its RPU) it converts it instead, from where
     * playback was; otherwise the video's own HDR10 picture shows, as before.
     */
    const doviFailed = (error: Error) => {
      doviView = null;
      if (noDovi) return;
      noDovi = true;
      if (!playback?.dovi) return;
      toast.message(
        t`Dolby Vision couldn't be shown here, so the server converts it`,
        {
          description: error.message,
        }
      );
      void prepare(position());
    };
    const recover = (failure: Failure) => {
      if (dropBinaural(failure)) return;
      const step = player ? recovery(failure, tries) : 'give-up';
      const at = generation;
      const here = () => video.current?.currentTime ?? null;
      if (step === 'reload') {
        tries.network++;
        // The newest segments may not be written yet: give them a moment.
        setTimeout(() => {
          if (at !== generation || !player) return;
          if (!player.retryStreaming()) play(at, here());
        }, 2000 * tries.network);
        return;
      }
      if (step === 'recover-media') {
        tries.media++;
        play(at, here());
        return;
      }
      fail(failure);
    };
    const nativeEvent = (event: EngineEvent) => {
      if (event.type === 'failed') {
        // The element's own error says why; the raw engine's text doesn't.
        // Shaka reports its own element's errors, as an error event.
        if (player) return;
        return fail(elementFailure(video.current?.error));
      }
      if (event.type === 'tracks') return;
      if (event.type === 'position')
        return emit({
          ...event,
          positionMs:
            event.positionMs == null
              ? undefined
              : event.positionMs + (playback?.offsetMs ?? 0),
          buffered: event.buffered?.map((r) => ({
            startMs: r.startMs + (playback?.offsetMs ?? 0),
            endMs: r.endMs + (playback?.offsetMs ?? 0),
          })),
        });
      if (event.type === 'state') {
        const state = { ...event.state };
        if (state.durationMs != null)
          state.durationMs = current().media.durationMs;
        if (state.audio !== undefined)
          state.audio = audio == null ? null : String(audio);
        if (state.subtitle !== undefined)
          state.subtitle = subtitle == null ? null : String(subtitle);
        // Shaka holds playback while buffering by setting the rate to 0; the
        // viewer's speed is unchanged, and buffering shows as waiting.
        if (player && state.rate === 0) delete state.rate;
        return emit({ type: 'state', state });
      }
      if (event.type === 'loaded') listTracks();
      emit(event);
    };
    /** Refreshes why a converted stream is buffering, while it is. */
    let reasonTimer: ReturnType<typeof setInterval> | undefined;
    const waitingReason = (shaka: ShakaPlayer): string | null => {
      const el = video.current;
      const now = el?.currentTime ?? 0;
      let bufferedEnd: number | null = null;
      if (el?.buffered)
        for (let i = 0; i < el.buffered.length; i++)
          if (el.buffered.start(i) <= now + 0.5 && el.buffered.end(i) >= now)
            bufferedEnd = el.buffered.end(i);
      const stats = shaka.getStats?.();
      const reason = bufferReason({
        bufferedEnd: bufferedEnd ?? now,
        writtenEnd:
          shaka.getManifest()?.presentationTimeline?.getMaxSegmentEndTime() ??
          null,
        estimatedBps: stats?.estimatedBandwidth,
        streamBps: stats?.streamBandwidth,
        renderSpeed: playback?.clientBinaural ? renderSpeed() : null,
      });
      const mbps = (bps: number) => (bps / 1e6).toFixed(bps < 1e7 ? 1 : 0);
      switch (reason?.kind) {
        case 'server':
          return t`Waiting for the server, which hasn't converted this far yet`;
        case 'device': {
          const speed = reason.speed.toFixed(1);
          return t`This device converts the audio slower than it plays (${speed}× real time)`;
        }
        case 'network': {
          const have = mbps(reason.haveBps);
          const need = mbps(reason.needBps);
          return t`Your connection (${have} Mb/s) is slower than this stream (${need} Mb/s): try a lower quality`;
        }
        default:
          return null;
      }
    };
    const stop = () => {
      clearInterval(reasonTimer);
      const old = player;
      player = undefined;
      doviView?.destroy();
      doviView = null;
      return old?.destroy().catch(() => {});
    };
    const raw = videoEngine(video, async (el, url) => {
      const at = generation;
      await stop();
      if (at !== generation) return;
      // The original file plays as it is.
      if (!url.includes('.mpd')) {
        el.src = url;
        return;
      }
      try {
        const { default: shaka } =
          (await import('shaka-player')) as unknown as {
            default: Shaka;
          };
        if (at !== generation) return;
        shaka.polyfill.installAll();
        // Which media buffer the browser rejects, for the error shown.
        watchBufferErrors();
        clearBufferError();
        // TrueHD the transcoder left for this browser to render to binaural.
        registerBinauralTransmuxer(shaka);
        if (!shaka.Player.isBrowserSupported())
          throw Error('This browser cannot play converted streams');
        const next = new shaka.Player();
        player = next;
        manifest = url;
        next.configure(SHAKA_CONFIG);
        // Dolby Vision drawn here, from each frame's RPU, where this browser can
        const capture = new DoviCapture();
        next.getNetworkingEngine?.()?.registerResponseFilter(capture.filter);
        capture.onSeen(() => {
          if (noDovi || at !== generation || player !== next || !video.current)
            return;
          void DoviView.start(video.current, capture, (error) =>
            doviFailed(error)
          ).then((view) => {
            if (!view) return;
            if (at !== generation || player !== next) view.destroy();
            else doviView = view;
          });
        });
        next.addEventListener('error', (event) => {
          const error = (event as CustomEvent<ShakaError>).detail;
          if (at !== generation || player !== next || handled.has(error))
            return;
          // Shaka handles the rest itself.
          if (error.severity !== CRITICAL || interrupted(error)) return;
          handled.add(error);
          if (binauralFailed(error)) return;
          report(error, () => at === generation && player === next);
        });
        next.addEventListener('buffering', (event) => {
          if (at !== generation || player !== next) return;
          const { buffering } = event as Event & { buffering?: boolean };
          // why, while it lasts: what holds it up can change as it waits
          clearInterval(reasonTimer);
          const tell = () => {
            if (at !== generation || player !== next) {
              clearInterval(reasonTimer);
              return;
            }
            emit({
              type: 'state',
              state: { waiting: true, waitingFor: waitingReason(next) },
            });
          };
          if (!buffering) {
            emit({
              type: 'state',
              state: { waiting: false, waitingFor: null },
            });
            return;
          }
          tell();
          reasonTimer = setInterval(tell, REASON_MS);
        });
        // Recoveries are counted again once the stream plays on.
        next.addEventListener('segmentappended', () => {
          tries = { network: 0, media: 0 };
        });
        await next.attach(el);
        if (at !== generation || player !== next) return;
        // Positions are the source's own: the manifest keeps its timestamps.
        play(at, Math.max(0, target - (playback?.offsetMs ?? 0)) / 1000);
      } catch (error) {
        if (at === generation)
          emit({ type: 'failed', error: (error as Error).message });
      }
    })(nativeEvent, {});
    /** The ASS or PGS subtitle being drawn over the video. */
    let renderer: Renderer | undefined;
    /** Formats whose renderer failed here: those are burned in instead. */
    const unrendered = new Set<'ass' | 'pgs'>();
    const stopRenderer = () => {
      renderer?.destroy();
      renderer = undefined;
    };
    /** Attaches a subtitle once the server has it: extraction may take minutes. */
    const attachSubtitle = async (
      result: GuestPlayback,
      at: number,
      signal: AbortSignal
    ) => {
      const url = new URL(result.subtitleUrl!, window.location.href).href;
      const format = result.subtitleFormat ?? 'vtt';
      try {
        const res = await whenReady(url, signal);
        if (at !== generation || !res.ok) return;
        if (format === 'vtt') {
          const text = await res.text();
          if (at !== generation) return;
          const id = String(subtitle);
          raw.addServerSubtitle?.({
            id,
            label: t`Subtitles`,
            url: URL.createObjectURL(new Blob([text], { type: 'text/vtt' })),
            stream: { Index: subtitle },
          });
          raw.setSubtitle(id);
          return;
        }
        const el = video.current;
        if (!el) return;
        const drawn =
          format === 'ass'
            ? await renderAss(
                el,
                await res.text(),
                (result.fontUrls ?? []).map(
                  (font) => new URL(font, window.location.href).href
                )
              )
            : await renderPgs(el, await res.arrayBuffer());
        if (at !== generation) return drawn.destroy();
        renderer = drawn;
      } catch {
        if (at !== generation || signal.aborted) return;
        // The renderer didn't load or run: have this track burned in.
        const kind = format === 'ass' ? 'ass' : 'pgs';
        // Once per format: a server that still sends it isn't asked again.
        if (format !== 'vtt' && !unrendered.has(kind)) {
          unrendered.add(kind);
          void prepare(position());
        }
      }
    };
    async function prepare(positionMs: number, waitedMs = 0) {
      if (!file) return;
      const at = ++generation;
      controller?.abort();
      controller = new AbortController();
      tries = { network: 0, media: 0 };
      preparing = true;
      target = positionMs;
      emit({ type: 'state', state: { waiting: true, loaded: false } });
      raw.setPaused(true);
      stopRenderer();
      const info = current();
      try {
        askedHeadphones = headphones;
        askedMode = headphoneMode;
        const probed = await browserCapabilities(
          info.media,
          audio,
          headphones,
          headphoneMode
        );
        const capabilities = {
          ...probed,
          subtitles: (probed.subtitles ?? []).filter((f) => !unrendered.has(f)),
          clientBinaural:
            serverBinaural || noBinaural ? undefined : probed.clientBinaural,
          ...(noBinaural ? { binaural: false } : {}),
          dovi: noDovi ? undefined : probed.dovi,
        };
        const result = await api.prepare(
          {
            revision: info.revision,
            positionMs,
            quality,
            audio,
            subtitle,
            force,
            capabilities,
          },
          controller.signal
        );
        if (at !== generation) return;
        playback = result;
        onMode(result.mode);
        // What the page's conversion of TrueHD or E-AC-3 makes, where the server copied it
        const track = info.media.tracks.find(
          (t) => t.type === 'audio' && t.index === audio
        );
        localAudio.ask({
          headphones,
          mode: headphoneMode,
          surround: surroundOutput(),
          trackChannels: track?.channels ?? 2,
        });
        raw.load({
          ...file,
          url: new URL(result.url, window.location.href).href,
          startMs: Math.max(0, target - result.offsetMs),
          paused,
          subtitles: [],
          // Rendered on the server or here: either way no virtualiser on top.
          binaural: !!result.binaural || !!result.clientBinaural,
        });
        if (result.subtitleUrl)
          void attachSubtitle(result, at, controller.signal);
        listTracks();
      } catch (error) {
        if (at !== generation || controller.signal.aborted) return;
        const { status, message, retryAfter, code } = error as Error & {
          status?: number;
          retryAfter?: number;
          code?: string;
        };
        // A full transcoder frees a place as viewers leave: wait for one.
        const ms = Math.max(1, retryAfter ?? 0) * 1000;
        if (
          status === 503 &&
          retryAfter != null &&
          waitedMs + ms <= CAPACITY_WAIT_MS
        ) {
          const signal = controller.signal;
          preparing = false;
          void sleep(ms, signal)
            .then(() => {
              if (at === generation) void prepare(positionMs, waitedMs + ms);
            })
            .catch(() => {});
          return;
        }
        if (sessionGone(status)) expired(message);
        else
          emit({
            type: 'failed',
            error: (error as Error).message,
            retry: { label: t`Retry`, run: () => void prepare(positionMs) },
            transcoder: status === 503 || !!code?.startsWith('transcoder_'),
          });
      } finally {
        if (at === generation) preparing = false;
      }
    }
    changeQuality = (next) => {
      quality = next;
      void prepare(position());
    };
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    // Converted surround is kept for headphones, and downmixed without them:
    // a change prepares again, as does the setting read only after a prepare.
    let headphones = false;
    let headphoneMode: HeadphoneMode = 'mixed';
    /** What the last prepare asked for. */
    let askedHeadphones: boolean | null = null;
    let askedMode: HeadphoneMode | null = null;
    let unwatch: (() => void) | null = null;
    // The debug view's switched-off elements: the page renders them as silence, so a change
    // converts again from the same job's segments, once the clicks settle.
    let unwatchDisabled: (() => void) | null = null;
    let disabledTimer: ReturnType<typeof setTimeout> | undefined;
    const watchDisabled = () => {
      unwatchDisabled ??= sceneStore.subscribeDisabled(() => {
        clearTimeout(disabledTimer);
        disabledTimer = setTimeout(() => {
          if (playback?.clientBinaural && !preparing) void prepare(position());
        }, 600);
      });
    };
    const watch = () => {
      unwatch ??= watchHeadphones((now, mode) => {
        // the binaural render playing (or carried) is in another mode than the listener's now
        const staleMode = askedMode !== null && askedMode !== mode;
        headphones = now;
        headphoneMode = mode;
        if (askedHeadphones === null) return;
        // Converted in the page (the server copied the track either way): a stream carrying both
        // outputs switches at once in the page's audio graph. A stale mode with headphones on, or
        // a stream carrying only one output, is converted again from the same job's segments.
        if (playback?.clientBinaural && !preparing) {
          const both = localAudio.current?.contents === 'both';
          if ((now && staleMode) || (askedHeadphones !== now && !both))
            void prepare(position());
          return;
        }
        // The server renders binaural in the listener's mode: a new one is a new job.
        if (staleMode && now && playback?.binaural) {
          void prepare(preparing ? target : position());
          return;
        }
        if (askedHeadphones === now) return;
        const track = current().media.tracks.find(
          (t) => t.type === 'audio' && t.index === audio
        );
        const converted = preparing
          ? true
          : playback?.mode === 'audio' || playback?.mode === 'video';
        // The server renders TrueHD and E-AC-3 to binaural for headphones: turning them on asks
        // for that, and turning them off leaves binaural audio that has to be converted again.
        const binaural =
          (now && (track?.codec === 'truehd' || track?.codec === 'eac3')) ||
          (!now && (!!playback?.binaural || !!playback?.clientBinaural));
        if ((converted && (track?.channels ?? 2) > 2) || binaural)
          void prepare(preparing ? target : position());
      });
    };
    const startHeartbeat = () => {
      clearInterval(heartbeat);
      heartbeat = setInterval(() => {
        if (playback)
          void api
            .request('/touch', {
              positionMs: position(),
              lease: playback.lease,
            })
            // A blip misses one heartbeat, which the next makes up for;
            // only a playback the server has dropped stops here.
            .catch((error: Error & { status?: number }) => {
              if (sessionGone(error.status)) expired(error.message);
            });
      }, 10000);
    };
    return {
      ...raw,
      ownSubtitles: true,
      subtitleFiles: undefined,
      ownText: undefined,
      picksTracks: true,
      load(next) {
        startHeartbeat();
        watch();
        watchDisabled();
        // another title's elements; the prepare below converts it with them all on
        sceneStore.allOn();
        clearTimeout(disabledTimer);
        playback = null;
        file = next;
        force = forcedByAudio = false;
        serverBinaural = false;
        noBinaural = false;
        noDovi = false;
        paused = next.paused ?? true;
        ({ audio, subtitle } = pickTracks(next));
        void prepare(next.startMs);
      },
      seek(ms) {
        if (preparing) {
          // A small move just changes where the prepared stream starts (the
          // companion reuses a job up to 8 s past what it has produced); a
          // larger one needs a prepare at the new position.
          if (Math.abs(ms - target) <= 8000) target = ms;
          else void prepare(ms);
          return;
        }
        const local = ms - (playback?.offsetMs ?? 0);
        const el = video.current;
        const ranges = el
          ? Array.from({ length: el.seekable.length }, (_, i) => ({
              start: el.seekable.start(i) * 1000,
              end: el.seekable.end(i) * 1000,
            }))
          : [];
        // A live manifest's seekable range follows the clock, behind a
        // conversion that runs ahead of it: what's converted ends where the
        // manifest's last segment does.
        const converted = player
          ?.getManifest()
          ?.presentationTimeline?.getMaxSegmentEndTime();
        if (converted != null && ranges.length) {
          const last = ranges.at(-1)!;
          last.end = Math.max(last.end, converted * 1000);
        }
        const available =
          playback?.mode === 'direct' ||
          ranges.some((r) => local >= r.start && local <= r.end);
        if (local >= 0 && available) return raw.seek(local);
        // A converted stream is written as it plays. Party sync asks a guest
        // who fell behind for the host's position, which often isn't written
        // yet; a new prepare there restarts the stream and lands further back,
        // and sync asks again. Instead, go as far as is written and let the
        // stream catch up, unless the target is far enough ahead that a fresh
        // conversion there gets to it sooner.
        const edge = ranges.length ? Math.max(...ranges.map((r) => r.end)) : 0;
        if (
          holdUnwritten() &&
          playback &&
          playback.mode !== 'direct' &&
          local > edge &&
          local - edge <= UNWRITTEN_WAIT_MS
        ) {
          const now = (el?.currentTime ?? 0) * 1000;
          if (edge - now > EDGE_MARGIN_MS) raw.seek(edge - EDGE_MARGIN_MS);
          return;
        }
        void prepare(ms);
      },
      setPaused(next) {
        paused = next;
        if (!preparing) raw.setPaused(next);
      },
      setAudio(id) {
        const next = Number(id);
        if (audio === next) return;
        audio = next;
        // What failed was this track: another one starts afresh, rendered here where it can be.
        // A full conversion the video needed stays.
        if (forcedByAudio) force = forcedByAudio = false;
        serverBinaural = false;
        noBinaural = false;
        // another track's elements; the prepare below converts it with them all on
        sceneStore.allOn();
        clearTimeout(disabledTimer);
        void prepare(position());
      },
      setSubtitle(id) {
        const next = id == null ? undefined : Number(id);
        if (subtitle === next) return;
        subtitle = next;
        void prepare(position());
      },
      close() {
        ++generation;
        controller?.abort();
        void stop();
        stopRenderer();
        raw.close();
        clearInterval(heartbeat);
        unwatch?.();
        unwatch = null;
        clearTimeout(disabledTimer);
        unwatchDisabled?.();
        unwatchDisabled = null;
        // Nothing to release before a playback was ever prepared.
        if (playback?.lease)
          void api
            .request('/touch', {
              positionMs: 0,
              release: true,
              lease: playback.lease,
            })
            .catch(() => {});
      },
    };
  };
  return {
    factory,
    setQuality: (quality: 'original' | '1080p' | '720p') =>
      changeQuality(quality),
  };
}
