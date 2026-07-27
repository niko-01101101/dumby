import blessed from 'blessed';
import type { Widgets } from 'blessed';
import { screen, showList, setCurrentBack } from "../index.ts";

export interface DisplayableEntity {
  on(evt: "change", fn: () => void): () => void;
}

export interface StartShutdownEntity {
  readonly state: string;
  start(): Promise<void>;
  shutdown(): Promise<void>;
}

export function startShutdownAction(entity: StartShutdownEntity): EntityAction {
  // start()/shutdown() are fired here without being awaited by the caller
  // (a blessed list "select" handler can't usefully await anyway), so a
  // rejection has nowhere to land unless caught here — otherwise a failure
  // (e.g. start() setting state to "offline" and rethrowing) becomes an
  // unhandled rejection that dumps a raw stack trace into the log box
  // instead of a clean message, even though the entity already reflects the
  // failure fine via its own state.
  return entity.state === "online"
    ? { label: 'Shutdown', run: () => { entity.shutdown().catch((e: unknown) => console.error(`Shutdown failed: ${e instanceof Error ? e.message : String(e)}`)); } }
    : { label: 'Start', run: () => { entity.start().catch((e: unknown) => console.error(`Start failed: ${e instanceof Error ? e.message : String(e)}`)); } };
}

export interface EntityDisplayExtension {
  onChange?: () => void;
}

export interface EntityDisplayCtx {
  display: Widgets.BoxElement;
  pause: () => void;
  show: () => void;
  registerFocusable: (el: Widgets.BlessedElement) => void;
}

export interface EditableField<E extends DisplayableEntity> {
  label: string;
  getValue: (entity: E) => string;
  setValue: (entity: E, value: string) => Promise<void> | void;
}

export interface ExtraActionsCtx {
  pause: () => void;
  show: () => void;
}

export interface EntityDisplayOptions<E extends DisplayableEntity> {
  label: string;
  detail: (entity: E) => string;
  extend?: (ctx: EntityDisplayCtx) => EntityDisplayExtension | void;
  extraActions?: (entity: E, ctx: ExtraActionsCtx) => EntityAction[];
  fields?: EditableField<E>[];
  back?: (() => void) | undefined;
}

export interface EntityAction {
  label: string;
  run: () => void;
}

// blessed's List.setItems() always calls select(0) internally, then tries to
// re-find the previously selected item by exact text match. Since our items
// are entity.toString()s that change on every "change" event, that match
// often fails and blessed re-derives scroll position from the selected
// index instead of preserving it - so a list a user has scrolled through
// snaps back around every time anything notifies "change" elsewhere.
// Save/restore childBase (blessed's scroll offset) around the call to stop it.
export function refreshListItems(list: Widgets.ListElement, items: string[]) {
  const childBase = list.childBase;
  list.setItems(items);
  list.childBase = Math.min(childBase, Math.max(0, items.length - 1));
}

export interface EntityDisplayHandle {
  display: Widgets.BoxElement;
  show: () => void;
}

export function entityDisplay<E extends DisplayableEntity>(entity: E, options: EntityDisplayOptions<E>): EntityDisplayHandle {
  const display = blessed.box({
    parent: screen,
    width: '100%',
    height: '100%-8',
    tags: true,
    border: { type: 'bg' },
    hidden: true,
  });
  display.setLabel(options.label);

  function pause() {
    display.hide();
    unsubscribe();
  }

  function goBack() {
    pause();
    (options.back ?? showList)();
  }

  function buildActions(): EntityAction[] {
    return [
      { label: 'Back', run: goBack },
      ...(options.extraActions?.(entity, { pause, show: () => show() }) ?? [])];
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

  const fields = options.fields ?? [];

  const data = blessed.box({
    parent: display,
    top: 0,
    right: 0,
    width: '33%',
    height: fields.length ? '50%' : '50%-1 ',
    tags: true,
    border: { type: 'line' },
  });

  const focusables: Widgets.BlessedElement[] = [];

  function addFocusable(el: Widgets.BlessedElement) {
    focusables.push(el);
    // Only list-style elements have a "selected" row style to toggle on
    // focus/blur — a Log (e.g. the Brain box) has no such concept, so this
    // just no-ops for those and relies on the border for focus indication.
    const style = el.style as { selected?: { bg?: unknown } };
    if (style.selected) {
      style.selected.bg = undefined;
      el.on('focus', () => { style.selected!.bg = 'blue'; screen.render(); });
      el.on('blur', () => { style.selected!.bg = undefined; screen.render(); });
    }
  }

  addFocusable(actionList);

  let refreshFields = () => { };

  if (fields.length) {
    const fieldsList = blessed.list({
      parent: display,
      bottom: 0,
      right: 0,
      width: '33%',
      height: '50%-1',
      keys: true,
      vi: true,
      mouse: true,
      tags: true,
      border: { type: 'line' },
      style: { selected: { bg: 'blue' } },
    });
    fieldsList.setLabel('Fields');

    refreshFields = () => {
      refreshListItems(fieldsList, fields.map((f) => `${f.label}: ${f.getValue(entity)}`));
    };
    refreshFields();
    addFocusable(fieldsList);

    fieldsList.on('select', (_item, index) => {
      const field = fields[index];
      if (!field) return;

      const prompt = blessed.prompt({
        parent: screen,
        top: 'center',
        left: 'center',
        width: '50%',
        height: 7,
        tags: true,
        border: { type: 'line' },
      });
      prompt.setLabel(field.label);

      prompt.input(field.label, field.getValue(entity), (err, value) => {
        prompt.destroy();
        fieldsList.focus();
        screen.render();
        if (err || value === undefined) return;
        Promise.resolve(field.setValue(entity, value)).catch((e: unknown) => {
          console.error(`Failed to set ${field.label}: ${e instanceof Error ? e.message : String(e)}`);
        });
      });
    });
  }

  const extension = options.extend?.({
    display,
    pause,
    show: () => show(),
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

  let stopListening = () => { };

  function subscribe() {
    stopListening = entity.on("change", () => {
      data.setContent(options.detail(entity));
      refreshFields();
      actions = buildActions();
      refreshListItems(actionList, actions.map((a) => a.label));
      extension?.onChange?.();
      screen.render();
    });
    screen.key(['tab'], focusNext);
    screen.key(['S-tab'], focusPrevious);
  }

  function unsubscribe() {
    stopListening();
    screen.unkey('tab', focusNext);
    screen.unkey('S-tab', focusPrevious);
  }

  function show() {
    subscribe();
    display.show();
    setCurrentBack(goBack);
    actionList.focus();
    screen.render();
  }

  show();
  return { display, show };
}
