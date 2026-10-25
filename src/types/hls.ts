/** Types produced by the HLS parser (src/lib/hls). */

export type PlaylistClass = 'hls-master' | 'hls-media' | 'm3u-plain' | 'dash' | 'unsupported';

export type KeyMethod = 'NONE' | 'AES-128' | 'SAMPLE-AES' | 'SAMPLE-AES-CTR' | 'UNKNOWN';

export interface HlsKey {
  method: KeyMethod;
  /** Absolute URL of the key, when the method needs one. */
  uri?: string;
  /** Hex IV including 0x prefix, exactly as written in the playlist. */
  iv?: string;
  keyFormat: string;
  /** True when the key uses a DRM key system or a method this extension will not decrypt. */
  protectedByDrm: boolean;
}

export interface HlsByteRange {
  length: number;
  offset: number;
}

export interface HlsMap {
  uri: string;
  byteRange?: HlsByteRange;
}

export interface HlsSegment {
  uri: string;
  duration: number;
  title?: string;
  /** Media sequence number of this segment. */
  sequence: number;
  byteRange?: HlsByteRange;
  discontinuity: boolean;
  /** Effective key at this segment (undefined when unencrypted). */
  key?: HlsKey;
  /** Effective initialisation section (fMP4/CMAF). */
  map?: HlsMap;
}

export interface HlsMediaPlaylist {
  kind: 'hls-media';
  url: string;
  version?: number;
  targetDuration?: number;
  mediaSequence: number;
  playlistType?: 'VOD' | 'EVENT';
  /** False for live playlists that never receive #EXT-X-ENDLIST. */
  endList: boolean;
  segments: HlsSegment[];
  totalDuration: number;
  /** Unique key methods present, e.g. ['AES-128']. Empty when unencrypted. */
  encryption: KeyMethod[];
  hasDrm: boolean;
  /** True if any segment uses an fMP4 init section. */
  fragmented: boolean;
}

export interface HlsVariant {
  uri: string;
  bandwidth: number;
  averageBandwidth?: number;
  width?: number;
  height?: number;
  frameRate?: number;
  codecs?: string;
  videoRange?: string;
  audioGroup?: string;
  subtitleGroup?: string;
}

export type RenditionType = 'AUDIO' | 'VIDEO' | 'SUBTITLES' | 'CLOSED-CAPTIONS';

export interface HlsRendition {
  type: RenditionType;
  groupId: string;
  name: string;
  language?: string;
  /** Absent when the rendition is muxed into the variant streams. */
  uri?: string;
  isDefault: boolean;
  autoSelect: boolean;
  channels?: string;
}

export interface HlsMasterPlaylist {
  kind: 'hls-master';
  url: string;
  version?: number;
  variants: HlsVariant[];
  renditions: HlsRendition[];
  /** Count of #EXT-X-I-FRAME-STREAM-INF entries (trick-play only, never offered for download). */
  iFrameStreams: number;
  /** Key declared via #EXT-X-SESSION-KEY, if any. */
  sessionKeys: HlsKey[];
}

export type HlsPlaylist = HlsMasterPlaylist | HlsMediaPlaylist;

export type HlsErrorCode = 'empty' | 'not-m3u' | 'not-hls' | 'dash' | 'malformed' | 'unsafe-url';

export interface HlsError {
  code: HlsErrorCode;
  message: string;
  line?: number;
}

export type HlsParseResult = { ok: true; playlist: HlsPlaylist } | { ok: false; error: HlsError };
