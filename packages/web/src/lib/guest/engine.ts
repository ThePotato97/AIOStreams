import { t } from '@lingui/core/macro';
import type React from 'react';
import type Hls from 'hls.js';
import type { GuestPlayback } from '@aiostreams/core';
import type {
  EngineFactory,
  EngineFile,
  EngineEvent,
} from '../playback/engine';
import { videoEngine } from '../playback/video';
import { browserCapabilities } from './capabilities';
import type { GuestApi, GuestCurrent } from './api';

/** Converts media-element time to the party's original-file timeline. */
export function guestEngine(
  video: React.RefObject<HTMLVideoElement | null>,
  api: GuestApi,
  current: () => GuestCurrent,
  onMode: (mode: string) => void
) {
  let changeQuality: (
    quality: 'original' | '1080p' | '720p'
  ) => void = () => {};
  const factory: EngineFactory = (emit) => {
    let playback: GuestPlayback | null = null;
    let file: EngineFile | null = null;
    let generation = 0;
    let controller: AbortController | undefined;
    let hls: Hls | undefined;
    let force = false;
    let quality: 'original' | '1080p' | '720p' = 'original';
    let audio: number | undefined, subtitle: number | undefined;
    let paused = true,
      preparing = false;
    const position = () =>
      (video.current?.currentTime ?? 0) * 1000 + (playback?.offsetMs ?? 0);
    const listTracks = () => {
      const tracks = current()
        .media.tracks.filter((t) => t.type === 'audio' || t.type === 'subtitle')
        .map((t) => ({
          id: String(t.index),
          type: t.type as 'audio' | 'subtitle',
          label: t.title,
          codec: t.codec,
          lang: t.language,
        }));
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
    const nativeEvent = (event: EngineEvent) => {
      if (event.type === 'failed') {
        if (!force && playback) {
          force = true;
          void prepare(position());
          return;
        }
        return emit({
          type: 'failed',
          error: t`Playback failed. Try another quality or ask the host to select another source.`,
        });
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
        return emit({ type: 'state', state });
      }
      if (event.type === 'loaded') listTracks();
      emit(event);
    };
    const raw = videoEngine(video, async (el, url) => {
      hls?.destroy();
      hls = undefined;
      if (
        !url.includes('.m3u8') ||
        el.canPlayType('application/vnd.apple.mpegurl')
      ) {
        el.src = url;
        return;
      }
      const at = generation;
      try {
        const { default: Hls } = await import('hls.js');
        if (at !== generation) return;
        if (!Hls.isSupported())
          throw Error('HLS is not supported in this browser');
        hls = new Hls({ maxBufferLength: 60, maxMaxBufferLength: 120 });
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal && at === generation)
            nativeEvent({ type: 'failed', error: t`HLS playback failed` });
        });
        hls.loadSource(url);
        hls.attachMedia(el);
      } catch (error) {
        if (at === generation)
          emit({ type: 'failed', error: (error as Error).message });
      }
    })(nativeEvent, {});
    async function prepare(positionMs: number) {
      if (!file) return;
      const at = ++generation;
      controller?.abort();
      controller = new AbortController();
      preparing = true;
      emit({ type: 'state', state: { waiting: true, loaded: false } });
      raw.setPaused(true);
      const info = current();
      try {
        const capabilities = await browserCapabilities(info.media, audio);
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
        const track = result.subtitleUrl
          ? [
              {
                id: String(subtitle),
                label: t`Subtitles`,
                url: new URL(result.subtitleUrl, window.location.href).href,
                stream: { Index: subtitle },
              },
            ]
          : [];
        raw.load({
          ...file,
          url: new URL(result.url, window.location.href).href,
          startMs: Math.max(0, positionMs - result.offsetMs),
          paused,
          subtitles: track,
        });
        if (result.subtitleUrl) raw.setSubtitle(String(subtitle));
        listTracks();
      } catch (error) {
        if (at === generation && !controller.signal.aborted)
          emit({
            type: 'failed',
            error: (error as Error).message,
            retry: { label: t`Retry`, run: () => void prepare(positionMs) },
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
    const startHeartbeat = () => {
      clearInterval(heartbeat);
      heartbeat = setInterval(() => {
        if (playback)
          void api
            .request('/touch', {
              positionMs: position(),
              lease: playback.lease,
            })
            .catch((error) =>
              emit({ type: 'failed', error: (error as Error).message })
            );
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
        playback = null;
        file = next;
        force = false;
        paused = next.paused ?? true;
        const tracks = current().media.tracks;
        audio =
          tracks.find((t) => t.type === 'audio' && t.default)?.index ??
          tracks.find((t) => t.type === 'audio')?.index;
        subtitle = undefined;
        void prepare(next.startMs);
      },
      seek(ms) {
        if (preparing) return;
        const local = ms - (playback?.offsetMs ?? 0);
        const el = video.current;
        const available =
          playback?.mode === 'direct' ||
          (!!el &&
            Array.from({ length: el.seekable.length }, (_, i) => i).some(
              (i) =>
                local / 1000 >= el.seekable.start(i) &&
                local / 1000 <= el.seekable.end(i)
            ));
        if (local >= 0 && available) raw.seek(local);
        else void prepare(ms);
      },
      setPaused(next) {
        paused = next;
        if (!preparing) raw.setPaused(next);
      },
      setAudio(id) {
        const next = Number(id);
        if (audio === next) return;
        audio = next;
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
        hls?.destroy();
        raw.close();
        clearInterval(heartbeat);
        void api
          .request('/touch', {
            positionMs: 0,
            release: true,
            lease: playback?.lease,
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
