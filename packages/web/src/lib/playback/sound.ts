import { t } from '@lingui/core/macro';
import {
  AUDIO_CHANNELS,
  AUDIO_DELAY_LIMIT_MS,
  AUDIO_DELAY_STEP_MS,
  AUDIO_RENDERS,
  settings,
  type AudioChannels,
} from '@/lib/settings';
import { currentHost } from '@/lib/hosts';

export const audioChannelLabel = (channels: AudioChannels) =>
  ({
    auto: t`Automatic`,
    stereo: t`Stereo`,
    '5.1': t`5.1 surround`,
    '7.1': t`7.1 surround`,
    speakers: t`Built-in speakers (Dolby Atmos)`,
    headphones: t`Headphones (Dolby Atmos)`,
  })[channels];

/** The Channels choices this device has: the Atmos renders only in the Android app. */
export function audioChannelChoices(): readonly AudioChannels[] {
  return currentHost().name === 'android-app'
    ? AUDIO_CHANNELS
    : AUDIO_CHANNELS.filter((c) => !AUDIO_RENDERS.includes(c));
}

export const dialogueLabel = (db: number) => (db ? t`+${db} dB` : t`Off`);

export function audioDelayLabel(ms: number): string {
  if (!ms) return t`In sync`;
  const amount = Math.abs(ms);
  return ms > 0 ? t`+${amount} ms` : t`−${amount} ms`;
}

export function stepAudioDelay(steps: number): void {
  const next = settings.audio.delayMs.read() + steps * AUDIO_DELAY_STEP_MS;
  settings.audio.delayMs.write(
    Math.max(-AUDIO_DELAY_LIMIT_MS, Math.min(AUDIO_DELAY_LIMIT_MS, next))
  );
}
