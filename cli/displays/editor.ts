import { Editor } from "#core/editor";
import blessed from 'blessed';
import { entityDisplay, startShutdownAction } from "./entityDisplay.ts";

export function editorDisplay(editor: Editor, opts?: { back?: () => void; onDelete?: () => void }) {
  return entityDisplay(editor, {
    label: "Editor Display",
    detail: (e) => e.toDetailString(),
    back: opts?.back,
    extend: ({ display, registerFocusable }) => {
      const aiHistory = blessed.log({
        parent: display,
        bottom: 0,
        left: 0,
        width: "100%",
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

      return {
        onChange: () => {
          aiHistory.setContent(editor.history.map((msg) => msg.role === "system" ? `{gray-fg}${msg.content}{/gray-fg}` : msg.content).join("\n"));
        },
      };
    },
    extraActions: (e, { pause }) => [startShutdownAction(e), {
      label: "Delete",
      run: async () => {
        await editor.delete();
        pause();
        opts?.onDelete ? opts.onDelete() : opts?.back?.();
      }
    }]
  });
}
