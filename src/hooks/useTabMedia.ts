import { useCallback, useEffect, useRef, useState } from 'react';
import { send } from '@/lib/messaging';
import type { TabState } from '@/types/messages';
import { useStorageValue } from './useStorage';

/** The active tab in the current window (popup) or the window the side panel belongs to. */
export function useActiveTabId(): number | undefined {
  const [id, setId] = useState<number | undefined>();
  useEffect(() => {
    // Automated tests open the popup page in a normal tab and name the tab to inspect with ?tabId=N.
    const forced = Number(new URLSearchParams(location.search).get('tabId'));
    if (Number.isInteger(forced) && forced > 0) {
      setId(forced);
      return;
    }
    let alive = true;
    const load = () =>
      chrome.tabs
        .query({ active: true, currentWindow: true })
        .then(([t]) => alive && setId(t?.id))
        .catch(() => undefined);
    void load();
    const onActivated = () => void load();
    chrome.tabs.onActivated.addListener(onActivated);
    return () => {
      alive = false;
      chrome.tabs.onActivated.removeListener(onActivated);
    };
  }, []);
  return id;
}

export interface TabMedia {
  state: TabState | null;
  /** True from the moment a scan is requested until the background reports a result. */
  scanning: boolean;
  rescan: () => Promise<void>;
}

/** Live per-tab detection results. Scans once on mount (unless told not to) and on demand. */
export function useTabMedia(tabId: number | undefined, scanOnMount = true): TabMedia {
  const stored = useStorageValue<TabState | null>('session', `tab:${tabId ?? -1}`, null);
  // A scan is about to start when the popup opens, so it must not claim to be idle before the first one runs.
  const [pending, setPending] = useState(scanOnMount);
  const started = useRef<number | undefined>(undefined);

  const rescan = useCallback(async () => {
    if (tabId === undefined) return;
    setPending(true);
    try {
      await send('scan', { tabId });
    } finally {
      setPending(false);
    }
  }, [tabId]);

  useEffect(() => {
    // No tab to scan (e.g. the tab lookup failed): do not stay "scanning" forever.
    if (tabId !== undefined || !scanOnMount) return;
    const t = setTimeout(() => setPending(false), 1500);
    return () => clearTimeout(t);
  }, [tabId, scanOnMount]);

  useEffect(() => {
    if (tabId === undefined || !scanOnMount || started.current === tabId) return;
    started.current = tabId;
    void rescan();
  }, [tabId, scanOnMount, rescan]);

  return { state: stored, scanning: pending || stored?.status === 'scanning', rescan };
}
