import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_DESKTOP, DESKTOP_KEY, sanitizeDesktop } from '@/lib/desktop';
import type { DesktopSettings } from '@/types/desktop';

/** The desktop app settings (their own storage key), kept current across the extension's pages. */
export function useDesktop(): {
  desktop: DesktopSettings;
  update: (patch: Partial<DesktopSettings>) => Promise<void>;
} {
  const [desktop, setDesktop] = useState<DesktopSettings>(DEFAULT_DESKTOP);
  useEffect(() => {
    let alive = true;
    void chrome.storage.local.get(DESKTOP_KEY).then((got) => {
      if (alive) setDesktop(sanitizeDesktop(got[DESKTOP_KEY]));
    });
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && changes[DESKTOP_KEY])
        setDesktop(sanitizeDesktop(changes[DESKTOP_KEY].newValue));
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      alive = false;
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, []);
  const update = useCallback(async (patch: Partial<DesktopSettings>) => {
    const current = sanitizeDesktop((await chrome.storage.local.get(DESKTOP_KEY))[DESKTOP_KEY]);
    const next = sanitizeDesktop({ ...current, ...patch });
    await chrome.storage.local.set({ [DESKTOP_KEY]: next });
    setDesktop(next);
  }, []);
  return { desktop, update };
}
