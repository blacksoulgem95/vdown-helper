import type { OffscreenCommand } from '@/types/messages';
import { cancelJob, releaseJob, startJob } from './jobs';
import { purgeAll } from './opfs';

// A fresh document means no job is running: anything left in storage is from a previous document.
void purgeAll();

chrome.runtime.onMessage.addListener((raw: unknown, sender) => {
  const cmd = raw as Partial<OffscreenCommand> | null;
  if (!cmd || cmd.channel !== 'vdown-offscreen' || sender.id !== chrome.runtime.id) return false;
  switch (cmd.type) {
    case 'run-job':
      if (cmd.jobId && cmd.request && cmd.plan) startJob(cmd.jobId, cmd.request, cmd.plan);
      break;
    case 'cancel-job':
      if (cmd.jobId) cancelJob(cmd.jobId);
      break;
    case 'release-job':
      if (cmd.jobId) void releaseJob(cmd.jobId);
      break;
  }
  return false;
});
