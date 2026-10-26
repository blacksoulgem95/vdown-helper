import { RefreshCw, ScanSearch, ShieldCheck } from 'lucide-react';
import { t } from '@/lib/i18n';
import type { EmptyCause } from '@/lib/tabs';
import { Button } from './ui';

/** Nothing to offer yet: say why in one sentence and show the one button that fixes it. */
export function EmptyState({
  cause,
  scanning,
  errorText,
  blockedHosts,
  onScan,
  onAllowFrames,
  onReload,
}: {
  cause: EmptyCause;
  scanning: boolean;
  errorText?: string;
  blockedHosts?: string;
  onScan: () => void;
  onAllowFrames: () => void;
  onReload: () => void;
}) {
  const title =
    cause === 'error'
      ? t('emptyErrorTitle')
      : cause === 'blocked-frames'
        ? t('emptyBlockedTitle')
        : cause === 'reload'
          ? t('emptyReloadTitle')
          : t('emptyTitle');
  const body =
    cause === 'error'
      ? (errorText ?? '')
      : cause === 'blocked-frames'
        ? `${t('noteFramesBlocked', blockedHosts ?? '')} ${t('allowEmbeddedHint')}`
        : cause === 'reload'
          ? t('reloadForHook')
          : t('emptyBody');
  return (
    <div className="glass flex flex-col items-center gap-3 px-6 py-6 text-center">
      <ScanSearch size={22} aria-hidden="true" className="text-neon/70" />
      <div>
        <h2 className="mono text-[12px] uppercase tracking-[0.14em] text-fg">{title}</h2>
        <p className="mx-auto mt-1.5 max-w-[320px] text-[12px] leading-snug text-muted">{body}</p>
      </div>
      {cause === 'blocked-frames' ? (
        <Button variant="primary" onClick={onAllowFrames} icon={<ShieldCheck size={14} aria-hidden="true" />}>
          {t('allowEmbedded')}
        </Button>
      ) : cause === 'reload' ? (
        <Button variant="primary" onClick={onReload} icon={<RefreshCw size={14} aria-hidden="true" />}>
          {t('reloadPage')}
        </Button>
      ) : (
        <Button
          variant="primary"
          onClick={onScan}
          disabled={scanning}
          icon={<ScanSearch size={14} aria-hidden="true" />}
        >
          {scanning ? t('scanning') : t('scanAgain')}
        </Button>
      )}
    </div>
  );
}
