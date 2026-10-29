/** Header replay. Implemented in Rust (`core/src/replay.rs`); the declarativeNetRequest rule itself is built here. */
import { core } from './core';

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
  return core.replayHeadersFor(frameUrl) as ReplayHeaders | undefined;
}

/** Hosts a rule may apply to: only the hosts of this job's own URLs, never "everything". */
export function replayDomains(urls: string[], max = 24): string[] {
  return core.replayDomains(urls, max);
}

/** Deterministic rule id in a private range, so a job's rule can be found (and removed) after a worker restart. */
export function ruleIdFor(jobId: string): number {
  return core.ruleIdFor(jobId);
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
