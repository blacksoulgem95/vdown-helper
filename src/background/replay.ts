import { buildReplayRule, replayDomains, replayHeadersFor, ruleIdFor } from '@/lib/replay';
import { log } from '@/lib/security';

async function canReplay(): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ permissions: ['declarativeNetRequestWithHostAccess'] });
  } catch {
    return false;
  }
}

/**
 * Make this job's own requests carry the Referer/Origin of the frame that owns the stream, as the player's own
 * requests did. Needs the optional declarativeNetRequestWithHostAccess permission and access to the hosts; without
 * them nothing happens and the job simply runs with the extension's default headers. Returns whether a rule is active.
 */
export async function installReplay(
  jobId: string,
  frameUrl: string | undefined,
  urls: string[],
): Promise<boolean> {
  const headers = replayHeadersFor(frameUrl);
  const domains = replayDomains(urls);
  if (!headers || domains.length === 0 || !(await canReplay())) return false;
  try {
    const id = ruleIdFor(jobId);
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [id],
      addRules: [buildReplayRule(id, headers, domains)],
    });
    return true;
  } catch (e) {
    log.warn('header replay not installed:', e instanceof Error ? e.message : 'error');
    return false;
  }
}

export async function removeReplay(jobId: string): Promise<void> {
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleIdFor(jobId)] });
  } catch {
    // permission may have been revoked meanwhile; the rule is gone with it
  }
}

/** Drop rules that belong to jobs which no longer run (e.g. after a worker or browser restart). */
export async function pruneReplay(activeJobIds: string[]): Promise<void> {
  try {
    const keep = new Set(activeJobIds.map(ruleIdFor));
    const stale = (await chrome.declarativeNetRequest.getSessionRules())
      .map((r) => r.id)
      .filter((id) => id >= 1_000_000 && !keep.has(id));
    if (stale.length > 0) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: stale });
  } catch {
    // no permission: nothing to prune
  }
}

/**
 * Run one extension-origin request with the owning frame's Referer/Origin in place, then remove the rule again.
 * Used for the "read it from the extension" fallback while scanning. Without the optional permission it just runs.
 */
export async function withReplay<T>(
  key: string,
  frameUrl: string | undefined,
  urls: string[],
  fn: () => Promise<T>,
): Promise<T> {
  const installed = await installReplay(key, frameUrl, urls);
  try {
    return await fn();
  } finally {
    if (installed) await removeReplay(key);
  }
}
