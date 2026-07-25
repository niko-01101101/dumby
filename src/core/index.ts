import blessed from 'blessed';
import { Manager } from './manager.ts';

const manager = await Manager.load("main");
await manager?.loadContentCreators();

const entities = manager ? [manager, ...manager.contentCreators].filter((e) => e !== undefined) : [];



const screen = blessed.screen({
  smartCSR: true,
  title: 'dumby',
});

const list = blessed.list({
  parent: screen,
  label: ' dumby ',
  width: '100%',
  height: '100%',
  keys: true,
  vi: true,
  mouse: true,
  tags: true,
  border: { type: "bg" },
  style: {
    selected: { bg: 'blue' },
  },
});

list.setItems(entities.map((e) => e.toString()));

list.focus();
screen.render();

screen.key(['q', 'C-c', 'escape'], async () => {
  screen.destroy();
  console.log('===Shutting Down===');
  await manager?.shutdown();
  process.exit(0);
});
