import { t } from '@lingui/core/macro';
import type { Failure } from './failure';

/**
 * A playback failure as the viewer reads it: what failed, in words, with the browser's own
 * reason, then the codes (Shaka's, the element's, the segment) for whoever has to fix it.
 */
export function explainFailure(failure: Failure): string {
  const { media, detail } = failure;
  if (media) {
    const codecs = media.codecs;
    const what =
      media.stream === 'video'
        ? codecs
          ? t`Your browser couldn't decode the video (${codecs})`
          : t`Your browser couldn't decode the video`
        : media.stream === 'audio'
          ? codecs
            ? t`Your browser couldn't decode the audio (${codecs})`
            : t`Your browser couldn't decode the audio`
          : t`Your browser couldn't decode the stream`;
    // The browser's message says why; the element's code only what kind of failure.
    const why = media.browser ?? media.element;
    const codes = [media.browser && media.element, media.segment, detail]
      .filter(Boolean)
      .join(', ');
    return `${what}${why ? `: ${why}` : ''} [${codes}]`;
  }
  if (failure.kind === 'network')
    return t`The stream couldn't be fetched [${detail}]`;
  return detail;
}
