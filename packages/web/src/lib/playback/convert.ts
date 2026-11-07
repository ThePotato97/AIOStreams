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
 * A file still downloading is waited for; if conversion can't start at all,
 * the file plays directly, which at worst is silent, rather than not at all.
 */
export function convertingEngine(
  video: React.RefObject<HTMLVideoElement | null>,
  client: JellyfinClient
): EngineFactory {
  const root = relayBase(client.base) ?? client.base;
  const api = new OwnApi(root);
  let info: GuestCurrent | null = null;
  let opened = '';
  const inner = guestEngine(
    video,
    api,
    () => info!,
    () => {}
  );
  return (emit, opts) => {
    const converting = inner.factory(emit, opts);
    let direct: PlayerEngine | null = null;
    let active: PlayerEngine = converting;
    let loading = 0;
    const use = (engine: PlayerEngine) => {
      if (active !== engine) active.close();
      active = engine;
    };
    const playDirect = (next: EngineFile, reason?: string) => {
      direct ??= videoEngine(video)(emit, opts);
      use(direct);
      toast.warning(
        t`Couldn't convert the audio for this browser, so it may play without sound.`,
        { description: reason ?? t`Conversion is unavailable on this server.` }
      );
      direct.load(next);
    };
    const open = async (next: EngineFile, at: number) => {
      const itemId = next.item.Id!;
      const key = `${itemId}:${next.source.Id ?? ''}`;
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
      void open(next, at).then((ready) => {
        if (!ready || at !== loading) return;
        use(converting);
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
                active.close();
              }
            : Reflect.get(active, prop),
    });
  };
}
