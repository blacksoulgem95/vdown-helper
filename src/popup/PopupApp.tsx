import { Eraser, RefreshCw, Settings, ShieldCheck } from 'lucide-react';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { EmptyState } from '@/components/EmptyState';
import { Logo } from '@/components/Logo';
import { MediaCard } from '@/components/MediaCard';
import { QueueItem, type JobAction } from '@/components/QueueItem';
import { Tabs } from '@/components/Tabs';
import { Badge, Button, IconButton, Notice, cx } from '@/components/ui';
import { useJobs } from '@/hooks/useJobs';
import { useSettings } from '@/hooks/useSettings';
import { useActiveTabId, useTabMedia } from '@/hooks/useTabMedia';
import { t } from '@/lib/i18n';
import { send } from '@/lib/messaging';
import { groupResources } from '@/lib/resources';
import { openDownloadedFile, originOf, quickDownload, requestAccess } from '@/lib/uiActions';
import type { MediaResource } from '@/types/media';

type Feedback = { tone: 'danger' | 'acid'; text: string };

function pageErrorText(code: string | undefined): string | undefined {
  switch (code) {
    case undefined:
      return undefined;
    case 'unsupported-page':
      return t('errUnsupportedPage');
    case 'no-access':
      return t('errNoAccess');
    case 'tab-closed':
      return t('errTabClosed');
    default:
      return t('errScanFailed');
  }
}

export function PopupApp() {
  const tabId = useActiveTabId();
  const { state, scanning, rescan } = useTabMedia(tabId);
  const jobs = useJobs();
  const { settings } = useSettings();
  const [busy, setBusy] = useState<string | undefined>();
  const [feedback, setFeedback] = useState<Record<string, Feedback>>({});
  const version = chrome.runtime.getManifest().version;

  const setFb = (id: string, fb: Feedback | undefined) =>
    setFeedback((cur) => {
      const next = { ...cur };
      if (fb) next[id] = fb;
      else delete next[id];
      return next;
    });

  const onDownload = useCallback(
    async (r: MediaResource) => {
      setBusy(r.id);
      setFb(r.id, undefined);
      try {
        const out = await quickDownload(r, settings);
        setFb(r.id, out.ok ? { tone: 'acid', text: t('queuedOk') } : { tone: 'danger', text: out.error });
      } finally {
        setBusy(undefined);
      }
    },
    [settings],
  );

  const onConfigure = useCallback(async (r: MediaResource) => {
    // sidePanel.open() needs the user's click, so it is started first; the selection is read by the panel on load.
    const opening = chrome.sidePanel.open({ tabId: r.tabId });
    await chrome.storage.session.set({
      'studio:selection': { tabId: r.tabId, resourceId: r.id, at: Date.now() },
    });
    try {
      await opening;
      window.close();
    } catch {
      setFb(r.id, { tone: 'danger', text: t('errSidePanel') });
    }
  }, []);

  const onGrantAccess = useCallback(
    async (r: MediaResource) => {
      const origin = originOf(r.url);
      if (origin && (await requestAccess([origin]))) await rescan();
      else setFb(r.id, { tone: 'danger', text: t('errAccessDenied') });
    },
    [rescan],
  );

  const [queueNote, setQueueNote] = useState<string | undefined>();
  const onAllowFrames = useCallback(
    async (origins: string[]) => {
      if (await requestAccess(origins)) await rescan();
    },
    [rescan],
  );

  const onJobAction = useCallback(
    async (id: string, action: JobAction) => {
      setQueueNote(undefined);
      if (action === 'open' || action === 'show') {
        const job = jobs.find((j) => j.id === id);
        const res = job
          ? await openDownloadedFile(job, action)
          : { ok: false as const, error: t('errFileUnavailable') };
        if (!res.ok) setQueueNote(res.error);
        return;
      }
      await send('job-action', { jobId: id, action });
    },
    [jobs],
  );

  const resources = useMemo(() => state?.resources ?? [], [state?.resources]);
  const [tab, setTab] = useState<'media' | 'subtitles'>('media');
  const media = useMemo(() => resources.filter((r) => r.kind !== 'subtitle'), [resources]);
  const subtitles = useMemo(() => resources.filter((r) => r.kind === 'subtitle'), [resources]);
  // The strip only appears when there is something besides media; an empty tab is never the active one.
  const activeTab = subtitles.length === 0 ? 'media' : media.length === 0 ? 'subtitles' : tab;
  const shown = activeTab === 'subtitles' ? subtitles : media;
  const groups = groupResources(shown);
  const downloadable = resources.filter((r) => r.downloadability.status === 'downloadable').length;
  const pageHost = state?.pageUrl ? safeHost(state.pageUrl) : '';
  const errText = pageErrorText(state?.status === 'error' ? state.error : undefined);
  const finished = jobs.filter((j) => ['completed', 'failed', 'cancelled'].includes(j.stage));

  return (
    <div className="flex max-h-[600px] min-h-[320px] w-[420px] flex-col">
      <header className="flex items-center gap-2.5 border-b border-white/8 px-3.5 py-2.5">
        <Logo size={24} />
        <div className="min-w-0 flex-1">
          <h1 className="mono text-[13px] font-bold tracking-[0.04em] text-fg">vdown-helper</h1>
          <p className="label !text-[9px] !tracking-[0.2em]">{t('tagline')}</p>
        </div>
        <span
          role="status"
          aria-live="polite"
          className={cx(
            'mono inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.12em]',
            scanning
              ? 'border-magenta/45 text-magenta'
              : errText
                ? 'border-danger/45 text-danger'
                : 'border-acid/40 text-acid',
          )}
        >
          <span
            className={cx(
              'h-1.5 w-1.5 rounded-full',
              scanning ? 'animate-pulse-dot bg-magenta' : errText ? 'bg-danger' : 'bg-acid',
            )}
          />
          {scanning ? t('scanning') : errText ? t('statusError') : t('ready')}
        </span>
        <IconButton label={t('settings')} onClick={() => void chrome.runtime.openOptionsPage()}>
          <Settings size={16} aria-hidden="true" />
        </IconButton>
        <Badge title={t('version')}>v{version}</Badge>
      </header>

      <main className="flex-1 space-y-3 overflow-y-auto px-3.5 py-3">
        <section aria-label={t('currentPage')} className="glass px-3 py-2.5">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <p className="label">{t('currentPage')}</p>
              <p className="mt-0.5 truncate text-[13px] text-fg" title={state?.pageTitle}>
                {state?.pageTitle || (scanning ? '…' : t('untitled'))}
              </p>
              <p className="mono truncate text-[11px] text-neon/80">{pageHost}</p>
            </div>
            <div className="text-right">
              <p className="label">{t('detected')}</p>
              <p className="mono text-[18px] leading-none text-fg">
                {resources.length}
                {resources.length > 0 && (
                  <span className="ml-1 text-[10px] text-acid">{t('readyCount', downloadable)}</span>
                )}
              </p>
            </div>
          </div>
          <div className="mt-2.5">
            <Button
              variant="secondary"
              onClick={() => void rescan()}
              disabled={scanning || tabId === undefined}
              icon={<RefreshCw size={13} aria-hidden="true" className={scanning ? 'animate-spin' : ''} />}
            >
              {t('rescanPage')}
            </Button>
          </div>
        </section>

        {state && state.notes.blobSources > 0 && (
          <Notice tone="magenta">{t('noteBlob', state.notes.blobSources)}</Notice>
        )}
        {state && (state.notes.blockedFrameOrigins ?? []).length > 0 ? (
          <Notice tone="neon">
            <p>{t('noteFramesBlocked', (state.notes.blockedFrameOrigins ?? []).map(hostOf).join(', '))}</p>
            <p className="mt-1 text-[11px] text-muted">{t('allowEmbeddedHint')}</p>
            <div className="mt-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void onAllowFrames(state.notes.blockedFrameOrigins ?? [])}
                icon={<ShieldCheck size={13} aria-hidden="true" />}
              >
                {t('allowEmbedded')}
              </Button>
            </div>
          </Notice>
        ) : (
          state &&
          state.notes.inaccessibleFrames > 0 && (
            <Notice>{t('noteFrames', state.notes.inaccessibleFrames)}</Notice>
          )
        )}

        {resources.length === 0 ? (
          scanning && !errText ? (
            <p className="mono py-6 text-center text-[11px] uppercase tracking-[0.14em] text-muted">
              {t('scanningPage')}
            </p>
          ) : (
            <EmptyState
              onScan={() => void rescan()}
              scanning={scanning}
              {...(errText ? { errorText: errText } : {})}
            />
          )
        ) : (
          <TabbedList
            show={subtitles.length > 0 && media.length > 0}
            tabs={[
              { key: 'media', label: t('tabMedia'), count: media.length },
              { key: 'subtitles', label: t('tabSubtitles'), count: subtitles.length },
            ]}
            active={activeTab}
            onChange={setTab}
            label={t('detectedMedia')}
          >
            <ul className="space-y-2.5" aria-label={t('detectedMedia')}>
              {groups.map((g) => (
                <li key={g.key} className="list-none">
                  {g.items.length > 1 && (
                    <p className="label mb-1.5 flex items-center justify-between">
                      <span className="truncate">{g.title}</span>
                      <span>{g.items.length}</span>
                    </p>
                  )}
                  <ul className="space-y-2.5">
                    {g.items.map((r) => (
                      <MediaCard
                        key={r.id}
                        resource={r}
                        busy={busy === r.id}
                        {...(feedback[r.id] ? { feedback: feedback[r.id] as Feedback } : {})}
                        onDownload={(x) => void onDownload(x)}
                        onConfigure={(x) => void onConfigure(x)}
                        onGrantAccess={(x) => void onGrantAccess(x)}
                      />
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </TabbedList>
        )}

        {jobs.length > 0 && (
          <section aria-label={t('queue')}>
            <div className="mb-1.5 flex items-center justify-between">
              <h2 className="label">
                {t('queue')} · {jobs.length}
              </h2>
              {finished.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void send('clear-history', {})}
                  icon={<Eraser size={12} aria-hidden="true" />}
                >
                  {t('clearHistory')}
                </Button>
              )}
            </div>
            {queueNote && (
              <div className="mb-2" data-queue-note>
                <Notice tone="danger" role="alert">
                  {queueNote}
                </Notice>
              </div>
            )}
            <ul className="space-y-2.5">
              {jobs.map((j) => (
                <QueueItem key={j.id} job={j} onAction={(id, a) => void onJobAction(id, a)} />
              ))}
            </ul>
          </section>
        )}
      </main>

      <footer className="border-t border-white/8 px-3.5 py-2 text-center">
        <p className="mono text-[9.5px] uppercase tracking-[0.24em] text-muted">{t('signature')}</p>
      </footer>
    </div>
  );
}

/** The tab strip when there is more than one kind of thing to show; otherwise just the list. */
function TabbedList({
  show,
  tabs,
  active,
  onChange,
  label,
  children,
}: {
  show: boolean;
  tabs: Array<{ key: 'media' | 'subtitles'; label: string; count: number }>;
  active: 'media' | 'subtitles';
  onChange: (k: 'media' | 'subtitles') => void;
  label: string;
  children: ReactNode;
}) {
  if (!show) return <>{children}</>;
  return (
    <Tabs tabs={tabs} active={active} onChange={onChange} label={label}>
      {children}
    </Tabs>
  );
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}
