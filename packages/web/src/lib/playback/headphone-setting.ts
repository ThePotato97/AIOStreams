/*
 * The headphones settings, loaded when first used: settings read the page as
 * they load, and the engines are tested without one.
 */
import type { HeadphoneMode } from './binaural/local-audio';

const load = () => import('../settings');

/**
 * Calls `listener` with the headphones setting and the headphone mode once they're read, then each
 * time either changes.
 */
export function watchHeadphones(
  listener: (on: boolean, mode: HeadphoneMode) => void
): () => void {
  let off: (() => void) | null = null;
  let stopped = false;
  if (typeof window === 'undefined') return () => {};
  load()
    .then(({ settings, onSettingsChange }) => {
      if (stopped) return;
      const read = () =>
        [
          settings.audio.headphones.read(),
          settings.audio.headphoneMode.read(),
        ] as const;
      let last = read();
      listener(...last);
      off = onSettingsChange(() => {
        const now = read();
        if (now[0] === last[0] && now[1] === last[1]) return;
        last = now;
        listener(...now);
      });
    })
    .catch(() => {});
  return () => {
    stopped = true;
    off?.();
  };
}
