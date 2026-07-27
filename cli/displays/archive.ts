import blessed from 'blessed';
import { screen, setCurrentBack } from "../index.ts";
import { refreshListItems } from "./entityDisplay.ts";

export interface ArchivedEntity {
  id: string;
  toString(): string;
  deletedAt: Date | undefined;
  restore(): Promise<boolean>;
}

// Generic archive view for todo.txt #11 — any entity whose soft-deletes are
// otherwise invisible (loadX() always filters deletedAt IS NULL, see
// db.ts/CLAUDE.md) can be listed here and restored. `onRestore` is how the
// caller gets a restored entity back into its live in-memory list/UI, mirror
// of how removeXFromList() takes one out on delete.
export function archiveDisplay<E extends ArchivedEntity>(
  title: string,
  loadDeleted: () => Promise<E[]>,
  opts: { back: () => void; onRestore: (entity: E) => void },
) {
  const display = blessed.box({
    parent: screen,
    width: '100%',
    height: '100%-8',
    tags: true,
    border: { type: 'bg' },
  });
  display.setLabel(` ${title} — Archive `);

  const list = blessed.list({
    parent: display,
    top: 0,
    left: 0,
    width: '100%',
    height: '100%-2',
    keys: true,
    vi: true,
    mouse: true,
    tags: true,
    border: { type: 'bg' },
    style: { selected: { bg: 'blue' } },
  });
  list.focus();

  blessed.box({
    parent: display,
    bottom: 0,
    left: 0,
    width: '100%',
    height: 2,
    tags: true,
    content: '{gray-fg}Enter: restore   q/Escape: back{/gray-fg}',
  });

  let items: E[] = [];

  async function refresh() {
    items = await loadDeleted();
    refreshListItems(list, items.length
      ? items.map((e) => `${e.toString()}  {gray-fg}(deleted ${e.deletedAt?.toLocaleString() ?? "unknown"}){/gray-fg}`)
      : ['(nothing archived)']);
    screen.render();
  }

  list.on('select', (_item, index) => {
    const entity = items[index];
    if (!entity) return;
    entity.restore()
      .then(async () => {
        opts.onRestore(entity);
        await refresh();
      })
      .catch((e: unknown) => console.error(`Restore failed: ${e instanceof Error ? e.message : String(e)}`));
  });

  function close() {
    display.destroy();
    opts.back();
  }

  // 'q'/Escape are handled globally in index.ts, which dispatches to
  // whatever setCurrentBack() last registered — no separate binding needed
  // here (adding one would double-fire close() since both would run).
  setCurrentBack(close);

  void refresh();
  screen.render();
}
