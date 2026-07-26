import blessed from 'blessed';
import type { Widgets } from 'blessed';
import { screen, showList } from "../index.ts";

export interface DisplayableEntity {
  readonly state: string;
  shutdown(): Promise<void>;
  start(): Promise<void>;
  on(evt: "change", fn: () => void): () => void;
}

export interface EntityDisplayExtension {
  onChange?: () => void;
}

export interface EntityDisplayCtx {
  display: Widgets.BoxElement;
  unsubscribe: () => void;
  registerFocusable: (el: Widgets.ListElement) => void;
}

export interface EntityDisplayOptions<E extends DisplayableEntity> {
  label: string;
  detail: (entity: E) => string;
  extend?: (ctx: EntityDisplayCtx) => EntityDisplayExtension | void;
  extraActions?: EntityAction[];
}

export interface EntityAction {
  label: string;
  run: () => void;
}
export function entityDisplay<E extends DisplayableEntity>(entity: E, options: EntityDisplayOptions<E>) {
  const display = blessed.box({
    parent: screen,
    width: '100%',
    height: '100%-8',
    tags: true,
    border: { type: 'bg' },
    hidden: true,
  });
  display.setLabel(options.label);

  let unsubscribe = () => { };

  function buildActions(): EntityAction[] {
    return [
      { label: 'Back', run: () => { display.hide(); showList(); unsubscribe(); } },
      entity.state === "online"
        ? { label: 'Shutdown', run: () => { entity.shutdown(); } }
        : { label: 'Start', run: () => { entity.start(); } },
      ...(options.extraActions ?? [])];
  }

  let actions = buildActions();

  const actionList = blessed.list({
    parent: display,
    top: 0,
    left: 0,
    width: "33%",
    height: actions.length + 2,
    keys: true,
    vi: true,
    mouse: true,
    border: { type: 'bg' },
    style: { selected: { bg: 'blue' } },
  });

  actionList.on('select', (_item, index) => {
    actions[index]?.run();
  });

  const data = blessed.box({
    parent: display,
    top: 0,
    right: 0,
    width: '33%',
    height: '100%-1',
    tags: true,
    border: { type: 'line' },
  });

  const focusables: Widgets.BlessedElement[] = [];

  function addFocusable(el: Widgets.ListElement) {
    focusables.push(el);
    el.style.selected.bg = undefined;
    el.on('focus', () => { el.style.selected.bg = 'blue'; screen.render(); });
    el.on('blur', () => { el.style.selected.bg = undefined; screen.render(); });
  }

  addFocusable(actionList);

  const extension = options.extend?.({
    display,
    unsubscribe: () => unsubscribe(),
    registerFocusable: addFocusable,
  });

  function cycleFocus(offset: number) {
    const current = focusables.indexOf(screen.focused);
    const next = focusables[(current + offset + focusables.length) % focusables.length];
    next?.focus();
    screen.render();
  }

  const focusNext = () => cycleFocus(1);
  const focusPrevious = () => cycleFocus(-1);
  screen.key(['tab'], focusNext);
  screen.key(['S-tab'], focusPrevious);

  const stopListening = entity.on("change", () => {
    data.setContent(options.detail(entity));
    actions = buildActions();
    actionList.setItems(actions.map((a) => a.label));
    extension?.onChange?.();
    screen.render();
  });

  unsubscribe = () => {
    stopListening();
    screen.unkey('tab', focusNext);
    screen.unkey('S-tab', focusPrevious);
  };

  display.show();
  actionList.focus();
  screen.render();
  return display;
}
