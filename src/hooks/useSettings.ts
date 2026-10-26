import { useCallback, useEffect, useState } from 'react';
import {
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  loadSettings,
  resetSettings,
  saveSettings,
  sanitizeSettings,
} from '@/lib/settings';
import type { Settings } from '@/types/settings';

export function useSettings(): {
  settings: Settings;
  loaded: boolean;
  update: (patch: Partial<Settings>) => Promise<void>;
  reset: () => Promise<void>;
} {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    void loadSettings().then((s) => {
      if (alive) {
        setSettings(s);
        setLoaded(true);
      }
    });
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && changes[SETTINGS_KEY])
        setSettings(sanitizeSettings(changes[SETTINGS_KEY].newValue));
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      alive = false;
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, []);

  const update = useCallback(async (patch: Partial<Settings>) => {
    setSettings(await saveSettings(patch));
  }, []);
  const reset = useCallback(async () => {
    setSettings(await resetSettings());
  }, []);
  return { settings, loaded, update, reset };
}
