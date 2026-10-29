import { listen } from '@tauri-apps/api/event';
import { useCallback, useEffect, useState } from 'react';
import { Logo } from '@/components/Logo';
import { QueueItem, type JobAction } from '@/components/QueueItem';
import { Tabs } from '@/components/Tabs';
import { Notice } from '@/components/ui';
import { isActive, isQueued } from '@/lib/queue';
import type { DownloadJob } from '@/types/download';
import { AddPanel } from './AddPanel';
import { BrowserLink } from './BrowserLink';
import { api, asEngineError, type Control, type HistoryEntry, type SettingsView } from './api';
import { errorText } from './errors';
import { HistoryList } from './HistoryList';
import { setLanguage, td } from './i18n';
import { SettingsPanel } from './SettingsPanel';

type Section = 'queue' | 'history' | 'settings';

/** How often the queue is read while the window is visible (progress is not pushed to the window). */
const POLL_MS = 700;

export function App({ initial }: { initial: SettingsView }) {
  const [view, setView] = useState(initial);
  const [section, setSection] = useState<Section>('queue');
  const [jobs, setJobs] = useState<DownloadJob[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      const [j, h] = await Promise.all([api.jobs(), api.history()]);
      setJobs(j);
      setHistory(h);
    } catch (e) {
      setError(errorText(asEngineError(e)));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, POLL_MS);
    const unlisten = listen('queue-changed', () => void refresh());
    return () => {
      window.clearInterval(timer);
      void unlisten.then((stop) => stop());
    };
  }, [refresh]);

  const act = async (id: string, a: JobAction) => {
    if (a === 'open' || a === 'show') return;
    try {
      await api.control(id, a as Control);
      setError(undefined);
    } catch (e) {
      setError(errorText(asEngineError(e)));
    }
  };

  const open = async (path: string, reveal: boolean) => {
    try {
      await api.openFile(path, reveal);
      setError(undefined);
    } catch (e) {
      setError(errorText(asEngineError(e)));
    }
  };

  const saved = (next: SettingsView) => {
    setLanguage(next.language);
    setView(next);
  };

  return (
    <main
      className="mx-auto flex min-h-screen max-w-3xl flex-col gap-4 p-5"
      data-testid="app"
      data-lang={view.language}
    >
      <header className="flex items-center gap-3">
        <Logo />
        <p className="mono text-[11px] uppercase tracking-[0.16em] text-muted">{td('tagline')}</p>
      </header>
      <AddPanel onAdded={() => void refresh()} />
      {error && (
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      )}
      <Tabs<Section>
        label={td('sectionsLabel')}
        active={section}
        onChange={setSection}
        tabs={[
          { key: 'queue', label: td('tabQueue'), count: jobs.length },
          { key: 'history', label: td('tabHistory'), count: history.length },
          { key: 'settings', label: td('tabSettings'), count: 0 },
        ]}
      >
        {section === 'queue' &&
          (jobs.length === 0 ? (
            <p className="py-6 text-center text-[12px] text-muted" data-testid="queue-empty">
              {td('queueEmpty')}
            </p>
          ) : (
            <ul className="space-y-2" data-testid="queue">
              {jobs.map((job) => (
                <QueueItem
                  key={job.id}
                  job={job}
                  onAction={(id, a) => void act(id, a)}
                  pausable={isActive(job) || isQueued(job)}
                />
              ))}
            </ul>
          ))}
        {section === 'history' && (
          <HistoryList
            entries={history}
            enabled={view.settings.history}
            lang={view.language}
            onOpen={(path, reveal) => void open(path, reveal)}
            onClear={() => void api.clearHistory().then(refresh)}
          />
        )}
        {section === 'settings' && (
          <div className="space-y-6">
            <SettingsPanel key={view.language} view={view} onSaved={saved} />
            <BrowserLink key={`link-${view.language}`} />
          </div>
        )}
      </Tabs>
    </main>
  );
}
