/** How the chunks of a MediaSource capture become files. Implemented in Rust (`core/src/mse.rs`). */
import type { Container, InitInfo, TrackInfo } from './mse';
import { core } from './core';

/** What is known about one chunk a player appended to a SourceBuffer. The bytes themselves live on disk. */
export interface ChunkMeta {
  /** SourceBuffer the chunk went to (the hook's id). */
  track: string;
  /** Arrival order across the whole capture. */
  seq: number;
  kind: 'init' | 'media';
  /** Where the chunk sits in its track's staged file. */
  offset: number;
  length: number;
  /** Content signature: equal chunks have equal signatures. */
  sig: string;
  /** Media chunks: where the segment starts on the media timeline, in seconds. */
  startSec?: number;
  /** Init chunks: what the tracks are. */
  init?: InitInfo;
  container?: Container;
}

/** FNV-1a over the length, the head and the tail: cheap, and enough to recognise a segment appended twice. */
export function chunkSignature(b: Uint8Array): string {
  return core.chunkSignature(b);
}

/** Classifies chunks as they arrive, remembering each SourceBuffer's latest initialisation segment. */
export class ChunkClassifier {
  private inits = new Map<string, InitInfo>();

  /**
   * Classify one append. A player that appends the initialisation segment together with the first media segment gets
   * two entries (the bytes stay contiguous on disk, so offsets and lengths simply divide the chunk).
   */
  classifyAll(track: string, seq: number, bytes: Uint8Array, offset: number): ChunkMeta[] {
    const metas = core.classifyChunks(track, seq, bytes, offset, this.inits.get(track)) as ChunkMeta[];
    for (const m of metas) if (m.init) this.inits.set(track, m.init);
    return metas;
  }

  /** One append as a single entry, never split. */
  classify(track: string, seq: number, bytes: Uint8Array, offset: number): ChunkMeta {
    const meta = core.classifyChunk(track, seq, bytes, offset, this.inits.get(track)) as ChunkMeta;
    if (meta.init) this.inits.set(track, meta.init);
    return meta;
  }
}

export interface PartTrack {
  track: string;
  role: 'video' | 'audio' | 'muxed';
  /** The initialisation segment to start the file with, then the media segments in time order. */
  chunks: ChunkMeta[];
}

export interface Part {
  index: number;
  container: Container;
  /** Media time covered by the video of this part (seconds). */
  startSec: number;
  endSec: number;
  video?: TrackInfo;
  audio?: TrackInfo;
  tracks: PartTrack[];
}

export interface PartPlan {
  parts: Part[];
  /** Media chunks that arrived before any initialisation segment of their SourceBuffer and cannot be used. */
  orphans: number;
  /** Chunks left out because the same segment was appended more than once. */
  duplicates: number;
}

/**
 * Split a capture into parts. A new part starts whenever the video's initialisation segment changes (the player moved
 * to another quality): the two cannot share a file without re-encoding, and this never re-encodes. Audio, which
 * usually does not change, is placed in the part whose video covers its start time. Every part begins with the
 * initialisation segments it needs and holds each segment once, in time order.
 */
export function planParts(metas: readonly ChunkMeta[]): PartPlan {
  return core.planParts(metas) as PartPlan;
}
