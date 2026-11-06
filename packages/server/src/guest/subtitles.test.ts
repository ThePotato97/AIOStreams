import { expect, it } from 'vitest';
import { offsetWebVtt } from './subtitles.js';
it('keeps external subtitles aligned when a seek generation starts later in the episode', () => {
  const original =
    'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nBefore seek\n\n00:00:03.500 --> 00:00:05.000\nStraddling seek\n\n00:01:00.000 --> 00:01:02.000 align:start\nLater\n';
  const shifted = offsetWebVtt(original, 4000);
  expect(shifted).not.toContain('Before seek');
  expect(shifted).toContain('00:00:00.000 --> 00:00:01.000\nStraddling seek');
  expect(shifted).toContain('00:00:56.000 --> 00:00:58.000 align:start');
  expect(shifted).toMatch(/^WEBVTT/);
});
