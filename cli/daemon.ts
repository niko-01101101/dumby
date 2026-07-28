import { Manager } from '#core/manager';
import { startScheduler } from '#core/scheduler';

const loaded = await Manager.load("main");
if (!loaded) {
  console.error('Failed to load Manager("main") — exiting.');
  process.exit(1);
}
const manager: Manager = loaded;

const stopScheduler = startScheduler();
console.log(`Manager(${manager.id}) daemon running.`);

const REFRESH_INTERVAL_MS = 30_000;
const refreshTimer = setInterval(() => {
  manager.refreshTree().catch((e: unknown) => console.error(`Manager(${manager.id}) refresh failed: ${e instanceof Error ? e.message : String(e)}`));
}, REFRESH_INTERVAL_MS);

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}, shutting down...`);
  clearInterval(refreshTimer);
  stopScheduler();
  await manager.shutdown();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
});
process.on('unhandledRejection', (reason) => {
  console.error(reason instanceof Error ? reason.stack ?? reason.message : String(reason));
});
