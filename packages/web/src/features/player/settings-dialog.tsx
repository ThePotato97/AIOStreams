import { t } from '@lingui/core/macro';
import { Modal } from '@aiostreams/ui/modal';
import { AudioSection } from '@/app/settings/audio';
import { PlaybackSection } from '@/app/settings/playback';
import { SubtitlesSection } from '@/app/settings/subtitles';

/**
 * The app's playback, audio and subtitle settings over the player: a party's guest has no settings
 * pages, and anyone can change them without leaving what plays.
 */
export function PlayerSettingsDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Modal
      data-ui="dialog"
      data-name="player-settings"
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title={t`Settings`}
      contentClass="max-w-3xl max-h-[85vh] overflow-y-auto"
    >
      <div className="space-y-6">
        <PlaybackSection />
        <AudioSection />
        <SubtitlesSection />
      </div>
    </Modal>
  );
}
