import { t } from '@/lib/i18n';
import { loadSettings } from '@/lib/settings';
import type { DownloadJob } from '@/types/download';

/** Desktop notifications. Content is the file name only: never URLs. */
export async function notifyJob(job: DownloadJob): Promise<void> {
  const s = await loadSettings();
  const ok = job.stage === 'completed';
  if ((ok && !s.notifyOnComplete) || (!ok && !s.notifyOnError)) return;
  if (job.stage !== 'completed' && job.stage !== 'failed') return;
  try {
    await chrome.notifications.create(`job-${job.id}-${job.attempts}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
      title: ok ? t('notifyDoneTitle') : t('notifyFailTitle'),
      message: ok ? job.request.filename : `${job.request.filename}\n${job.error?.message ?? ''}`.trim(),
    });
  } catch {
    // Notifications may be disabled at the OS level; that is not an error for the download.
  }
}
