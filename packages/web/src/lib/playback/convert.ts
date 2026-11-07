/* eslint-disable lingui/no-unlocalized-strings -- MIME strings are browser API inputs, not UI text. */
import type React from 'react';
import type { GuestMedia, GuestPlayback } from '@aiostreams/core';
import type { JellyfinClient } from '../client';
import type { SourceInfo } from '../types';
import { codec } from '../guest/capabilities';
import { GuestApi, type GuestCurrent } from '../guest/api';
import { guestEngine } from '../guest/engine';
import { relayBase } from '../party/invite';
import { t } from '@lingui/core/macro';
import { toast } from 'sonner';
import type { EngineFactory, EngineFile, PlayerEngine } from './engine';
import { videoEngine } from './video';
import { afterOpenError, type OpenError } from './convert-plan';
import { serverSubtitles } from './server-subtitles';
import { party } from '../party/party';

/*
 * A browser plays the video of most releases but not their audio (E-AC-3,
 * DTS, TrueHD): direct play then runs silent. Those play through the
 * server's transcoder instead, which copies the video and converts only what
 * the browser can't decode.
 */

/** Whether this browser can't decode the source's default audio track. */
export function audioNeedsConversion(source: SourceInfo): boolean {
  if (typeof document === 'undefined') return false;
  const streams = source.MediaStreams ?? [];
  const audio =
    streams.find((s) => s.Type === 'Audio' && s.IsDefault) ??
    streams.find((s) => s.Type === 'Audio');
  // Unknown audio plays directly, as before.
  if (!audio?.Codec) return false;
  const name = audio.Codec.toLowerCase();
  const string = codec({
    index: 0,
    type: 'audio',
    codec: name,
    profile: audio.Profile ?? undefined,
    title: '',
  });
  // No browser decodes codecs without a string here (TrueHD, DTS, PCM in MKV).
  if (!string) return true;
  const type = `audio/${name === 'opus' || name === 'vorbis' ? 'webm' : 'mp4'}; codecs="${string}"`;
  const supported =
    !!document.createElement('audio').canPlayType(type) ||
    (typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(type));
  return !supported;
}

/** The server's own-playback API, with media URLs made absolute. */
class OwnApi extends GuestApi {
  constructor(private readonly root: string) {
    super(`${root}/party/guest/own`, '');
  }
  private absolute(url: string) {
    return new URL(url, `${this.root}/`).href;
  }
  override async prepare(
    body: Parameters<GuestApi['prepare']>[0],
    signal?: AbortSignal
  ): Promise<GuestPlayback> {
    const result = await super.prepare(body, signal);
    return {
      ...result,
      url: this.absolute(result.url),
      subtitleUrl: result.subtitleUrl && this.absolute(result.subtitleUrl),
    };
  }
}

/**
 * Plays through the transcoder for this signed-in user. Each load opens the
 * item and version it names, so switching version or episode converts the new
 * one; a version the browser can play whole is served as it is.
 *
 * A file still downloading is waited for. If conversion fails, at open, while
 * preparing the stream or while it plays, the file plays directly from the same
 * spot (silent at worst, rather than not at all), and that item and version
 * keep playing directly. Nothing here converts the video: a stream the browser
 * can't decode plays directly too.
 */
export function convertingEngine(
  video: React.RefObject<HTMLVideoElement | null>,
  client: JellyfinClient
): EngineFactory {
  const root = relayBase(client.base) ?? client.base;
  const api = new OwnApi(root);
  let info: GuestCurrent | null = null;
  let opened = '';
  /** The player's handler for a playback the server has dropped. */
  let onExpired = (_message: string) => {};
  const inner = guestEngine(
    video,
    api,
    () => info!,
    () => {},
    {
      // Only party sync asks again and again for a spot not converted yet.
      holdUnwritten: () => !!party.state(),
      convertOnDecodeError: false,
      failedMessage: (detail) => detail,
      onExpired: (message) => onExpired(message),
    }
  );
  /** Item and version keys that couldn't convert: they play directly. */
  const direct = new Set<string>();
  const keyOf = (file: EngineFile) =>
    `${file.item.Id ?? ''}:${file.source.Id ?? ''}`;
  return (emit, opts) => {
    let directEngine: PlayerEngine | null = null;
    let active: PlayerEngine;
    let loading = 0;
    /** The file converting now, and where and how it was playing last. */
    let playing: EngineFile | null = null;
    let positionMs = 0;
    let paused = true;
    const here = (next: EngineFile): EngineFile => ({
      ...next,
      startMs: positionMs,
      paused,
    });
    const converting = inner.factory((event) => {
      if (active === converting && playing) {
        if (event.type === 'failed') {
          const next = here(playing);
          playing = null;
          return playDirect(next, event.error);
        }
        if (event.type === 'position' && event.positionMs != null)
          positionMs = event.positionMs;
        if (event.type === 'state' && event.state.paused != null)
          paused = event.state.paused;
        if (event.type === 'loaded') reopened = false;
      }
      emit(event);
    }, opts);
    /** Opened again since it last loaded: a second loss plays it directly. */
    let reopened = false;
    // Opened again, from where it was, once the server has forgotten it.
    onExpired = (message) => {
      if (active !== converting || !playing) return;
      if (reopened) {
        const next = here(playing);
        playing = null;
        return playDirect(next, message);
      }
      reopened = true;
      opened = '';
      info = null;
      load(here(playing));
    };
    active = converting;
    const use = (engine: PlayerEngine) => {
      if (active !== engine) active.close();
      active = engine;
    };
    const loadDirect = (next: EngineFile) => {
      directEngine ??= videoEngine(video)(emit, opts);
      use(directEngine);
      // This engine reads the file's own subtitles, the converting one didn't.
      directEngine.load({
        ...next,
        subtitles: serverSubtitles(client, next.source, false),
      });
    };
    const playDirect = (next: EngineFile, reason?: string) => {
      direct.add(keyOf(next));
      toast.warning(
        t`Couldn't convert the audio for this browser, so it may play without sound.`,
        { description: reason ?? t`Conversion is unavailable on this server.` }
      );
      loadDirect(next);
    };
    const open = async (next: EngineFile, at: number) => {
      const itemId = next.item.Id!;
      const key = keyOf(next);
      if (key === opened && info) return true;
      const started = Date.now();
      for (let attempt = 0; ; attempt++) {
        try {
          const result = await new GuestApi(
            `${root}/party/guest/own`,
            client.token ?? ''
          ).request<{ token: string; revision: string; media: GuestMedia }>(
            '/open',
            { itemId, sourceId: next.source.Id ?? undefined }
          );
          if (at !== loading) return false;
          api.token = result.token;
          opened = key;
          info = {
            revision: result.revision,
            playlistItemId: '',
            itemId,
            title: next.item.Name ?? '',
            media: result.media,
          };
          return true;
        } catch (error) {
          if (at !== loading) return false;
          const plan = afterOpenError(
            error as OpenError,
            attempt,
            Date.now() - started
          );
          if (plan.action === 'direct') {
            playDirect(next, plan.reason);
            return false;
          }
          if (attempt === 0 && (error as OpenError).status === 425)
            toast.message(t`Still downloading; it starts when it's ready.`);
          emit({ type: 'state', state: { waiting: true, loaded: false } });
          await new Promise((r) => setTimeout(r, plan.ms));
          if (at !== loading) return false;
        }
      }
    };
    function load(next: EngineFile) {
      const at = ++loading;
      playing = null;
      if (direct.has(keyOf(next))) return loadDirect(next);
      void open(next, at).then((ready) => {
        if (!ready || at !== loading) return;
        use(converting);
        playing = next;
        positionMs = next.startMs;
        paused = next.paused ?? true;
        converting.load(next);
      });
    }
    // Everything but load goes to whichever engine is playing.
    return new Proxy(converting, {
      get: (_target, prop) =>
        prop === 'load'
          ? load
          : prop === 'close'
            ? () => {
                loading++;
                playing = null;
                active.close();
              }
            : Reflect.get(active, prop),
    });
  };
}
