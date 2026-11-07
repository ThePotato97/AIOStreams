/*
 * The headphones setting, loaded when first used: settings read the page as
 * they load, and the engines are tested without one.
 */
const load = () => import('../settings');

/** Calls `listener` with the setting once it's read, then each time it changes. */
export function watchHeadphones(listener: (on: boolean) => void): () => void {
  let off: (() => void) | null = null;
  let stopped = false;
  if (typeof window === 'undefined') return () => {};
  load()
    .then(({ settings, onSettingsChange }) => {
      if (stopped) return;
      let last = settings.audio.headphones.read();
      listener(last);
      off = onSettingsChange(() => {
        const now = settings.audio.headphones.read();
        if (now === last) return;
        last = now;
        listener(now);
      });
    })
    .catch(() => {});
  return () => {
    stopped = true;
    off?.();
  };
}
