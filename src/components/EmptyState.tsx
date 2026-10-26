import { ScanSearch } from 'lucide-react';
import { t } from '@/lib/i18n';
import { Button } from './ui';

/** CSS-only "radar" illustration, shown when nothing downloadable was found. */
export function EmptyState({
  onScan,
  scanning,
  errorText,
}: {
  onScan: () => void;
  scanning: boolean;
  errorText?: string;
}) {
  return (
    <div className="glass flex flex-col items-center gap-3 px-6 py-7 text-center">
      <div aria-hidden="true" className="relative h-24 w-24">
        <div className="absolute inset-0 rounded-full border border-neon/25" />
        <div className="absolute inset-3 rounded-full border border-neon/20" />
        <div className="absolute inset-6 rounded-full border border-magenta/30" />
        <div className="absolute left-1/2 top-0 h-full w-px bg-gradient-to-b from-transparent via-neon/30 to-transparent" />
        <div className="absolute left-0 top-1/2 h-px w-full bg-gradient-to-r from-transparent via-neon/30 to-transparent" />
        <div className="absolute inset-0 overflow-hidden rounded-full">
          <div className="absolute inset-x-0 h-1/2 bg-gradient-to-b from-neon/25 to-transparent animate-scan" />
        </div>
        <div className="absolute left-1/2 top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-magenta shadow-[0_0_10px_#ff2bd6]" />
      </div>
      <div>
        <h2 className="mono text-[12px] uppercase tracking-[0.14em] text-fg">
          {errorText ? t('emptyErrorTitle') : t('emptyTitle')}
        </h2>
        <p className="mx-auto mt-1.5 max-w-[300px] text-[12px] leading-snug text-muted">
          {errorText ?? t('emptyBody')}
        </p>
      </div>
      <Button
        variant="secondary"
        onClick={onScan}
        disabled={scanning}
        icon={<ScanSearch size={14} aria-hidden="true" />}
      >
        {scanning ? t('scanning') : t('scanAgain')}
      </Button>
    </div>
  );
}
