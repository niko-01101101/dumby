import blessed from 'blessed';
import { Manager } from './manager.ts';

const manager = await Manager.load("main");
await manager?.loadContentCreators();

const entities = manager ? [manager, ...manager.contentCreators].filter((e) => e !== undefined) : [];
let focusedEntity: typeof entities[number] | undefined;

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

const detail = blessed.box({
  parent: screen,
  width: '100%',
  height: '100%',
  tags: true,
  border: { type: 'bg' },
  hidden: true,
});

const backButton = blessed.button({
  parent: detail,
  bottom: 0,
  left: 0,
  width: 10,
  height: 1,
  content: 'Back',
  align: 'center',
  mouse: true,
  style: { bg: 'blue', focus: { bg: 'green' } },
});

function showDetail(entity: typeof entities[number]) {
  focusedEntity = entity;
  detail.setLabel(` ${entity.id} `);
  detail.setContent(`id: ${entity.id}\nstate: ${entity.state}`);
  list.hide();
  detail.show();
  backButton.focus();
  screen.render();
}

function showList() {
  focusedEntity = undefined;
  detail.hide();
  list.show();
  list.focus();
  screen.render();
}

list.on('select', (_item, index) => {
  const entity = entities[index];
  if (!entity) return;
  showDetail(entity);
});

backButton.on('press', showList);

list.focus();
screen.render();

async function quit() {
  screen.destroy();
  console.log('===Shutting Down===');
  await manager?.shutdown();
  process.exit(0);
}

screen.key(['q', 'escape'], () => {
  if (focusedEntity) {
    showList();
    return;
  }
  void quit();
});

screen.key(['C-c'], () => void quit());
