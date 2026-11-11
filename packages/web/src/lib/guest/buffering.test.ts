/* eslint-disable lingui/no-unlocalized-strings -- test data, not UI text. */
import { describe, expect, it } from 'vitest';
import { bufferReason } from './buffering';

describe('why a converted stream buffers', () => {
  it('is the server where the buffer reaches what it has written', () => {
    expect(
      bufferReason({
        bufferedEnd: 99,
        writtenEnd: 100,
        estimatedBps: 1e6,
        streamBps: 8e7,
        renderSpeed: 0.5,
      })
    ).toEqual({ kind: 'server' });
  });
  it('is this device where it converts the audio slower than real time', () => {
    expect(
      bufferReason({
        bufferedEnd: 50,
        writtenEnd: 100,
        estimatedBps: 1e6,
        streamBps: 8e7,
        renderSpeed: 0.7,
      })
    ).toEqual({ kind: 'device', speed: 0.7 });
  });
  it('is the connection where it is slower than the stream', () => {
    expect(
      bufferReason({
        bufferedEnd: 50,
        writtenEnd: 100,
        estimatedBps: 2e7,
        streamBps: 8e7,
        renderSpeed: 3,
      })
    ).toEqual({ kind: 'network', haveBps: 2e7, needBps: 8e7 });
  });
  it('is unknown where none of those shows', () => {
    expect(
      bufferReason({
        bufferedEnd: 50,
        writtenEnd: 100,
        estimatedBps: 9e7,
        streamBps: 8e7,
        renderSpeed: null,
      })
    ).toBeNull();
  });
});
