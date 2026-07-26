import { Editor } from "#core/editor";
import { Video } from "#core/video";
import { randomID } from "#core/db";
import blessed from 'blessed';
import { entityDisplay } from "./entityDisplay.ts";
import { videoDisplay } from "./video.ts";

export function editorDisplay(editor: Editor, opts?: { back?: () => void }) {
  return entityDisplay(editor, {
    label: "Editor Display",
    detail: (e) => e.toDetailString(),
    back: opts?.back,
    extend: ({ display, pause, show, registerFocusable }) => {
      const videoList = blessed.list({
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
        },
      };
    },
    extraActions: [{
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
