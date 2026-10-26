import { Eraser, Link2, RefreshCw, Settings, ShieldCheck } from 'lucide-react';
import { useCallback, useMemo, useState, type FormEvent } from 'react';
import { EmptyState } from '@/components/EmptyState';
import { Logo } from '@/components/Logo';
import { QueueItem, type JobAction } from '@/components/QueueItem';
import { Button, IconButton, Notice, TextField, cx } from '@/components/ui';
import { useJobs } from '@/hooks/useJobs';
import { useSettings } from '@/hooks/useSettings';
import { useActiveTabId, useTabMedia } from '@/hooks/useTabMedia';
import { t } from '@/lib/i18n';
import { send } from '@/lib/messaging';
import { popupQueue } from '@/lib/queue';
import { emptyCause, tabOf } from '@/lib/tabs';
import {
  describeError,
  openDownloadedFile,
  originOf,
  quickDownload,
  requestAccess,
  requestAllSites,
  startCapture,
  startRecord,
  startZip,
} from '@/lib/uiActions';
import type { MediaResource } from '@/types/media';
import { ResourceTabs } from './ResourceTabs';

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
  const { settings, update } = useSettings();
  const [busy, setBusy] = useState<string | undefined>();
  const [feedback, setFeedback] = useState<Record<string, Feedback>>({});

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

  const onBulk = useCallback(
    async (list: MediaResource[]) => {
      let queued = 0;
      let failed = 0;
      for (const r of list) {
        const out = await quickDownload(r, settings);
        if (out.ok) queued++;
        else failed++;
      }
      return { queued, failed };
    },
    [settings],
  );

  const onZip = useCallback(
    async (list: MediaResource[]) => {
      const out = await startZip(list, settings);
      return out.ok ? ({ ok: true } as const) : ({ ok: false, error: out.error } as const);
    },
    [settings],
  );

  const onCapture = useCallback(
    async (r: MediaResource, speed: 'fast' | 'realtime') => {
      setBusy(r.id);
      setFb(r.id, undefined);
      try {
        const out = await startCapture(r, settings, speed);
        setFb(r.id, out.ok ? { tone: 'acid', text: t('queuedOk') } : { tone: 'danger', text: out.error });
      } finally {
        setBusy(undefined);
      }
    },
    [settings],
  );

  const onRecord = useCallback(
    async (r: MediaResource) => {
      setBusy(r.id);
      setFb(r.id, undefined);
      try {
        const out = await startRecord(r, settings);
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
  // The hook only sees players that start after it is registered, so a grant made with the hook on offers a reload.
  const [offerReload, setOfferReload] = useState(false);
  const [showAllJobs, setShowAllJobs] = useState(false);
  // A link pasted by hand (a stream address seen elsewhere): added to this tab's scan.
  const [adding, setAdding] = useState(false);
  const [link, setLink] = useState('');
  const [linkNote, setLinkNote] = useState<Feedback | undefined>();
  const onAddLink = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (tabId === undefined || !link.trim()) return;
      setLinkNote(undefined);
      const res = await send('add-url', { tabId, url: link.trim() });
      if (res.ok) {
        setLink('');
        setAdding(false);
      } else setLinkNote({ tone: 'danger', text: describeError(res.error) });
    },
    [tabId, link],
  );
  const onAllowFrames = useCallback(async () => {
    if (!(await requestAllSites())) return;
    if (settings.pageHook) setOfferReload(true);
    await rescan();
  }, [rescan, settings.pageHook]);
  // A player the hook could not watch: ask for its site while this click still counts as the user's gesture, switch
  // the hook on if it was off, wait until it is registered there, then reload so it sees the player start.
  const onFixPlayer = useCallback(
    async (r: MediaResource) => {
      const origin = originOf(r.frameUrl ?? r.pageUrl);
      if (!origin || !(await requestAccess([origin]))) {
        setFb(r.id, { tone: 'danger', text: t('errAccessDenied') });
        return;
      }
      if (!settings.pageHook) await update({ pageHook: true });
      await send('sync-hook', {});
      await chrome.tabs.reload(r.tabId);
      window.close();
    },
    [settings.pageHook, update],
  );
  const onReload = useCallback(async () => {
    if (tabId === undefined) return;
    setOfferReload(false);
    await chrome.tabs.reload(tabId);
    window.close();
  }, [tabId]);

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
  // The headline counts what the extension is for: audio, video and their subtitles. Images and files have their own tabs.
  const mediaOnly = useMemo(
    () => resources.filter((r) => ['video', 'audio', 'subtitles'].includes(tabOf(r))),
    [resources],
  );
  const downloadable = mediaOnly.filter((r) => r.downloadability.status === 'downloadable').length;
  const pageHost = state?.pageUrl ? safeHost(state.pageUrl) : '';
  const errText = pageErrorText(state?.status === 'error' ? state.error : undefined);
  const finished = jobs.filter((j) => ['completed', 'failed', 'cancelled'].includes(j.stage));

  const blocked = state?.notes.blockedFrameOrigins ?? [];
  const blockedHosts = blocked.map(hostOf).join(', ');
  const cause = emptyCause({
    error: Boolean(errText),
    blockedFrames: blocked.length,
    reloadPending: offerReload,
  });
  const queue = popupQueue(jobs);
  const shownJobs = showAllJobs ? jobs : queue.shown;

  return (
    <div className="flex max-h-[600px] min-h-[320px] w-[420px] flex-col">
      <header className="flex items-center gap-2.5 border-b border-white/8 px-3.5 py-2">
        <Logo size={22} />
        <h1 className="mono min-w-0 flex-1 text-[13px] font-bold tracking-[0.04em] text-fg">vdown-helper</h1>
        {/* Quiet while ready; it only speaks up while scanning or when something went wrong. */}
        <span
          role="status"
          aria-live="polite"
          className={cx(
            'mono inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.12em]',
            scanning ? 'text-magenta' : errText ? 'text-danger' : 'text-acid',
          )}
        >
          <span
            className={cx(
              'h-1.5 w-1.5 rounded-full',
              scanning ? 'animate-pulse-dot bg-magenta' : errText ? 'bg-danger' : 'bg-acid',
            )}
          />
          <span className={scanning || errText ? '' : 'sr-only'}>
            {scanning ? t('scanning') : errText ? t('statusError') : t('ready')}
          </span>
        </span>
        <IconButton label={t('settings')} onClick={() => void chrome.runtime.openOptionsPage()}>
          <Settings size={16} aria-hidden="true" />
        </IconButton>
      </header>

      <main className="flex-1 space-y-3 overflow-y-auto px-3.5 py-3">
        <section aria-label={t('currentPage')} className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] text-fg" title={state?.pageTitle}>
              {state?.pageTitle || (scanning ? '…' : t('untitled'))}
            </p>
            <p className="mono truncate text-[10.5px] text-muted">
              <span className="text-neon/80">{pageHost}</span>
              {mediaOnly.length > 0 && <span className="text-acid"> · {t('readyCount', downloadable)}</span>}
            </p>
          </div>
          <IconButton
            label={t('addLink')}
            aria-expanded={adding}
            onClick={() => setAdding((v) => !v)}
            className={adding ? 'text-neon' : ''}
          >
            <Link2 size={15} aria-hidden="true" />
          </IconButton>
          <IconButton
            label={t('rescanPage')}
            onClick={() => void rescan()}
            disabled={scanning || tabId === undefined}
          >
            <RefreshCw size={15} aria-hidden="true" className={scanning ? 'animate-spin' : ''} />
          </IconButton>
        </section>

        {adding && (
          <form className="flex items-end gap-2" onSubmit={(e) => void onAddLink(e)}>
            <div className="min-w-0 flex-1">
              <TextField
                label={t('addLinkLabel')}
                type="url"
                inputMode="url"
                required
                autoFocus
                spellCheck={false}
                placeholder="https://…/master.m3u8"
                value={link}
                onChange={(e) => setLink(e.target.value)}
              />
            </div>
            <Button variant="primary" type="submit" disabled={!link.trim() || scanning}>
              {t('addLinkButton')}
            </Button>
          </form>
        )}
        {linkNote && (
          <Notice tone={linkNote.tone} role="alert">
            {linkNote.text}
          </Notice>
        )}
        {state && state.notes.blobSources > 0 && (
          <Notice tone="magenta">{t('noteBlob', state.notes.blobSources)}</Notice>
        )}
        {/* With media listed, the notices sit above it; with nothing listed, the empty state carries the one fix. */}
        {resources.length > 0 && offerReload && (
          <Notice tone="acid">
            <p>{t('reloadForHook')}</p>
            <div className="mt-2">
              <Button
                variant="primary"
                size="sm"
                onClick={() => void onReload()}
                icon={<RefreshCw size={13} aria-hidden="true" />}
              >
                {t('reloadPage')}
              </Button>
            </div>
          </Notice>
        )}
        {resources.length > 0 && blocked.length > 0 && (
          <Notice tone="neon">
            <p>{t('noteFramesBlocked', blockedHosts)}</p>
            <p className="mt-1 text-[11px] text-muted">{t('allowEmbeddedHint')}</p>
            <div className="mt-2">
              <Button
                variant="primary"
                size="sm"
                onClick={() => void onAllowFrames()}
                icon={<ShieldCheck size={13} aria-hidden="true" />}
              >
                {t('allowEmbedded')}
              </Button>
            </div>
          </Notice>
        )}
        {state && blocked.length === 0 && state.notes.inaccessibleFrames > 0 && (
          <Notice>{t('noteFrames', state.notes.inaccessibleFrames)}</Notice>
        )}

        {resources.length === 0 ? (
          scanning && !errText ? (
            <p className="mono py-6 text-center text-[11px] uppercase tracking-[0.14em] text-muted">
              {t('scanningPage')}
            </p>
          ) : (
            <EmptyState
              cause={cause}
              scanning={scanning}
              onScan={() => void rescan()}
              onAllowFrames={() => void onAllowFrames()}
              onReload={() => void onReload()}
              {...(errText ? { errorText: errText } : {})}
              {...(blockedHosts ? { blockedHosts } : {})}
            />
          )
        ) : (
          <ResourceTabs
            resources={resources}
            settings={settings}
            busy={busy}
            feedback={feedback}
            onDownload={(x) => void onDownload(x)}
            onConfigure={(x) => void onConfigure(x)}
            onGrantAccess={(x) => void onGrantAccess(x)}
            onCapture={(x, speed) => void onCapture(x, speed)}
            onRecord={(x) => void onRecord(x)}
            onFixPlayer={(x) => void onFixPlayer(x)}
            onBulk={onBulk}
            onZip={onZip}
            onMinImage={(px) => void update({ imageMinPx: px })}
          />
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
              {shownJobs.map((j) => (
                <QueueItem key={j.id} job={j} onAction={(id, a) => void onJobAction(id, a)} />
              ))}
            </ul>
            {queue.hidden > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="mt-2 w-full"
                aria-expanded={showAllJobs}
                onClick={() => setShowAllJobs((v) => !v)}
              >
                {showAllJobs ? t('showFewerJobs') : t('showAllJobs', queue.hidden)}
              </Button>
            )}
          </section>
        )}
      </main>
    </div>
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
