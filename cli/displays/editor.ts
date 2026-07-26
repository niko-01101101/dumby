import { Editor } from "#core/editor";
import { Video } from "#core/video";
import { randomID } from "#core/db";
import blessed from 'blessed';
import { entityDisplay, startShutdownAction } from "./entityDisplay.ts";
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
          videoList.setItems(editor.videos.map((v) => v?.toString() ?? ""));
          aiHistory.setContent(editor.history.map((msg) => msg.content).join("\n"));
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
