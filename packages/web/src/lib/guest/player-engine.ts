/*
 * The engine a player page plays with, where its caller has its own: a guest's page has the guest
 * engine, which plays what the guest routes prepare. The player page then leaves out what only a
 * signed-in user can do there (the mini player, other versions), and its options offer the
 * engine's qualities where it has them.
 */
import React from 'react';
import type { JellyfinClient } from '../client';
import type { Track } from '../playback/controller';
import type { EngineFactory } from '../playback/engine';

export interface PlayerEngineChoice {
  engine(
    video: React.RefObject<HTMLVideoElement | null>,
    client: JellyfinClient
  ): EngineFactory;
  /**
   * Whether the engine plays a stream converted as it plays (read live): such a player doesn't
   * hold the party, which plays on while it catches up.
   */
  converted?(): boolean;
  /** The qualities the engine converts to, offered with the player's other options. */
  quality?: {
    options: Track[];
    value: string;
    onChange(id: string): void;
  };
}

export const PlayerEngineOverride =
  React.createContext<PlayerEngineChoice | null>(null);
