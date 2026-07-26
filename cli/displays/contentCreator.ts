import { ContentCreator } from "#core/contentCreator";
import { Editor } from "#core/editor";
import { randomID } from "#core/db";
import blessed from 'blessed';
import { entityDisplay, refreshListItems, startShutdownAction } from "./entityDisplay.ts";
import { editorDisplay } from "./editor.ts";

export function contentCreatorDisplay(contentCreator: ContentCreator, opts?: { back?: () => void }) {
  return entityDisplay(contentCreator, {
    label: "Content Creator Display",
    detail: (cc) => cc.toDetailString(),
    back: opts?.back,
    extend: ({ display, pause, show, registerFocusable }) => {
      const aiHistory = blessed.log({
        parent: display,
        bottom: 0,
        right: 0,
        width: "33%",
        height: "50%-1",
        keys: true,
        mouse: true,
        tags: true,
        vi: true,
        scrollback: 200,
        scrollbar: {
          ch: ' ',
          style: { bg: 'blue' },
        },
        border: { type: 'line', fg: 2 },
      })

      aiHistory.setLabel("Brain");
      registerFocusable(aiHistory);

      // blessed's mouse tracking is a terminal-wide mode, not per-widget —
      // once any element enables it (editorList/actionList etc. all do),
      // the terminal stops doing its own click-drag text selection anywhere
      // on screen, mouse events go to blessed instead. There's no way to
      // exempt just this box, so toggle terminal mouse tracking off/on for
      // the whole screen while the Brain box is focused, so a normal
      // drag-select-and-copy works when the user wants to copy from it.
      let mouseCaptureOff = false;
      aiHistory.key(['c'], () => {
        mouseCaptureOff = !mouseCaptureOff;
        if (mouseCaptureOff) {
          display.screen.program.disableMouse();
          aiHistory.setLabel("Brain (mouse off — drag to select/copy, 'c' to restore)");
        } else {
          display.screen.program.enableMouse();
          aiHistory.setLabel("Brain");
        }
        display.screen.render();
      });

      const editorList = blessed.list({
        parent: display,
        bottom: 0,
        left: 0,
        width: "66%-1",
        height: "50%-1",
        keys: true,
        tags: true,
        vi: true,
        mouse: true,
        border: { type: 'line', fg: 3 },
        style: { selected: { bg: 'blue' } },
      });

      editorList.setLabel("Editors");
      registerFocusable(editorList);

      editorList.on('select', (_item, index) => {
        const editor = contentCreator.editors[index];
        if (!editor) return;
        pause();
        editorDisplay(editor, { back: show });
      });

      return {
        onChange: () => {
          refreshListItems(editorList, contentCreator.editors.map((e) => e?.toString() ?? ""));
          aiHistory.setContent(contentCreator.history.map((msg) => msg.role === "system" ? `{gray-fg}${msg.content}{/gray-fg}` : msg.content).join("\n"));
        },
      };
    },
    extraActions: (cc) => [startShutdownAction(cc), {
      label: "Add Editor",
      run: async () => {
        const newEditor = await Editor.load(randomID());
        if (!newEditor) throw new Error(`Failed to create new Editor`);
        contentCreator.addEditor(newEditor);
      }
    }, {
      label: "Delete",
      run: async () => await contentCreator.delete()
    }]
  });
}
