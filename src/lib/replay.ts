import { parseUrl } from './security';

/**
 * Headers a download may replay: exactly the two the browser itself sent for requests made from the frame that
 * owns the stream. Nothing else is ever copied (no Authorization, no custom headers, no cookies).
 */
export interface ReplayHeaders {
  /** Origin plus "/" (the browser's default strict-origin-when-cross-origin form, which leaks the least). */
  referer: string;
  origin: string;
}

export function replayHeadersFor(frameUrl: string | undefined): ReplayHeaders | undefined {
  const u = frameUrl ? parseUrl(frameUrl) : undefined;
  if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) return undefined;
  return { referer: `${u.origin}/`, origin: u.origin };
}

/** Hosts a rule may apply to: only the hosts of this job's own URLs, never "everything". */
export function replayDomains(urls: string[], max = 24): string[] {
  const hosts = new Set<string>();
  for (const url of urls) {
    const u = parseUrl(url);
    if (u && (u.protocol === 'http:' || u.protocol === 'https:')) hosts.add(u.hostname);
    if (hosts.size >= max) break;
  }
  return [...hosts];
}

/** Deterministic rule id in a private range, so a job's rule can be found (and removed) after a worker restart. */
export function ruleIdFor(jobId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < jobId.length; i++) {
    h ^= jobId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return 1_000_000 + ((h >>> 0) % 900_000_000);
}

type DnrRule = chrome.declarativeNetRequest.Rule;

/** The session rule that sets Referer/Origin on this job's own requests (those not tied to any tab). */
export function buildReplayRule(id: number, headers: ReplayHeaders, domains: string[]): DnrRule {
  return {
    id,
    priority: 1,
    action: {
      type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
      requestHeaders: [
        {
          header: 'referer',
          operation: 'set' as chrome.declarativeNetRequest.HeaderOperation,
          value: headers.referer,
        },
        {
          header: 'origin',
          operation: 'set' as chrome.declarativeNetRequest.HeaderOperation,
          value: headers.origin,
        },
      ],
    },
    condition: {
      requestDomains: domains,
      // -1 = requests that do not belong to a tab: the extension's own fetches and downloads, never the user's browsing.
      tabIds: [-1],
      resourceTypes: ['xmlhttprequest', 'media', 'other'] as chrome.declarativeNetRequest.ResourceType[],
    },
  };
}
