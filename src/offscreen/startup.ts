import { purgeAll } from './opfs';

/**
 * A fresh offscreen document clears whatever a previous document left in storage. That must be finished before any job
 * writes, or the purge deletes the new job's files from under it (the background starts jobs the moment the document
 * exists). Everything that touches OPFS awaits this first.
 */
export const storageReady: Promise<void> = purgeAll();
