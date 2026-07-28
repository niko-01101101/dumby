// A read-only viewer: no Manager autostart cascade, no Reminder scheduler,
// no mutating actions/fields — just the blessed dashboard, polling the DB
// on an interval to reflect whatever a separate headless daemon process
// (cli/daemon.ts) is actually doing. Meant to be run on demand (e.g. over
// SSH) alongside a daemon that's already running as its own long-lived
// process — see cli/app.ts's startApp() for what viewOnly actually changes.
import { startApp } from './app.ts';

await startApp({ viewOnly: true });
