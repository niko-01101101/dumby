import { Manager } from "#core/manager";
import blessed from 'blessed';
import { entityDisplay } from "./entityDisplay.ts";
import { contentCreatorDisplay } from "./contentCreator.ts";
import { ContentCreator } from "#core/contentCreator";
import { randomID } from "#core/db";

export function managerDisplay(manager: Manager) {
  return entityDisplay(manager, {
    label: "Manager Display",
    detail: (m) => m.toDetailString(),
    extend: ({ display, unsubscribe, registerFocusable }) => {
      const ccList = blessed.list({
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

      ccList.setLabel("Content Creators");
      registerFocusable(ccList);

      ccList.on('select', (_item, index) => {
        const cc = manager.contentCreators[index];
        if (!cc) return;
        display.hide();
        unsubscribe();
        contentCreatorDisplay(cc);
      });

      return {
        onChange: () => {
          ccList.setItems(manager.contentCreators.map((cc) => cc?.toString() ?? ""));
        },
      };
    },
    extraActions: [{
      label: "Add Content Creator",
      run: async () => {
        const newCC = await ContentCreator.load(randomID());
        if (!newCC) throw new Error(`Failed to create new ContentCreator`);
        manager.addContentCreator(newCC);
      }
    }]
  });
}
