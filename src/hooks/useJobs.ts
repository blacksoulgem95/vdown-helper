import type { DownloadJob } from '@/types/download';
import { useStorageValue } from './useStorage';

const EMPTY: Record<string, DownloadJob> = {};

/** Live download queue (persisted by the background in chrome.storage.local), newest first. */
export function useJobs(): DownloadJob[] {
  const map = useStorageValue<Record<string, DownloadJob>>('local', 'jobs', EMPTY);
  return Object.values(map).sort((a, b) => b.createdAt - a.createdAt);
}
