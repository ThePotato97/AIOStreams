import type { JellyfinClient } from '../client';
import { subtitleUrl, textSubtitles } from '../subtitles/tracks';
import type { MediaStream, SourceInfo } from '../types';
import { trackLabel } from './controller';
import type { ServerSubtitle } from './engine';

/**
 * The source's text subtitles the server can send as files. An engine that
 * reads the file's own subtitles (`ownSubtitles`) gets only external ones.
 */
export function serverSubtitles(
  client: JellyfinClient,
  source: SourceInfo,
  ownSubtitles: boolean,
  urlOf?: (stream: MediaStream) => string | null
): ServerSubtitle[] {
  return textSubtitles(source)
    .filter((s) => !ownSubtitles || s.IsExternal)
    .flatMap((stream, i) => {
      const url = urlOf ? urlOf(stream) : subtitleUrl(client, stream);
      return url
        ? [
            {
              id: `server:${stream.Index}`,
              url,
              label: trackLabel(stream, i + 1),
              lang: stream.Language ?? undefined,
              stream,
            },
          ]
        : [];
    });
}
