import React from 'react';
import { t } from '@lingui/core/macro';
import { Modal } from '@aiostreams/ui/modal';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@aiostreams/ui/tabs';
import { TextInput } from '@aiostreams/ui/text-input';
import { AudioSection } from '@/app/settings/audio';
import { PlaybackSection } from '@/app/settings/playback';
import { SubtitlesSection } from '@/app/settings/subtitles';
import { GUEST_USER_ID } from '@/lib/guest/guest-client';
import { useSession } from '@/lib/jellyfin/session';

/** The Playback page's cards each tab shows, by their `data-name`; the Audio and Subtitles tabs show their whole page. */
const PLAYBACK_CARDS = {
  picture: ['video', 'player'],
  playback: ['versions', 'next-episode', 'skipping', 'controls'],
  party: ['watch-parties', 'share-links'],
} as const;
type PlaybackTab = keyof typeof PLAYBACK_CARDS;

/** A guest's Playback tab: the host picks versions and what plays next. */
const GUEST_PLAYBACK = ['skipping', 'controls'];

/** Hides the Playback page's cards a tab doesn't show; cards it adds later are hidden too. */
const TAB_CSS =
  (Object.keys(PLAYBACK_CARDS) as PlaybackTab[])
    .map(
      (tab) =>
        `[data-settings-tab="${tab}"] [data-ui="settings-card"]${PLAYBACK_CARDS[
          tab
        ]
          .map((name) => `:not([data-name="${name}"])`)
          .join('')}{display:none}`
    )
    .join('') +
  `[data-settings-guest] [data-settings-tab="playback"] [data-ui="settings-card"]${GUEST_PLAYBACK.map(
    (name) => `:not([data-name="${name}"])`
  ).join('')}{display:none}` +
  `[data-settings-guest] [data-ui="settings-card"]:is([data-name="versions"],[data-name="next-episode"]){display:none}`;

/**
 * The app's playback, audio and subtitle settings over the player, in tabs by what they're about, with a search across them all:
 * a party's guest has no settings pages, and anyone can change them without leaving what plays.
 */
export function PlayerSettingsDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [tab, setTab] = React.useState<string>('picture');
  const [query, setQuery] = React.useState('');
  const guest = useSession().user.Id === GUEST_USER_ID;
  return (
    <Modal
      data-ui="dialog"
      data-name="player-settings"
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title={t`Settings`}
      contentClass="max-w-3xl max-h-[85vh] flex flex-col overflow-hidden"
    >
      <style>{TAB_CSS}</style>
      <div
        data-settings-guest={guest || undefined}
        className="flex min-h-0 flex-col gap-4"
      >
        <TextInput
          type="search"
          placeholder={t`Search settings`}
          aria-label={t`Search settings`}
          value={query}
          onValueChange={setQuery}
        />
        {query.trim() ? (
          <SearchResults query={query} />
        ) : (
          <Tabs
            value={tab}
            onValueChange={setTab}
            variant="pill"
            animated={false}
            className="flex min-h-0 flex-col"
          >
            <TabsList className="flex-wrap">
              <TabsTrigger value="picture">{t`Picture`}</TabsTrigger>
              <TabsTrigger value="playback">{t`Playback`}</TabsTrigger>
              <TabsTrigger value="audio">{t`Audio`}</TabsTrigger>
              <TabsTrigger value="subtitles">{t`Subtitles`}</TabsTrigger>
              <TabsTrigger value="party">{t`Party & sharing`}</TabsTrigger>
            </TabsList>
            <div className="min-h-0 overflow-y-auto pt-4">
              {(Object.keys(PLAYBACK_CARDS) as PlaybackTab[]).map((name) => (
                <TabsContent key={name} value={name}>
                  <div data-settings-tab={name} className="space-y-6">
                    <PlaybackSection />
                  </div>
                </TabsContent>
              ))}
              <TabsContent value="audio">
                <div className="space-y-6">
                  <AudioSection />
                </div>
              </TabsContent>
              <TabsContent value="subtitles">
                <div className="space-y-6">
                  <SubtitlesSection />
                </div>
              </TabsContent>
            </div>
          </Tabs>
        )}
      </div>
    </Modal>
  );
}

/** Every setting whose wording, or whose card's title, has the query in it, from all three pages. */
function SearchResults({ query }: { query: string }) {
  const root = React.useRef<HTMLDivElement>(null);
  const [found, setFound] = React.useState(true);
  React.useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const words = query.trim().toLowerCase();
    const apply = () => {
      let any = false;
      for (const card of element.querySelectorAll<HTMLElement>(
        '[data-ui="settings-card"]'
      )) {
        const title =
          card
            .querySelector('[data-ui="settings-card-title"]')
            ?.textContent?.toLowerCase() ?? '';
        let shown = false;
        for (const item of card.querySelectorAll<HTMLElement>(
          '[data-ui="settings-card-item"]'
        )) {
          const hit =
            title.includes(words) ||
            (item.textContent ?? '').toLowerCase().includes(words);
          item.hidden = !hit;
          shown ||= hit;
        }
        card.hidden = !shown;
        any ||= shown;
      }
      setFound(any);
    };
    apply();
    // Settings that show or change as others do: matched again. Attributes aren't watched, so hiding doesn't loop.
    const observer = new MutationObserver(apply);
    observer.observe(element, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    return () => observer.disconnect();
  }, [query]);
  return (
    <div ref={root} className="min-h-0 space-y-6 overflow-y-auto pt-4">
      {!found && (
        <p className="py-6 text-center text-sm text-[--muted]">
          {t`No settings match.`}
        </p>
      )}
      <PlaybackSection />
      <AudioSection />
      <SubtitlesSection />
    </div>
  );
}
