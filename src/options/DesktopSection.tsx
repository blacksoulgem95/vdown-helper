import { MonitorDown, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Button, Notice, SelectField, Toggle } from '@/components/ui';
import { useDesktop } from '@/hooks/useDesktop';
import { ROUTINGS } from '@/lib/desktop';
import { t, type MessageKey } from '@/lib/i18n';
import { send } from '@/lib/messaging';
import type { DesktopRouting, DesktopStatus } from '@/types/desktop';
import { Section } from './Section';

/** Asked when the user turns the desktop app on, given back when they turn it off. */
const LINK: chrome.permissions.Permissions = { permissions: ['nativeMessaging', 'cookies'] };

const ROUTING_LABELS: Record<DesktopRouting, MessageKey> = {
  never: 'routingNever',
  streams: 'routingStreams',
  always: 'routingAlways',
};

/** The desktop app: on/off (with its permissions), whether it answers, and which downloads go to it. */
export function DesktopSection() {
  const { desktop, update } = useDesktop();
  const [status, setStatus] = useState<DesktopStatus>();
  const [checking, setChecking] = useState(false);
  const [denied, setDenied] = useState(false);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      const res = await send('desktop-status', {});
      setStatus(res.ok ? res.status : undefined);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    if (desktop.enabled) void check();
    else setStatus(undefined);
  }, [desktop.enabled, check]);

  const toggle = async (on: boolean) => {
    setDenied(false);
    if (on) {
      // the click is the user gesture the prompt needs
      if (!(await chrome.permissions.request(LINK))) return setDenied(true);
      await update({ enabled: true });
    } else {
      await update({ enabled: false });
      await chrome.permissions.remove(LINK).catch(() => false);
    }
  };

  return (
    <Section title={t('secDesktop')} hint={t('secDesktopHint')}>
      <Toggle
        label={t('optDesktop')}
        description={t('optDesktopHint')}
        checked={desktop.enabled}
        onChange={(v) => void toggle(v)}
      />
      {denied && (
        <Notice tone="danger" role="alert">
          {t('permDenied')}
        </Notice>
      )}
      {desktop.enabled && (
        <>
          <div className="flex items-center gap-2" data-testid="desktop-status">
            <div className="min-w-0 flex-1">
              {status?.connected ? (
                <Notice tone="acid" role="status">
                  {t('desktopConnected', status.appVersion ?? '?', status.ffmpeg ?? t('desktopNoFfmpeg'))}
                </Notice>
              ) : (
                status && (
                  <Notice tone="danger" role="status">
                    {t('desktopUnreachable')}
                  </Notice>
                )
              )}
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void check()}
              disabled={checking}
              icon={<RefreshCw size={12} aria-hidden="true" />}
            >
              {t('desktopCheck')}
            </Button>
          </div>
          <SelectField
            label={t('optDesktopRouting')}
            hint={t('optDesktopRoutingHint')}
            value={desktop.routing}
            onChange={(e) => void update({ routing: e.target.value as DesktopRouting })}
            options={ROUTINGS.map((r) => ({ value: r, label: t(ROUTING_LABELS[r]) }))}
          />
          <p className="flex items-start gap-1.5 text-[11.5px] leading-snug text-muted">
            <MonitorDown size={13} aria-hidden="true" className="mt-0.5 shrink-0" />
            {t('optDesktopCookiesHint')}
          </p>
        </>
      )}
    </Section>
  );
}
