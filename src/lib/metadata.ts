/**
 * Media that a page announces through public, standard metadata: Open Graph / Twitter tags, JSON-LD (schema.org
 * VideoObject and AudioObject), <link rel="alternate"> and podcast feeds (RSS enclosures, Atom). The page is hostile
 * input: everything is validated here, bounded, and returned as plain candidates; nothing is fetched or run.
 * Implemented in Rust (`core/src/metadata.rs`).
 */
import { core } from './core';

export interface MetaMedia {
  url: string;
  mimeType?: string;
  mediaType?: 'video' | 'audio';
  title?: string;
  durationSec?: number;
  width?: number;
  height?: number;
  poster?: string;
}

export const MAX_META_ITEMS = 60;

/** An absolute http(s) address, or undefined (relative addresses are resolved against `base`). */
export function safeAbs(raw: unknown, base: string): string | undefined {
  return core.safeAbs(raw, base);
}

/** 'video' or 'audio' from a MIME type; undefined for anything else (images, HTML players, flash). */
export function mediaTypeOfMime(mime: string | undefined): 'video' | 'audio' | undefined {
  return core.mediaTypeOfMime(mime) as 'video' | 'audio' | undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// Open Graph / Twitter

export interface MetaTag {
  /** property= or name= */
  key: string;
  content: string;
}

/**
 * og:video (+ :url, :secure_url, :type, :width, :height) and og:audio, twitter:player:stream. The type given for an
 * og:video is for the media at that address; a tag whose address is a web page (text/html, an embed player) is not a file.
 */
export function mediaFromMetaTags(tags: readonly MetaTag[], base: string): MetaMedia[] {
  return core.mediaFromMetaTags(tags, base) as MetaMedia[];
}

// ---------------------------------------------------------------------------------------------------------------
// JSON-LD

/** `contentUrl` of VideoObject / AudioObject nodes. `embedUrl` is a web page and is deliberately ignored. */
export function mediaFromJsonLd(text: string, base: string): MetaMedia[] {
  return core.mediaFromJsonLd(text, base) as MetaMedia[];
}

// ---------------------------------------------------------------------------------------------------------------
// <link rel="alternate">

export interface LinkTag {
  rel: string;
  type: string;
  href: string;
  title?: string;
}

/** Alternate representations of the page that are media files themselves, and the feeds the page offers. */
export function mediaFromLinks(
  links: readonly LinkTag[],
  base: string,
): { media: MetaMedia[]; feeds: string[] } {
  return core.mediaFromLinks(links, base) as { media: MetaMedia[]; feeds: string[] };
}

// ---------------------------------------------------------------------------------------------------------------
// Podcast feeds

/** RSS `<enclosure>` and Atom `<link rel="enclosure">` entries that are audio or video. */
export function mediaFromFeed(text: string, base: string): MetaMedia[] {
  return core.mediaFromFeed(text, base) as MetaMedia[];
}
