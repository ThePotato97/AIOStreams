/*
 * Why a converted stream is buffering, from what the player can see: how far the server has
 * written the stream, how fast this browser converts the audio it renders itself, and how fast
 * the connection brings segments in against the stream's bitrate.
 */

export interface BufferFacts {
  /** The end (seconds, the manifest's time) of what's buffered at the playhead. */
  bufferedEnd: number | null;
  /** The end of the last segment the manifest lists: what the server has written so far. */
  writtenEnd: number | null;
  /** Shaka's estimate of the connection, and the stream's bitrate, in bits a second. */
  estimatedBps?: number;
  streamBps?: number;
  /** Seconds of audio this browser converts per second of work (binaural rendering here). */
  renderSpeed?: number | null;
}

export type BufferReason =
  | { kind: 'server' }
  | { kind: 'device'; speed: number }
  | { kind: 'network'; haveBps: number; needBps: number }
  | null;

/** What's buffered within this of the manifest's end has caught up with the server. */
const EDGE_S = 2;

/**
 * The likeliest cause, in the order one hides the next: the server not having written further
 * (nothing else can help then), this browser's audio conversion running slower than real time,
 * then a connection slower than the stream. Null when none shows.
 */
export function bufferReason(facts: BufferFacts): BufferReason {
  const { bufferedEnd, writtenEnd, estimatedBps, streamBps, renderSpeed } =
    facts;
  if (
    bufferedEnd != null &&
    writtenEnd != null &&
    writtenEnd - bufferedEnd < EDGE_S
  )
    return { kind: 'server' };
  if (renderSpeed != null && renderSpeed < 1)
    return { kind: 'device', speed: renderSpeed };
  if (estimatedBps && streamBps && estimatedBps < streamBps)
    return { kind: 'network', haveBps: estimatedBps, needBps: streamBps };
  return null;
}
