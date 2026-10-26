import type { MetaMedia } from '../metadata';
import { safeAbs } from '../metadata';
import type { SiteLookup } from './types';

/** The Internet Archive: `https://archive.org/details/<identifier>`, its public metadata API lists the files. */
export function archiveLookup(page: URL): SiteLookup | undefined {
  if (page.protocol !== 'https:' || !/^(www\.)?archive\.org$/.test(page.hostname)) return undefined;
  const m = /^\/details\/([A-Za-z0-9][A-Za-z0-9._-]{0,100})(?:\/|$)/.exec(page.pathname);
  if (!m) return undefined;
  const id = m[1] as string;
  return {
    site: 'archive',
    apiUrl: new URL(`/metadata/${id}`, page.origin).href,
    parse: (json) => parseArchive(json, id, page.origin),
  };
}

const VIDEO = /\.(mp4|m4v|webm|mkv|ogv|avi|mov|mpg|mpeg|flv|wmv|3gp)$/i;
const AUDIO = /\.(mp3|m4a|aac|ogg|oga|opus|flac|wav|aif|aiff|wma)$/i;
const MIME: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  ogv: 'video/ogg',
  avi: 'video/x-msvideo',
  mov: 'video/quicktime',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
  flv: 'video/x-flv',
  wmv: 'video/x-ms-wmv',
  '3gp': 'video/3gpp',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/opus',
  flac: 'audio/flac',
  wav: 'audio/wav',
  aif: 'audio/aiff',
  aiff: 'audio/aiff',
  wma: 'audio/x-ms-wma',
};
const MAX_FILES = 40;

interface Rec {
  [k: string]: unknown;
}
const rec = (v: unknown): Rec | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
const numeric = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined;
};

/** Audio and video files of an item (originals first); thumbnails, metadata files and the like are left out. */
export function parseArchive(json: unknown, id: string, origin: string): MetaMedia[] {
  const root = rec(json);
  const files = Array.isArray(root?.['files']) ? (root['files'] as unknown[]) : [];
  const itemTitle = rec(root?.['metadata'])?.['title'];
  const title = typeof itemTitle === 'string' && itemTitle.trim() ? itemTitle.trim().slice(0, 160) : id;
  const rows: Array<{ media: MetaMedia; original: boolean }> = [];
  for (const f of files) {
    const r = rec(f);
    const name = r?.['name'];
    if (
      typeof name !== 'string' ||
      name.length > 300 ||
      name.startsWith('__ia_') ||
      /_thumb|\.gif$/i.test(name)
    )
      continue;
    const video = VIDEO.test(name);
    if (!video && !AUDIO.test(name)) continue;
    // the name is a path inside the item; every segment is encoded, and nothing may climb out of it
    if (name.split('/').some((s) => s === '..' || s === '.' || s === '')) continue;
    const url = safeAbs(`/download/${id}/${name.split('/').map(encodeURIComponent).join('/')}`, origin);
    if (!url) continue;
    const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
    const w = numeric(r?.['width']);
    const h = numeric(r?.['height']);
    rows.push({
      original: r?.['source'] === 'original',
      media: {
        url,
        mimeType: MIME[ext] ?? (video ? 'video/mp4' : 'audio/mpeg'),
        mediaType: video ? 'video' : 'audio',
        title: `${title} · ${name.slice(name.lastIndexOf('/') + 1)}`.slice(0, 200),
        ...(numeric(r?.['length']) ? { durationSec: numeric(r?.['length']) as number } : {}),
        ...(w && h ? { width: w, height: h } : {}),
      },
    });
  }
  rows.sort((a, b) => Number(b.original) - Number(a.original));
  return rows.slice(0, MAX_FILES).map((x) => x.media);
}
