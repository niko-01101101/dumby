import { Editor } from "#core/editor";
import { Video } from "#core/video";
import { randomID } from "#core/db";
import blessed from 'blessed';
import { entityDisplay, refreshListItems, startShutdownAction } from "./entityDisplay.ts";
import { videoDisplay } from "./video.ts";

export function editorDisplay(editor: Editor, opts?: { back?: () => void }) {
  return entityDisplay(editor, {
    label: "Editor Display",
    detail: (e) => e.toDetailString(),
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
      // once any element enables it (videoList/actionList etc. all do), the
      // terminal stops doing its own click-drag text selection anywhere on
      // screen, mouse events go to blessed instead. There's no way to exempt
      // just this box, so toggle terminal mouse tracking off/on for the
      // whole screen while the Brain box is focused, so a normal
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

      const videoList = blessed.list({
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

      videoList.setLabel("Videos");
      registerFocusable(videoList);

      videoList.on('select', (_item, index) => {
        const video = editor.videos[index];
        if (!video) return;
        pause();
        videoDisplay(video, { back: show });
      });

      return {
        onChange: () => {
          refreshListItems(videoList, editor.videos.map((v) => v?.toString() ?? ""));
          aiHistory.setContent(editor.history.map((msg) => msg.role === "system" ? `{gray-fg}${msg.content}{/gray-fg}` : msg.content).join("\n"));
        },
      };
    },
    extraActions: (e) => [startShutdownAction(e), {
      label: "Add Video",
      run: async () => {
        const newVideo = await Video.load(randomID());
        if (!newVideo) throw new Error(`Failed to create new Video`);
        editor.addVideo(newVideo);
      }
    }, {
      label: "Delete",
      run: async () => await editor.delete()
    }]
  });
}
