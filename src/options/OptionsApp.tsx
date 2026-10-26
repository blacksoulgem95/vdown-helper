import { Eraser, RotateCcw, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Logo } from '@/components/Logo';
import { Badge, Button, Notice, Panel, SelectField, TextField, Toggle } from '@/components/ui';
import { useSettings } from '@/hooks/useSettings';
import { t } from '@/lib/i18n';
import { send } from '@/lib/messaging';
import { LIMITS } from '@/lib/settings';
import { renderNameTemplate, NAME_TOKENS } from '@/lib/security';
import type { AudioBitrate, AudioFormat, OutputMode } from '@/types/download';
import type { QualityPreset } from '@/types/settings';

const ALL_SITES: chrome.permissions.Permissions = { origins: ['<all_urls>'] };
// The page hook also lets downloads replay the Referer/Origin of the frame that owns a stream.
const HOOK: chrome.permissions.Permissions = {
  origins: ['<all_urls>'],
  permissions: ['declarativeNetRequestWithHostAccess'],
};
const OBSERVER: chrome.permissions.Permissions = { permissions: ['webRequest'], origins: ['<all_urls>'] };

// The typings expose a callback/promise hybrid; this pins the promise form.
const contains = (p: chrome.permissions.Permissions) =>
  chrome.permissions.contains(p) as unknown as Promise<boolean>;

function Section({ title, children, hint }: { title: string; children: ReactNode; hint?: string }) {
  return (
    <Panel className="p-5">
      <h2 className="mono text-[12px] uppercase tracking-[0.16em] text-neon">{title}</h2>
      {hint && <p className="mt-1 text-[12px] text-muted">{hint}</p>}
      <div className="rule my-3" />
      <div className="space-y-4">{children}</div>
    </Panel>
  );
}

export function OptionsApp() {
  const { settings, loaded, update, reset } = useSettings();
  const [allSites, setAllSites] = useState(false);
  const [observerOk, setObserverOk] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'acid' | 'danger'; text: string } | undefined>();

  const refreshPermissions = useCallback(async () => {
    setAllSites(await contains(ALL_SITES));
    setObserverOk(await contains(OBSERVER));
  }, []);
  useEffect(() => {
    void refreshPermissions();
    chrome.permissions.onAdded.addListener(() => void refreshPermissions());
    chrome.permissions.onRemoved.addListener(() => void refreshPermissions());
  }, [refreshPermissions]);

  const flash = (tone: 'acid' | 'danger', text: string) => setMsg({ tone, text });

  const toggleAutoScan = async (on: boolean) => {
    if (on) {
      const ok = await chrome.permissions.request(ALL_SITES);
      if (!ok) return flash('danger', t('permDenied'));
    }
    await update({ autoScan: on });
    await refreshPermissions();
  };
  const toggleHook = async (on: boolean) => {
    if (on) {
      const ok = await chrome.permissions.request(HOOK);
      if (!ok) return flash('danger', t('permDenied'));
    }
    await update({ pageHook: on });
    await refreshPermissions();
  };
  const toggleObserver = async (on: boolean) => {
    if (on) {
      const ok = await chrome.permissions.request(OBSERVER);
      if (!ok) return flash('danger', t('permDenied'));
    }
    await update({ networkObserver: on });
    await send('set-observer', { enabled: on });
    await refreshPermissions();
  };
  const revokeAll = async () => {
    await update({ autoScan: false, networkObserver: false, pageHook: false });
    await chrome.permissions
      .remove({ permissions: ['webRequest', 'declarativeNetRequestWithHostAccess'] })
      .catch(() => false);
    await chrome.permissions.remove(ALL_SITES).catch(() => false);
    await refreshPermissions();
    flash('acid', t('permRevoked'));
  };

  const preview = renderNameTemplate(settings.namingTemplate, {
    title: 'Sample video',
    host: 'example.com',
    resolution: '1080p',
    date: new Date().toISOString().slice(0, 10),
    format: 'mp4',
    id: 'a1b2c3d4',
  });

  const num = (v: string, fallback: number) =>
    Number.isFinite(Number(v)) && v.trim() !== '' ? Number(v) : fallback;

  return (
    <div className="mx-auto max-w-[760px] px-5 py-8">
      <header className="mb-6 flex items-center gap-3">
        <Logo size={36} />
        <div>
          <h1 className="mono text-[18px] font-bold tracking-[0.04em]">vdown-helper · {t('settings')}</h1>
          <p className="label !tracking-[0.22em]">{t('signature')}</p>
        </div>
        <Badge>v{chrome.runtime.getManifest().version}</Badge>
      </header>

      {msg && (
        <div className="mb-4" aria-live="polite">
          <Notice tone={msg.tone} role="status">
            {msg.text}
          </Notice>
        </div>
      )}

      <div className="space-y-5" aria-busy={!loaded}>
        <Section title={t('secDownloads')}>
          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField
              label={t('optDefaultMode')}
              value={settings.defaultMode}
              onChange={(e) => void update({ defaultMode: e.target.value as OutputMode })}
              options={[
                { value: 'video-audio', label: t('modeVideoAudio') },
                { value: 'audio-only', label: t('modeAudioOnly') },
                { value: 'video-only', label: t('modeVideoOnly') },
                { value: 'original', label: t('modeOriginal') },
              ]}
            />
            <SelectField
              label={t('optPreferredQuality')}
              hint={t('optPreferredQualityHint')}
              value={settings.preferredQuality}
              onChange={(e) => void update({ preferredQuality: e.target.value as QualityPreset })}
              options={[
                { value: 'highest', label: t('qualityHighest') },
                ...(['2160', '1440', '1080', '720', '480', '360'] as const).map((q) => ({
                  value: q,
                  label: `${q}p`,
                })),
              ]}
            />
            <SelectField
              label={t('optAudioFormat')}
              value={settings.defaultAudioFormat}
              onChange={(e) => void update({ defaultAudioFormat: e.target.value as AudioFormat })}
              options={[
                { value: 'mp3', label: 'MP3' },
                { value: 'm4a', label: 'M4A' },
                { value: 'aac', label: 'AAC' },
                { value: 'wav', label: 'WAV' },
              ]}
            />
            <SelectField
              label={t('optAudioBitrate')}
              value={String(settings.defaultAudioBitrate)}
              onChange={(e) => void update({ defaultAudioBitrate: Number(e.target.value) as AudioBitrate })}
              options={[128, 192, 256, 320].map((b) => ({ value: String(b), label: `${b} kbps` }))}
            />
          </div>
          <TextField
            label={t('optNaming')}
            hint={`${t('optNamingHint', NAME_TOKENS.map((k) => `{${k}}`).join(' '))}  →  ${preview}.mp4`}
            value={settings.namingTemplate}
            maxLength={LIMITS.namingTemplate.maxLength}
            onChange={(e) => void update({ namingTemplate: e.target.value })}
          />
          <TextField
            label={t('optSubfolder')}
            hint={t('optSubfolderHint')}
            placeholder="vdown"
            value={settings.subfolder}
            onChange={(e) => void update({ subfolder: e.target.value })}
          />
          <Toggle
            label={t('optAskWhere')}
            description={t('optAskWhereHint')}
            checked={settings.askWhereToSave}
            onChange={(v) => void update({ askWhereToSave: v })}
          />
          <TextField
            label={t('optMaxConcurrent')}
            type="number"
            min={LIMITS.maxConcurrentDownloads.min}
            max={LIMITS.maxConcurrentDownloads.max}
            value={settings.maxConcurrentDownloads}
            onChange={(e) =>
              void update({ maxConcurrentDownloads: num(e.target.value, settings.maxConcurrentDownloads) })
            }
          />
        </Section>

        <Section title={t('secDetection')} hint={t('secDetectionHint')}>
          <Toggle
            label={t('optAutoScan')}
            description={t('optAutoScanHint')}
            checked={settings.autoScan && allSites}
            onChange={(v) => void toggleAutoScan(v)}
          />
          <Toggle
            label={t('optPageHook')}
            description={t('optPageHookHint')}
            checked={settings.pageHook && allSites}
            onChange={(v) => void toggleHook(v)}
          />
          <Toggle
            label={t('optObserver')}
            description={t('optObserverHint')}
            checked={settings.networkObserver && observerOk}
            onChange={(v) => void toggleObserver(v)}
          />
          {(allSites || observerOk) && (
            <Button
              variant="danger"
              onClick={() => void revokeAll()}
              icon={<ShieldCheck size={13} aria-hidden="true" />}
            >
              {t('revokeAccess')}
            </Button>
          )}
        </Section>

        <Section title={t('secProcessing')} hint={t('secProcessingHint')}>
          <div className="grid gap-4 sm:grid-cols-3">
            <TextField
              label={t('optSegmentConcurrency')}
              type="number"
              min={LIMITS.segmentConcurrency.min}
              max={LIMITS.segmentConcurrency.max}
              value={settings.segmentConcurrency}
              onChange={(e) =>
                void update({ segmentConcurrency: num(e.target.value, settings.segmentConcurrency) })
              }
            />
            <TextField
              label={t('optMaxMemory')}
              hint={t('optMaxMemoryHint')}
              type="number"
              min={LIMITS.maxMemoryMb.min}
              max={LIMITS.maxMemoryMb.max}
              value={settings.maxMemoryMb}
              onChange={(e) => void update({ maxMemoryMb: num(e.target.value, settings.maxMemoryMb) })}
            />
            <TextField
              label={t('optMaxEncode')}
              hint={t('optMaxEncodeHint')}
              type="number"
              min={LIMITS.maxEncodeDurationSec.min}
              max={LIMITS.maxEncodeDurationSec.max}
              value={settings.maxEncodeDurationSec}
              onChange={(e) =>
                void update({ maxEncodeDurationSec: num(e.target.value, settings.maxEncodeDurationSec) })
              }
            />
          </div>
          <Notice tone="magenta">{t('processingWarning')}</Notice>
        </Section>

        <Section title={t('secRecording')} hint={t('secRecordingHint')}>
          <div className="grid gap-4 sm:grid-cols-3">
            <SelectField
              label={t('optRecordContainer')}
              hint={t('optRecordContainerHint')}
              value={settings.recordContainer}
              onChange={(e) => void update({ recordContainer: e.target.value === 'mp4' ? 'mp4' : 'webm' })}
              options={[
                { value: 'webm', label: 'WebM' },
                { value: 'mp4', label: 'MP4' },
              ]}
            />
            <TextField
              label={t('optRecordMaxMinutes')}
              type="number"
              min={LIMITS.recordMaxMinutes.min}
              max={LIMITS.recordMaxMinutes.max}
              value={settings.recordMaxMinutes}
              onChange={(e) =>
                void update({ recordMaxMinutes: num(e.target.value, settings.recordMaxMinutes) })
              }
            />
            <TextField
              label={t('optRecordMaxMb')}
              type="number"
              min={LIMITS.recordMaxMb.min}
              max={LIMITS.recordMaxMb.max}
              value={settings.recordMaxMb}
              onChange={(e) => void update({ recordMaxMb: num(e.target.value, settings.recordMaxMb) })}
            />
          </div>
        </Section>

        <Section title={t('secNotifications')}>
          <Toggle
            label={t('optNotifyDone')}
            checked={settings.notifyOnComplete}
            onChange={(v) => void update({ notifyOnComplete: v })}
          />
          <Toggle
            label={t('optNotifyFail')}
            checked={settings.notifyOnError}
            onChange={(v) => void update({ notifyOnError: v })}
          />
        </Section>

        <Section title={t('secPermissions')} hint={t('secPermissionsHint')}>
          <dl className="mono grid grid-cols-[130px_1fr] gap-x-4 gap-y-2 text-[11.5px]">
            {(
              [
                ['activeTab', t('permActiveTab')],
                ['scripting', t('permScripting')],
                ['downloads', t('permDownloads')],
                ['downloads.open', t('permDownloadsOpen')],
                ['storage', t('permStorage')],
                ['offscreen', t('permOffscreen')],
                ['notifications', t('permNotifications')],
                ['sidePanel', t('permSidePanel')],
                [t('permOptionalName'), t('permOptional')],
              ] as const
            ).map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-neon/90">{k}</dt>
                <dd className="font-sans text-[12px] text-muted">{v}</dd>
              </div>
            ))}
          </dl>
        </Section>

        <Section title={t('secData')}>
          <div className="flex flex-wrap gap-3">
            <Button
              variant="secondary"
              icon={<Eraser size={13} aria-hidden="true" />}
              onClick={async () => {
                await send('clear-history', {});
                flash('acid', t('historyCleared'));
              }}
            >
              {t('clearHistory')}
            </Button>
            <Button
              variant="danger"
              icon={<RotateCcw size={13} aria-hidden="true" />}
              onClick={async () => {
                await reset();
                flash('acid', t('settingsReset'));
              }}
            >
              {t('resetSettings')}
            </Button>
          </div>
          <p className="text-[12px] text-muted">{t('privacyNote')}</p>
        </Section>

        <Section title={t('secLimits')}>
          <p className="text-[12px] leading-relaxed text-muted">{t('limitsText')}</p>
        </Section>
      </div>
    </div>
  );
}
