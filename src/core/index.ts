import * as readline from 'node:readline';
import { stdin as input, stdout as output } from 'node:process';
import { Manager } from './manager.ts';
import type { Entity } from './db.ts';

const manager = await Manager.load("main");
let currentEntity: Entity<any> | undefined;

console.log(manager?.columnsString);
console.log(manager?.rowString);

const rl = readline.createInterface({ input, output });

console.log('Type something and press Enter (type "exit" to quit):');

rl.on('line', (line: string) => {
  const trimmed = line.trim().toLowerCase();

  if (trimmed === 'exit') {
    rl.close();
    return;
  }

  const raw = trimmed.split(" ");
  const command = raw[0];
  const arg0 = raw[1];
  const arg1 = raw[2];

  switch (command) {
    case "use":
      break;
  }
});

rl.on('close', async () => {
  console.log('===Shutting Down===');
  await manager?.shutdown();

  process.exit(0);
});
