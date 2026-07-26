import { ContentCreator } from "#core/contentCreator";
import { Editor } from "#core/editor";
import { randomID } from "#core/db";
import blessed from 'blessed';
import { entityDisplay, startShutdownAction } from "./entityDisplay.ts";
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
          editorList.setItems(contentCreator.editors.map((e) => e?.toString() ?? ""));
          aiHistory.setContent(contentCreator.history.map((msg) => msg.content).join("\n"));
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
