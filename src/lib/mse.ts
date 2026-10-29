/**
 * Reading just enough of fragmented MP4 and WebM to organise what a player appends to a MediaSource: which chunks are
 * initialisation segments, what tracks they define, and where in time each media segment starts. Pure functions over
 * bytes; nothing is decoded or modified. Input comes from a hostile page, so every read is bounds-checked and the
 * parsers never throw: they return `undefined` for what they cannot make sense of. Implemented in Rust (`core/src/mse.rs`).
 */
import { core } from './core';

export type TrackKind = 'video' | 'audio' | 'other';
export type Container = 'mp4' | 'webm';

export interface TrackInfo {
  /** Track id inside the container. */
  id: number;
  kind: TrackKind;
  /** Sample entry (MP4: "avc1", "vp09", "mp4a", "Opus" ...) or CodecID (WebM: "V_VP9", "A_OPUS" ...). */
  codec: string;
  width?: number;
  height?: number;
  /** Ticks per second of the track's timestamps (MP4 mdhd; WebM: 1e9 / TimecodeScale). */
  timescale: number;
}

export interface InitInfo {
  container: Container;
  tracks: TrackInfo[];
}

export interface FragmentInfo {
  container: Container;
  /** Start of the first sample, per track, in the track's own ticks (WebM: Cluster Timecode, track 0 = all). */
  starts: Array<{ trackId: number; ticks: number }>;
}

/** Initialisation segment (what the tracks are), or undefined if this chunk is not one. */
export function parseInit(data: Uint8Array): InitInfo | undefined {
  return core.parseInit(data) as InitInfo | undefined;
}

/** Media segment (where it starts), or undefined if this chunk is not one. */
export function parseFragment(data: Uint8Array): FragmentInfo | undefined {
  return core.parseFragment(data) as FragmentInfo | undefined;
}

/**
 * A player may append an initialisation segment and the first media segment in one call. Where the media starts inside
 * such a chunk (the first `moof` box, or the first WebM Cluster), or undefined when the chunk is not a mixture.
 */
export function mediaStartInInit(data: Uint8Array): number | undefined {
  return core.mediaStartInInit(data);
}
