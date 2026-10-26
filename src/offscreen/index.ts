import type { OffscreenCommand } from '@/types/messages';
import { handleIngestPort } from './ingest';
import { cancelJob, releaseJob, startJob, stopJob } from './jobs';
import './startup';

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
    case 'stop-job':
      if (cmd.jobId) stopJob(cmd.jobId);
      break;
    case 'release-job':
      if (cmd.jobId) void releaseJob(cmd.jobId);
      break;
  }
  return false;
});

chrome.runtime.onConnect.addListener(handleIngestPort);
