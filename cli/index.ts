import blessed from 'blessed';
import { Manager } from '#core/manager';
import { ContentCreator } from '#core/contentCreator';
import { Editor } from '#core/editor';
import { Account } from '#core/account';
import { Video } from '#core/video';
import { refreshListItems } from './displays/entityDisplay.ts';
import { managerDisplay } from './displays/manager.ts';
import { contentCreatorDisplay } from './displays/contentCreator.ts';
import { editorDisplay } from './displays/editor.ts';
import { accountDisplay } from './displays/account.ts';
import { videoDisplay } from './displays/video.ts';

const manager = await Manager.load("main");
await manager?.loadContentCreators();
await manager?.loadEditors();

const contentCreators = manager?.contentCreators ?? [];
const editors = manager?.editors ?? [];
const accounts = contentCreators.flatMap((cc) => cc?.accounts ?? []);
const videos = accounts.flatMap((a) => a?.videos ?? []);

const entities = manager ? [manager, ...contentCreators, ...editors, ...accounts, ...videos].filter((e) => e !== undefined) : [];
let focusedEntity: typeof entities[number] | undefined;

export const screen = blessed.screen({
  smartCSR: true,
  title: 'dumby',
});

const list = blessed.list({
  parent: screen,
  label: ' dumby ',
  width: '100%',
  height: '100%-8',
  keys: true,
  vi: true,
  mouse: true,
  tags: true,
  border: { type: "bg" },
  style: {
    selected: { bg: 'blue' },
  },
});

const logBox = blessed.log({
  parent: screen,
  label: ' log ',
  bottom: 0,
  left: 0,
  width: '100%',
  height: 8,
  tags: true,
  border: { type: 'line' },
  scrollback: 200,
  mouse: true,
  keys: true,
  vi: true,
  scrollbar: {
    ch: ' ',
    style: { bg: 'blue' },
  },
});

const originalLog = console.log.bind(console);
const originalError = console.error.bind(console);
console.log = (...args: unknown[]) => {
  logBox.log(args.map(String).join(' '));
  screen.render();
};
console.error = (...args: unknown[]) => {
  logBox.log(args.map(String).join(' '));
  screen.render();
};

process.on('uncaughtException', (err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
});

process.on('unhandledRejection', (reason) => {
  console.error(reason instanceof Error ? reason.stack ?? reason.message : String(reason));
});

entities.map((e) => e.on("change", () => {
  refreshListItems(list, entities.map((e) => e.toString()));
}));

let currentBack: () => void = showList;

export function setCurrentBack(fn: () => void) {
  currentBack = fn;
}

function openDisplay(entity: typeof entities[number]) {
  focusedEntity = entity;
  list.hide();

  entity instanceof Manager ? managerDisplay(entity) :
    entity instanceof ContentCreator ? contentCreatorDisplay(entity) :
      entity instanceof Editor ? editorDisplay(entity) :
        entity instanceof Account ? accountDisplay(entity) :
          entity instanceof Video ? videoDisplay(entity) :
            undefined;
}

export function showList() {
  focusedEntity = undefined;
  currentBack = showList;
  list.show();
  list.focus();
  screen.render();
}

list.on('select', (_item, index) => {
  const entity = entities[index];
  if (!entity) return;
  openDisplay(entity);
});

list.focus();
screen.render();

async function quit() {
  console.log('===Shutting Down===');
  await manager?.shutdown();
  console.log = originalLog;
  console.error = originalError;
  screen.destroy();
  process.exit(0);
}

screen.key(['q', 'escape'], () => {
  if (focusedEntity) {
    currentBack();
    return;
  }
  void quit();
});

screen.key(['C-c'], () => void quit());
