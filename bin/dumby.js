#!/usr/bin/env node
// Thin dispatcher so `dumby <subcommand>` works from anywhere (e.g. right
// after `ssh`ing in) once this package is `npm link`ed / installed globally,
// instead of everyone having to remember the full
// `node --env-file=.env cli/whatever.ts` incantation and run it from the
// repo root specifically. Always resolves .env/targets relative to this
// package's own directory, not the caller's cwd, for exactly that reason.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const commands = {
  run: 'cli/index.ts',       // AI + scheduler + dashboard, all in one process (local/dev)
  daemon: 'cli/daemon.ts',   // AI + scheduler, headless — run this under systemd
  dashboard: 'cli/dashboard.ts', // read-only dashboard, polls the DB, starts nothing
  migrate: 'db/migrate.ts',
};

const [, , subcommand = 'run', ...rest] = process.argv;
const target = commands[subcommand];

if (!target) {
  console.error(`Unknown command: ${subcommand}`);
  console.error(`Usage: dumby [${Object.keys(commands).join('|')}]`);
  process.exit(1);
}

const dockerUp = spawn('docker', ['compose', 'up', '-d'], { cwd: root, stdio: 'inherit' });

dockerUp.on('exit', (code) => {
  if (code !== 0) {
    console.error(`docker compose up -d exited with code ${code}`);
    process.exit(code ?? 1);
  }

  setTimeout(runTarget, 1000);
});

function runTarget() {
  const child = spawn(
    process.execPath,
    [`--env-file=${path.join(root, '.env')}`, path.join(root, target), ...rest],
    { cwd: root, stdio: 'inherit' },
  );

  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
}
