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
import type { EngineFactory, EngineFile } from './engine';
import { afterOpenError, type OpenError } from './convert-plan';
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
 * A file still downloading, and a transcoder that's busy or restarting, are
 * waited for. A stream lost while playing reconnects from where it was, once.
 * Past that the player says why and offers to try again (the failure screen
 * also offers other versions). Playing the file directly isn't a fallback: this
 * browser can't decode its audio. Nothing here converts the video: a stream
 * the browser can't decode plays directly too.
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
  const keyOf = (file: EngineFile) =>
    `${file.item.Id ?? ''}:${file.source.Id ?? ''}`;
  return (emit, opts) => {
    let loading = 0;
    /** The file converting now, and where and how it was playing last. */
    let playing: EngineFile | null = null;
    let positionMs = 0;
    let paused = true;
    /** It played since it was last loaded, and hasn't reconnected since. */
    let loaded = false;
    let reconnected = false;
    const here = (next: EngineFile): EngineFile => ({
      ...next,
      startMs: positionMs,
      paused,
    });
    const converting = inner.factory((event) => {
      if (playing) {
        if (event.type === 'failed') {
          const next = here(playing);
          playing = null;
          return failAudio(next, event.error, event.transcoder, 'play');
        }
        if (event.type === 'position' && event.positionMs != null)
          positionMs = event.positionMs;
        if (event.type === 'state' && event.state.paused != null)
          paused = event.state.paused;
        if (event.type === 'loaded') {
          loaded = true;
          reconnected = false;
        }
      }
      emit(event);
    }, opts);
    // The server forgot the playback (it restarted): reconnect, as for a lost stream.
    onExpired = (message) => {
      if (!playing) return;
      const next = here(playing);
      playing = null;
      failAudio(next, message, true);
    };
    /**
     * The converted stream failed or couldn't start. Lost while playing, it
     * reconnects from where it was, once (opening it again waits for a
     * restarting transcoder). Otherwise the player says why and offers to try
     * again; `transcoder` says the cause is the transcoder's, not the file's,
     * so other versions wouldn't help.
     */
    const failAudio = (
      next: EngineFile,
      reason?: string,
      transcoder?: boolean,
      /** The converted stream failed playing (the reason says why), or couldn't be made. */
      stage: 'play' | 'convert' = 'convert'
    ) => {
      const reopen = () => {
        opened = '';
        info = null;
        load(next);
      };
      if (loaded && !reconnected) {
        reconnected = true;
        toast.message(t`Lost the converted stream; reconnecting…`, {
          description: reason,
        });
        return reopen();
      }
      converting.close();
      const why = reason ?? t`conversion is unavailable on this server`;
      emit({
        type: 'failed',
        error:
          stage === 'play' && reason
            ? reason
            : t`This browser can't play this file's audio, and it couldn't be converted: ${why}`,
        retry: { label: t`Try again`, run: reopen },
        transcoder,
      });
    };
    const open = async (next: EngineFile, at: number) => {
      const itemId = next.item.Id!;
      const key = keyOf(next);
      if (key === opened && info) return true;
      const started = Date.now();
      let waitingForTranscoder = false;
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
          if (plan.action === 'fail') {
            const { status, code } = error as OpenError;
            failAudio(
              next,
              plan.reason,
              status === 503 || !!code?.startsWith('transcoder_')
            );
            return false;
          }
          if (attempt === 0 && (error as OpenError).status === 425)
            toast.message(t`Still downloading; it starts when it's ready.`);
          if (
            !waitingForTranscoder &&
            (error as OpenError).code === 'transcoder_unreachable'
          ) {
            waitingForTranscoder = true;
            toast.message(t`Waiting for the transcoder to come back…`, {
              description: t`It isn't reachable right now; playback starts when it is.`,
            });
          }
          emit({ type: 'state', state: { waiting: true, loaded: false } });
          await new Promise((r) => setTimeout(r, plan.ms));
          if (at !== loading) return false;
        }
      }
    };
    function load(next: EngineFile) {
      const at = ++loading;
      playing = null;
      loaded = false;
      void open(next, at).then((ready) => {
        if (!ready || at !== loading) return;
        playing = next;
        positionMs = next.startMs;
        paused = next.paused ?? true;
        converting.load(next);
      });
    }
    return new Proxy(converting, {
      get: (target, prop) =>
        prop === 'load'
          ? load
          : prop === 'close'
            ? () => {
                loading++;
                playing = null;
                target.close();
              }
            : Reflect.get(target, prop),
    });
  };
}
