/** The app's commands (`desktop/src-tauri/src/commands.rs`). */
import { invoke } from '@tauri-apps/api/core';
import type { DownloadJob, DownloadRequest, OutputMode } from '@/types/download';
import type { Lang } from './i18n';

export interface EngineError {
  code: string;
  message: string;
}

export interface Probed {
  kind: string;
  format: string;
  title: string;
  live: boolean;
  durationSec?: number;
  /** `[height, bandwidth]` per variant, in the playlist's order. */
  variants: Array<[number | null, number]>;
  /** The chosen variant (index into `variants`). */
  variant?: number;
  /** Encryption whose key is delivered openly. */
  encryption?: 'aes-128';
  request: DownloadRequest;
}

export interface Choice {
  mode?: OutputMode;
  variant?: number;
}

export interface HistoryEntry {
  id: string;
  finishedAt: number;
  stage: string;
  filename: string;
  source: string;
  path?: string;
  bytes?: number;
  error?: EngineError;
}

export interface AppSettings {
  outDir: string;
  maxJobs: number;
  segments: number;
  rateKbps: number;
  window: string;
  history: boolean;
  closeToTray: boolean;
  startAtLogin: boolean;
  notifications: boolean;
  language: 'auto' | Lang;
}

export interface SettingsView {
  settings: AppSettings;
  defaultOutDir: string;
  language: Lang;
}

export type Control = 'pause' | 'resume' | 'retry' | 'cancel' | 'stop' | 'remove';

export const api = {
  probe: (url: string, choice: Choice) => invoke<Probed>('probe', { url, choice }),
  add: (url: string, choice: Choice) => invoke<string>('add', { url, choice }),
  jobs: () => invoke<DownloadJob[]>('jobs'),
  control: (id: string, action: Control) => invoke<void>('control', { id, action }),
  history: () => invoke<HistoryEntry[]>('history'),
  clearHistory: () => invoke<void>('clear_history'),
  settings: () => invoke<SettingsView>('get_settings'),
  saveSettings: (settings: AppSettings) => invoke<SettingsView>('save_settings', { settings }),
  pickFolder: () => invoke<string | null>('pick_folder'),
  openFile: (path: string, reveal: boolean) => invoke<void>('open_file', { path, reveal }),
};

/** A rejected command's error, whatever shape it came in. */
export function asEngineError(e: unknown): EngineError {
  if (e && typeof e === 'object' && 'code' in e && 'message' in e)
    return { code: String(e.code), message: String(e.message) };
  return { code: 'unknown', message: String(e) };
}
