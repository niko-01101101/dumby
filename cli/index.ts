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
import { startScheduler } from '#core/scheduler';

const manager = await Manager.load("main");
// onLoad() already loads contentCreators/editors and starts the Manager —
// see manager.ts.

type AnyEntity = Manager | ContentCreator | Editor | Account | Video;
interface Row { entity: AnyEntity; depth: number }

// Walks the live tree fresh every time — the previous dashboard computed
// `entities` once at startup, so anything added afterward (a new Editor,
// a restored Account, ...) never appeared here even though it worked fine
// everywhere else in the CLI.
function buildRows(): Row[] {
  if (!manager) return [];
  const rows: Row[] = [{ entity: manager, depth: 0 }];
  for (const cc of manager.contentCreators) {
    if (!cc) continue;
    rows.push({ entity: cc, depth: 1 });
    for (const account of cc.accounts) {
      if (!account) continue;
      rows.push({ entity: account, depth: 2 });
      for (const video of account.videos) {
        if (!video) continue;
        rows.push({ entity: video, depth: 3 });
      }
    }
  }
  for (const editor of manager.editors) {
    if (!editor) continue;
    rows.push({ entity: editor, depth: 1 });
  }
  return rows;
}

function summarize(rows: Row[]): string {
  const order = ["Manager", "ContentCreator", "Editor", "Account", "Video"];
  const counts = new Map<string, Map<string, number>>();
  for (const { entity } of rows) {
    const type = entity.constructor.name;
    const state = "state" in entity ? String((entity as { state: unknown }).state) : undefined;
    const byState = counts.get(type) ?? new Map<string, number>();
    counts.set(type, byState);
    const key = state ?? "—";
    byState.set(key, (byState.get(key) ?? 0) + 1);
  }
  return order
    .filter((t) => counts.has(t))
    .map((t) => {
      const byState = counts.get(t)!;
      const total = [...byState.values()].reduce((a, b) => a + b, 0);
      const breakdown = [...byState.entries()].map(([s, n]) => `${s}:${n}`).join(" ");
      return `{bold}${t}{/bold}(${total}) ${breakdown}`;
    })
    .join("   ");
}

let focusedEntity: AnyEntity | undefined;

export const screen = blessed.screen({
  smartCSR: true,
  title: 'dumby',
});

const summaryBox = blessed.box({
  parent: screen,
  label: ' dashboard ',
  top: 0,
  width: '100%',
  height: 3,
  tags: true,
  border: { type: 'line' },
});

const list = blessed.list({
  parent: screen,
  label: ' dumby ',
  top: 3,
  width: '100%',
  height: '100%-11',
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

let rows: Row[] = [];
const subscribed = new Map<AnyEntity, () => void>();
let syncing = false;

// Re-derives the whole tree and keeps `subscribed` in sync with whatever
// entities currently exist in it, so additions/removals at any depth (a new
// Account, a restored Editor, a deleted Video) are picked up automatically —
// not just changes to entities that were already known about. `syncing`
// guards against the re-entrant call each newly-subscribed entity.on(...)
// triggers immediately (see Entity.on in db.ts): that inner call just needs
// to no-op, since the outer pass it's nested inside will finish the job.
function sync() {
  if (syncing) return;
  syncing = true;
  try {
    rows = buildRows();
    const current = new Set(rows.map((r) => r.entity));

    for (const { entity } of rows) {
      if (!subscribed.has(entity)) {
        subscribed.set(entity, entity.on("change", sync));
      }
    }
    for (const [entity, unsubscribe] of subscribed) {
      if (!current.has(entity)) {
        unsubscribe();
        subscribed.delete(entity);
      }
    }

    const indent = (depth: number) => "  ".repeat(depth);
    refreshListItems(list, rows.map((r) => `${indent(r.depth)}${r.entity.toString()}`));
    summaryBox.setContent(rows.length ? summarize(rows) : "{gray-fg}No Manager loaded.{/gray-fg}");
    screen.render();
  } finally {
    syncing = false;
  }
}

sync();

let currentBack: () => void = showList;

export function setCurrentBack(fn: () => void) {
  currentBack = fn;
}

function openDisplay(entity: AnyEntity) {
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
  const entity = rows[index]?.entity;
  if (!entity) return;
  openDisplay(entity);
});

list.focus();
screen.render();

const stopScheduler = startScheduler();

async function quit() {
  console.log('===Shutting Down===');
  stopScheduler();
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
