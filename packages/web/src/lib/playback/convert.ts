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
 * A file still downloading is waited for. If conversion can't start, at open
 * or while preparing the stream, the file plays directly (silent at worst,
 * rather than not at all), and that item and version keep playing directly.
 */
export function convertingEngine(
  video: React.RefObject<HTMLVideoElement | null>,
  client: JellyfinClient
): EngineFactory {
  const root = relayBase(client.base) ?? client.base;
  const api = new OwnApi(root);
  let info: GuestCurrent | null = null;
  let opened = '';
  // Only party sync asks again and again for a spot not converted yet.
  const inner = guestEngine(
    video,
    api,
    () => info!,
    () => {},
    {
      holdUnwritten: () => !!party.state(),
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
    /** The load converting now, until it has loaded: a failure falls back. */
    let starting: EngineFile | null = null;
    const converting = inner.factory((event) => {
      if (active === converting && starting) {
        if (event.type === 'failed') {
          const next = starting;
          starting = null;
          return playDirect(next, event.error);
        }
        if (event.type === 'loaded') starting = null;
      }
      emit(event);
    }, opts);
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
    const load = (next: EngineFile) => {
      const at = ++loading;
      starting = null;
      if (direct.has(keyOf(next))) return loadDirect(next);
      void open(next, at).then((ready) => {
        if (!ready || at !== loading) return;
        use(converting);
        starting = next;
        converting.load(next);
      });
    };
    // Everything but load goes to whichever engine is playing.
    return new Proxy(converting, {
      get: (_target, prop) =>
        prop === 'load'
          ? load
          : prop === 'close'
            ? () => {
                loading++;
                starting = null;
                active.close();
              }
            : Reflect.get(active, prop),
    });
  };
}
