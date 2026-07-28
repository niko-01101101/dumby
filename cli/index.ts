// The all-in-one entry point: AI (Manager.start() cascade), the Reminder
// scheduler, and the blessed dashboard UI all in one process — unchanged
// behavior from before the daemon/dashboard split (see cli/daemon.ts and
// cli/dashboard.ts), kept for local/dev use where running everything
// together in one terminal is simpler than two processes.
import { startApp } from './app.ts';

await startApp({ viewOnly: false });
