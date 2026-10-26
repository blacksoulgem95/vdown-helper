import { loadSettings } from '@/lib/settings';
import { log } from '@/lib/security';
import { parseHookReport, type HookReport } from '@/lib/hookData';

const SCRIPT_ID = 'vdh-hook';

/** Origin patterns the user has granted that the hook may run on (web pages only). */
export async function grantedWebPatterns(): Promise<string[]> {
  try {
    const all = await chrome.permissions.getAll();
    return (all.origins ?? []).filter((o) => o === '<all_urls>' || /^(\*|https?):\/\//.test(o));
  } catch {
    return [];
  }
}

let syncing: Promise<boolean> = Promise.resolve(false);

/**
 * Keep the page hook registered exactly while the user wants it AND has granted site access. It is registered only
 * for the granted patterns, so revoking access removes it from those sites too. Safe to call at any time.
 * Calls run one after another: two overlapping ones could otherwise finish in the wrong order and leave the hook
 * registered after the user turned it off.
 */
export function syncHook(): Promise<boolean> {
  const run = syncing.then(syncHookNow, syncHookNow);
  syncing = run;
  return run;
}

async function syncHookNow(): Promise<boolean> {
  try {
    const settings = await loadSettings();
    const matches = settings.pageHook ? await grantedWebPatterns() : [];
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
    if (matches.length === 0) {
      if (existing.length > 0) await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
      return false;
    }
    const script = {
      id: SCRIPT_ID,
      js: ['hook.js'],
      matches,
      allFrames: true,
      matchOriginAsFallback: true,
      runAt: 'document_start' as const,
      world: 'MAIN' as const,
      persistAcrossSessions: true,
    };
    if (existing.length > 0) await chrome.scripting.updateContentScripts([script]);
    else await chrome.scripting.registerContentScripts([script]);
    return true;
  } catch (e) {
    log.warn('page hook sync failed:', e instanceof Error ? e.message : 'error');
    return false;
  }
}

export interface FrameHookReport {
  frameId: number;
  report: HookReport;
}

/** Read what the hook saw, from every frame that has it. Frames without the hook simply return nothing. */
export async function readHookReports(tabId: number): Promise<FrameHookReport[]> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'MAIN',
      func: () => {
        const hook = (window as unknown as { __vdhHook?: { drain?: () => unknown } }).__vdhHook;
        return hook && typeof hook.drain === 'function' ? hook.drain() : null;
      },
    });
    return results
      .filter((r) => r.result)
      .map((r) => ({ frameId: r.frameId, report: parseHookReport(r.result) }));
  } catch {
    return [];
  }
}
