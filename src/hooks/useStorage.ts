import { useEffect, useState } from 'react';

/** Subscribe to one key of a chrome.storage area, with an initial load. */
export function useStorageValue<T>(area: 'local' | 'session', key: string, fallback: T): T {
  const [value, setValue] = useState<T>(fallback);
  useEffect(() => {
    let alive = true;
    chrome.storage[area]
      .get(key)
      .then((r) => {
        if (alive && r[key] !== undefined) setValue(r[key] as T);
      })
      .catch(() => undefined);
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, a: string) => {
      if (a === area && changes[key]) setValue((changes[key].newValue as T | undefined) ?? fallback);
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      alive = false;
      chrome.storage.onChanged.removeListener(onChanged);
    };
    // `fallback` is intentionally excluded: callers pass a stable literal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [area, key]);
  return value;
}
