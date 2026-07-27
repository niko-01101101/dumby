import { Manager } from "#core/manager";
import blessed from 'blessed';
import { entityDisplay, refreshListItems, startShutdownAction } from "./entityDisplay.ts";
import { contentCreatorDisplay } from "./contentCreator.ts";
import { editorDisplay } from "./editor.ts";
import { ContentCreator } from "#core/contentCreator";
import { Editor } from "#core/editor";
import { randomID } from "#core/db";

export function managerDisplay(manager: Manager, opts?: { back?: () => void }) {
  return entityDisplay(manager, {
    label: "Manager Display",
    detail: (m) => m.toDetailString(),
    back: opts?.back,
    extend: ({ display, pause, show, registerFocusable }) => {
      const ccList = blessed.list({
        parent: display,
        bottom: 0,
        left: 0,
        width: "66%-1",
        height: "50%",
        keys: true,
        tags: true,
        vi: true,
        mouse: true,
        border: { type: 'bg' },
        style: { selected: { bg: 'blue' } },
      });

      ccList.setLabel("Content Creators");
      registerFocusable(ccList);

      ccList.on('select', (_item, index) => {
        const cc = manager.contentCreators[index];
        if (!cc) return;
        pause();
        contentCreatorDisplay(cc, { back: show });
      });

      const editorList = blessed.list({
        parent: display,
        bottom: 0,
        right: 0,
        width: "33%",
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
        const editor = manager.editors[index];
        if (!editor) return;
        pause();
        editorDisplay(editor, { back: show });
      });

      return {
        onChange: () => {
          refreshListItems(ccList, manager.contentCreators.map((cc) => cc?.toString() ?? ""));
          refreshListItems(editorList, manager.editors.map((e) => e?.toString() ?? ""));
        },
      };
    },
    extraActions: (m) => [startShutdownAction(m), {
      label: "Add Content Creator",
      run: async () => {
        const newCC = await ContentCreator.load(randomID());
        if (!newCC) throw new Error(`Failed to create new ContentCreator`);
        manager.addContentCreator(newCC);
      }
    }, {
      label: "Add Editor",
      run: async () => {
        const newEditor = await Editor.load(randomID());
        if (!newEditor) throw new Error(`Failed to create new Editor`);
        manager.addEditor(newEditor);
      }
    }]
  });
}
