/**
 * A small, safe XML reader for manifests (MPD, TTML). Implemented in Rust (`core/src/xml.rs`), shared with the desktop
 * app. A manifest comes from a hostile page, so the reader is deliberately limited: no DTD processing and no custom
 * entities (so no entity expansion attacks), hard limits on size, depth and node count, and it never throws: it returns
 * undefined.
 */
import { core } from './core';

export interface XmlNode {
  /** Qualified name as written, e.g. "SegmentTemplate" or "cenc:pssh". */
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** Concatenated character data directly inside this element. */
  text: string;
  /** Character data and child elements in document order (for mixed content such as subtitles). */
  content: (string | XmlNode)[];
}

export interface XmlLimits {
  maxNodes: number;
  maxDepth: number;
}

export function decodeEntities(s: string): string {
  return s.includes('&') ? core.decodeEntities(s) : s;
}

export function parseXml(input: string, limits: Partial<XmlLimits> = {}): XmlNode | undefined {
  return core.parseXml(input, limits.maxNodes, limits.maxDepth) as XmlNode | undefined;
}

// Tree accessors over the parsed result (plain objects): kept in TypeScript, they hold no decisions.

/** Name without its namespace prefix: "cenc:pssh" -> "pssh". */
export const localName = (name: string): string => name.slice(name.indexOf(':') + 1);

/** Direct children with the given local name. */
export const childrenNamed = (node: XmlNode, local: string): XmlNode[] =>
  node.children.filter((c) => localName(c.name) === local);

export const firstChild = (node: XmlNode, local: string): XmlNode | undefined =>
  node.children.find((c) => localName(c.name) === local);
