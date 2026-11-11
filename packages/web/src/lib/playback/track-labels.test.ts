/* eslint-disable lingui/no-unlocalized-strings -- test data, not UI text. */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@lingui/core/macro', () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce(
      (out, s, i) => out + s + (i < values.length ? String(values[i]) : ''),
      ''
    ),
}));
vi.mock('../storage', () => ({ storage: { get: () => null, set: () => {} } }));
vi.mock('../session', () => ({ useSession: () => ({}) }));

// no DOM here: the module reads which media features the browser has as it loads
vi.stubGlobal('HTMLMediaElement', class {});
const { audioFormat, trackRow } = await import('./controller');

describe('track rows', () => {
  it('tell same-language audio tracks apart by format', () => {
    // Tenet's tracks as ffprobe names them, with no titles
    expect(
      trackRow(
        { lang: 'eng', codec: 'eac3', channels: 6, layout: '5.1(side)' },
        'audio',
        ''
      )
    ).toEqual({ label: 'English', detail: 'Dolby Digital+ 5.1' });
    expect(
      trackRow(
        { lang: 'ita', codec: 'ac3', channels: 6, default: true },
        'audio',
        ''
      ).detail
    ).toBe('Dolby Digital 5.1 · Default');
  });
  it('name Atmos and the DTS profile, and keep the file’s own title', () => {
    expect(
      audioFormat({
        codec: 'truehd',
        profile: 'Dolby TrueHD + Dolby Atmos',
        layout: '7.1',
      })
    ).toBe('TrueHD Atmos 7.1');
    expect(
      audioFormat({ codec: 'dts', profile: 'DTS-HD MA', channels: 8 })
    ).toBe('DTS-HD MA 7.1');
    expect(audioFormat({ codec: 'aac', channels: 2 })).toBe('AAC Stereo');
    expect(
      trackRow(
        {
          lang: 'eng',
          title: 'Director commentary',
          codec: 'aac',
          layout: 'stereo',
        },
        'audio',
        ''
      )
    ).toEqual({
      label: 'English',
      detail: 'Director commentary · AAC Stereo',
    });
  });
  it('give subtitles their format and kind', () => {
    expect(
      trackRow(
        { lang: 'eng', hearingImpaired: true, codec: 'hdmv_pgs_subtitle' },
        'subtitle',
        ''
      )
    ).toEqual({ label: 'English · SDH', detail: 'PGS' });
  });
});
