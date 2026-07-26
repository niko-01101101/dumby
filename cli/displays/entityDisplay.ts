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
  return entity.state === "online"
    ? { label: 'Shutdown', run: () => { entity.shutdown(); } }
    : { label: 'Start', run: () => { entity.start(); } };
}

export interface EntityDisplayExtension {
  onChange?: () => void;
}

export interface EntityDisplayCtx {
  display: Widgets.BoxElement;
  pause: () => void;
  show: () => void;
  registerFocusable: (el: Widgets.ListElement) => void;
}

export interface EditableField<E extends DisplayableEntity> {
  label: string;
  getValue: (entity: E) => string;
  setValue: (entity: E, value: string) => Promise<void> | void;
}

export interface EntityDisplayOptions<E extends DisplayableEntity> {
  label: string;
  detail: (entity: E) => string;
  extend?: (ctx: EntityDisplayCtx) => EntityDisplayExtension | void;
  extraActions?: (entity: E) => EntityAction[];
  fields?: EditableField<E>[];
  back?: (() => void) | undefined;
}

export interface EntityAction {
  label: string;
  run: () => void;
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
      ...(options.extraActions?.(entity) ?? [])];
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

  function addFocusable(el: Widgets.ListElement) {
    focusables.push(el);
    el.style.selected.bg = undefined;
    el.on('focus', () => { el.style.selected.bg = 'blue'; screen.render(); });
    el.on('blur', () => { el.style.selected.bg = undefined; screen.render(); });
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
      fieldsList.setItems(fields.map((f) => `${f.label}: ${f.getValue(entity)}`));
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
      actionList.setItems(actions.map((a) => a.label));
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
