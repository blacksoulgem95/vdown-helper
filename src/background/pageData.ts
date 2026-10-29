/**
 * Media a frame's metadata announces (Open Graph, JSON-LD, <link rel="alternate">, its own podcast feeds, the public
 * API of an open site it belongs to). The page scanner only reads these as found; they are parsed here (lib/metadata,
 * lib/sites) so the shared core never has to load in the page. Feeds and site APIs are read by the frame itself,
 * anonymously and only from its own origin (src/content/metadata.ts).
 */
import {
  mediaFromFeed,
  mediaFromJsonLd,
  mediaFromLinks,
  mediaFromMetaTags,
  type MetaMedia,
} from '@/lib/metadata';
import { siteLookupFor } from '@/lib/sites';
import type { RawCandidate, ScanReport } from '@/types/media';
import { pageSameOriginText } from './pageFetch';

const MAX_FEEDS = 2;

/** A media address announced by metadata or an open site's API, as a candidate. */
export function metaCandidate(m: MetaMedia, method: 'metadata' | 'site-api'): RawCandidate {
  return {
    url: m.url,
    method,
    ...(m.title ? { title: m.title } : {}),
    ...(m.mimeType ? { mimeType: m.mimeType } : {}),
    ...(m.mediaType ? { mediaType: m.mediaType } : {}),
    ...(m.durationSec ? { durationSec: m.durationSec } : {}),
    ...(m.width && m.height ? { width: m.width, height: m.height } : {}),
    ...(m.poster ? { poster: m.poster } : {}),
  };
}

/** Candidates from the document's own tags (no network). Also returns the feeds the page offers. */
export function tagCandidates(report: ScanReport): { candidates: RawCandidate[]; feeds: string[] } {
  const d = report.pageData;
  if (!d) return { candidates: [], feeds: [] };
  const media = mediaFromMetaTags(d.tags, d.base);
  for (const text of d.ld) media.push(...mediaFromJsonLd(text, d.base));
  const fromLinks = mediaFromLinks(d.links, d.base);
  media.push(...fromLinks.media);
  return { candidates: media.map((m) => metaCandidate(m, 'metadata')), feeds: fromLinks.feeds };
}

async function frameText(
  tabId: number,
  frameId: number | undefined,
  url: string,
): Promise<string | undefined> {
  try {
    const text: unknown = await pageSameOriginText(tabId, frameId, url);
    return typeof text === 'string' ? text : undefined;
  } catch {
    return undefined;
  }
}

/** Everything a frame's metadata announces, including its feeds and its open-site API (read by the frame itself). */
export async function pageDataCandidates(tabId: number, report: ScanReport): Promise<RawCandidate[]> {
  const { candidates, feeds } = tagCandidates(report);
  const fromFeeds = Promise.all(
    feeds.slice(0, MAX_FEEDS).map(async (feed) => {
      const text = await frameText(tabId, report.frameId, feed);
      return text === undefined ? [] : mediaFromFeed(text, feed).map((m) => metaCandidate(m, 'metadata'));
    }),
  );
  let lookup: ReturnType<typeof siteLookupFor>;
  try {
    lookup = siteLookupFor(new URL(report.pageUrl));
  } catch {
    lookup = undefined;
  }
  const fromSite = (async () => {
    if (!lookup) return [];
    const text = await frameText(tabId, report.frameId, lookup.apiUrl);
    if (text === undefined) return [];
    try {
      return lookup.parse(JSON.parse(text)).map((m) => metaCandidate(m, 'site-api'));
    } catch {
      return [];
    }
  })();
  const [feedLists, site] = await Promise.all([fromFeeds, fromSite]);
  const out = [...candidates];
  const have = new Set(out.map((c) => `${c.url}|${c.method}`));
  for (const c of [...site, ...feedLists.flat()]) {
    const key = `${c.url}|${c.method}`;
    if (!have.has(key)) {
      have.add(key);
      out.push(c);
    }
  }
  return out;
}
