import { syncGoogleCalendar } from './googleCalendar';
import { SYNC_INTERVAL_HOURS } from './env';
import { fetchPortalLectures } from './portalClient';

const RUN_ONCE = process.argv.includes('--once') || SYNC_INTERVAL_HOURS === 0;

async function syncOnce() {
  console.info(`[${new Date().toISOString()}] Fetching timetable...`);
  const classTables = await fetchPortalLectures();

  const { inserted, deleted } = await syncGoogleCalendar(classTables);

  console.info(
    `Google Calendar synced (inserted: ${inserted}, removed: ${deleted})`
  );
}

async function run() {
  try {
    await syncOnce();
  } catch (error) {
    console.error('Failed to sync timetable', error);
    if (RUN_ONCE) process.exitCode = 1;
  }

  if (RUN_ONCE) return;

  const interval = SYNC_INTERVAL_HOURS * 60 * 60 * 1000;
  setTimeout(run, interval);
}

run();
