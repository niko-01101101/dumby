import { ContentCreator } from "#core/contentCreator";
import { Account } from "#core/account";
import { randomID } from "#core/db";
import { PLATFORMS, platformLabel } from "#core/platforms";
import blessed from 'blessed';
import { screen } from "../index.ts";
import { entityDisplay, refreshListItems, startShutdownAction } from "./entityDisplay.ts";
import { accountDisplay } from "./account.ts";
import { archiveDisplay } from "./archive.ts";

export function contentCreatorDisplay(contentCreator: ContentCreator, opts?: { back?: () => void; onDelete?: () => void }) {
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

      const accountList = blessed.list({
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

      accountList.setLabel("Accounts");
      registerFocusable(accountList);

      accountList.on('select', (_item, index) => {
        const account = contentCreator.accounts[index];
        if (!account) return;
        pause();
        accountDisplay(account, {
          back: show,
          onDelete: () => { contentCreator.removeAccountFromList(account); show(); },
        });
      });

      return {
        onChange: () => {
          refreshListItems(accountList, contentCreator.accounts.map((a) => a?.toString() ?? ""));
          aiHistory.setContent(contentCreator.history.map((msg) => msg.role === "system" ? `{gray-fg}${msg.content}{/gray-fg}` : msg.content).join("\n"));
        },
      };
    },
    extraActions: (cc, { pause, show }) => [startShutdownAction(cc), {
      label: "Add Account",
      run: () => {
        const platformPicker = blessed.list({
          parent: screen,
          top: 'center',
          left: 'center',
          width: '50%',
          height: PLATFORMS.length + 2,
          keys: true,
          vi: true,
          mouse: true,
          tags: true,
          border: { type: 'line' },
          style: { selected: { bg: 'blue' } },
        });
        platformPicker.setLabel(' Platform ');
        platformPicker.setItems(PLATFORMS.map(platformLabel));
        platformPicker.focus();
        screen.render();

        platformPicker.on('select', (_item, index) => {
          const platform = PLATFORMS[index];
          platformPicker.destroy();
          screen.render();
          if (!platform) return;
          (async () => {
            const newAccount = await Account.load(randomID());
            if (!newAccount) throw new Error(`Failed to create new Account`);
            await newAccount.setPlatform(platform);
            await contentCreator.addAccount(newAccount);
          })().catch((e: unknown) => console.error(`Add Account failed: ${e instanceof Error ? e.message : String(e)}`));
        });

        platformPicker.key(['escape', 'q'], () => {
          platformPicker.destroy();
          screen.render();
        });
      }
    }, {
      label: "Archive: Accounts",
      run: () => {
        pause();
        archiveDisplay("Accounts", () => cc.loadDeletedAccounts(), {
          back: show,
          onRestore: (account) => { void cc.addAccount(account); },
        });
      }
    }, {
      label: "Delete",
      run: async () => {
        await contentCreator.delete();
        pause();
        opts?.onDelete ? opts.onDelete() : opts?.back?.();
      }
    }]
  });
}
