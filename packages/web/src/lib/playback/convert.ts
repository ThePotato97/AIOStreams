/* eslint-disable lingui/no-unlocalized-strings -- MIME strings are browser API inputs, not UI text. */
import type React from 'react';
import type { GuestMedia, GuestPlayback } from '@aiostreams/core';
import type { JellyfinClient } from '../client';
import type { SourceInfo } from '../types';
import { codec } from '../guest/capabilities';
import { GuestApi, type GuestCurrent } from '../guest/api';
import { guestEngine } from '../guest/engine';
import { relayBase } from '../party/invite';
import type { EngineFactory } from './engine';

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
    const engine = inner.factory(emit, opts);
    let loading = 0;
    return {
      ...engine,
      load(next) {
        const at = ++loading;
        const itemId = next.item.Id!;
        const key = `${itemId}:${next.source.Id ?? ''}`;
        void (async () => {
          if (key !== opened || !info) {
            const result = await new GuestApi(
              `${root}/party/guest/own`,
              client.token ?? ''
            ).request<{ token: string; revision: string; media: GuestMedia }>(
              '/open',
              { itemId, sourceId: next.source.Id ?? undefined }
            );
            if (at !== loading) return;
            api.token = result.token;
            opened = key;
            info = {
              revision: result.revision,
              playlistItemId: '',
              itemId,
              title: next.item.Name ?? '',
              media: result.media,
            };
          }
          if (at === loading) engine.load(next);
        })().catch((error) => {
          if (at === loading)
            emit({ type: 'failed', error: (error as Error).message });
        });
      },
    };
  };
}
