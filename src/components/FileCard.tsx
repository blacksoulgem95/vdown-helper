import { Archive, Download, FileCode2, FileText, Image as ImageIcon } from 'lucide-react';
import { t } from '@/lib/i18n';
import { formatBytes } from '@/lib/media';
import { redactUrl } from '@/lib/security';
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
        {/* No remote thumbnail: loading one would make the extension request an address the page chose. */}
        <Icon r={r} />
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
