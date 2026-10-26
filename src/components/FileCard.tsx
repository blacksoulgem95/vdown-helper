import { Archive, Download, FileCode2, FileText, Image as ImageIcon } from 'lucide-react';
import { t } from '@/lib/i18n';
import { formatBytes } from '@/lib/media';
import { parseUrl, redactUrl } from '@/lib/security';
import type { MediaResource } from '@/types/media';
import { heldSource } from './MediaCard';
import { reasonText } from './labels';
import { Badge, IconButton, cx } from './ui';

function Icon({ r }: { r: MediaResource }) {
  const common = { size: 16, 'aria-hidden': true } as const;
  if (r.kind === 'image') return <ImageIcon {...common} />;
  if (r.kind === 'archive') return <Archive {...common} />;
  if (r.kind === 'document') return <FileText {...common} />;
  return <FileCode2 {...common} />;
}

/** A thumbnail is only fetched for an image on the very site the user is on (the page loaded it already). */
function thumbnailUrl(r: MediaResource): string | undefined {
  if (r.kind !== 'image' || r.held) return undefined;
  const u = parseUrl(r.url);
  const page = parseUrl(r.pageUrl);
  return u && page && u.protocol === 'https:' && u.hostname === page.hostname ? r.url : undefined;
}

export interface FileCardProps {
  resource: MediaResource;
  selected: boolean;
  busy?: boolean;
  feedback?: { tone: 'danger' | 'acid'; text: string };
  onToggle: (r: MediaResource) => void;
  onDownload: (r: MediaResource) => void;
}

/** One row of the Images / Files / Assets tabs: compact, selectable, one-click download. */
export function FileCard({ resource: r, selected, busy, feedback, onToggle, onDownload }: FileCardProps) {
  const ok = r.downloadability.status === 'downloadable';
  const name = r.ext ? `${r.title}.${r.ext}` : r.title;
  const thumb = thumbnailUrl(r);
  const meta = [
    r.width && r.height ? t('dimensionsPx', r.width, r.height) : '',
    r.sizeBytes !== undefined ? formatBytes(r.sizeBytes) : '',
  ].filter(Boolean);
  return (
    <li className="glass flex items-center gap-2.5 px-2.5 py-2" data-resource-id={r.id} data-kind={r.kind}>
      <input
        type="checkbox"
        className="h-4 w-4 shrink-0 accent-[#00f5ff]"
        checked={selected}
        disabled={!ok}
        aria-label={t('selectItem', name)}
        onChange={() => onToggle(r)}
      />
      <div
        className={cx(
          'flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-md border',
          ok ? 'border-neon/30 text-neon' : 'border-white/12 text-muted',
        )}
      >
        {thumb ? (
          <img src={thumb} alt="" className="h-full w-full object-cover" referrerPolicy="no-referrer" />
        ) : (
          <Icon r={r} />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[12.5px] text-fg" title={name}>
          {name}
        </p>
        <p className="mono truncate text-[10.5px] text-muted" title={redactUrl(r.url)}>
          {meta.join(' · ') || (r.held ? heldSource(r) : r.host)}
        </p>
        {!ok && <p className="text-[10.5px] leading-snug text-muted">{reasonText(r.downloadability)}</p>}
        {feedback && (
          <p
            role={feedback.tone === 'danger' ? 'alert' : 'status'}
            className={cx('text-[10.5px]', feedback.tone === 'danger' ? 'text-danger' : 'text-acid')}
          >
            {feedback.text}
          </p>
        )}
      </div>
      {r.ext ? <Badge tone="neon">{r.ext.toUpperCase()}</Badge> : null}
      <IconButton label={`${t('download')} ${name}`} disabled={!ok || busy} onClick={() => onDownload(r)}>
        <Download size={15} aria-hidden="true" />
      </IconButton>
    </li>
  );
}
