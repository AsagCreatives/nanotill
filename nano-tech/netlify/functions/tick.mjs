// Runs on a schedule: daily Slack summary, email/Slack retries, daily backup.
import core from '../../lib/core.cjs';
import { blobStore } from '../lib/blobstore.mjs';

export default async () => {
  core.useStore(await blobStore());
  await core.tick();
};
export const config = { schedule: '*/10 * * * *' };
