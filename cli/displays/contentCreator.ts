import { ContentCreator } from "#core/contentCreator";
import { Editor } from "#core/editor";
import { randomID } from "#core/db";
import blessed from 'blessed';
import { entityDisplay } from "./entityDisplay.ts";
import { editorDisplay } from "./editor.ts";

export function contentCreatorDisplay(contentCreator: ContentCreator, opts?: { back?: () => void }) {
  return entityDisplay(contentCreator, {
    label: "Content Creator Display",
    detail: (cc) => cc.toDetailString(),
    back: opts?.back,
    extend: ({ display, pause, show, registerFocusable }) => {
      const editorList = blessed.list({
        parent: display,
        bottom: 0,
        left: 0,
        width: "66%",
        height: "50%",
        keys: true,
        tags: true,
        vi: true,
        mouse: true,
        border: { type: 'bg' },
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
        },
      };
    },
    extraActions: [{
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
