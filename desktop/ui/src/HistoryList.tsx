import { Eraser, ExternalLink, FolderOpen } from 'lucide-react';
import { stageLabel } from '@/components/labels';
import { Button, IconButton, cx } from '@/components/ui';
import { t } from '@/lib/i18n';
import { formatBytes } from '@/lib/media';
import type { JobStage } from '@/types/download';
import type { HistoryEntry } from './api';
import { errorText } from './errors';
import { td, type Lang } from './i18n';

/** Finished downloads, newest first: completed ones can be opened or shown in their folder. */
export function HistoryList({
  entries,
  enabled,
  lang,
  onOpen,
  onClear,
}: {
  entries: HistoryEntry[];
  enabled: boolean;
  lang: Lang;
  onOpen: (path: string, reveal: boolean) => void;
  onClear: () => void;
}) {
  if (entries.length === 0)
    return (
      <p className="py-6 text-center text-[12px] text-muted" data-testid="history-empty">
        {enabled ? td('historyEmpty') : td('historyOff')}
      </p>
    );
  const when = new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <div className="space-y-2">
      <ul className="space-y-2" data-testid="history">
        {entries.map((h) => {
          const done = h.stage === 'completed';
          return (
            <li key={`${h.id}-${h.finishedAt}`} className="glass p-3" data-stage={h.stage}>
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12.5px] font-medium text-fg" title={h.filename}>
                    {h.filename}
                  </p>
                  <p className="mono mt-0.5 truncate text-[10.5px] text-muted" title={h.source}>
                    {h.source}
                  </p>
                  <p className="mono mt-0.5 text-[10.5px] text-muted">
                    {td('finishedAt', when.format(new Date(h.finishedAt)))}
                    {h.bytes !== undefined ? ` · ${formatBytes(h.bytes)}` : ''}
                  </p>
                  {h.error && <p className="mt-1 text-[11.5px] text-danger">{errorText(h.error)}</p>}
                </div>
                <span
                  className={cx(
                    'mono shrink-0 text-[10.5px] uppercase',
                    done ? 'text-acid' : h.stage === 'failed' ? 'text-danger' : 'text-muted',
                  )}
                >
                  {stageLabel(h.stage as JobStage)}
                </span>
              </div>
              {done && h.path && (
                <div className="mt-1 flex justify-end gap-0.5">
                  <IconButton label={t('openFile')} onClick={() => onOpen(h.path ?? '', false)}>
                    <ExternalLink size={14} aria-hidden="true" />
                  </IconButton>
                  <IconButton label={t('showInFolder')} onClick={() => onOpen(h.path ?? '', true)}>
                    <FolderOpen size={14} aria-hidden="true" />
                  </IconButton>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <div className="flex justify-end">
        <Button variant="ghost" size="sm" onClick={onClear} icon={<Eraser size={12} aria-hidden="true" />}>
          {t('clearHistory')}
        </Button>
      </div>
    </div>
  );
}
