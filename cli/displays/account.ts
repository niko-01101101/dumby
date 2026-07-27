import { Account } from "#core/account";
import { Video } from "#core/video";
import { randomID } from "#core/db";
import blessed from 'blessed';
import { entityDisplay, refreshListItems } from "./entityDisplay.ts";
import { videoDisplay } from "./video.ts";

export function accountDisplay(account: Account, opts?: { back?: () => void }) {
  return entityDisplay(account, {
    label: "Account Display",
    detail: (a) => a.toDetailString(),
    back: opts?.back,
    extend: ({ display, pause, show, registerFocusable }) => {
      const videoList = blessed.list({
        parent: display,
        bottom: 0,
        left: 0,
        width: "100%",
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
        const video = account.videos[index];
        if (!video) return;
        pause();
        videoDisplay(video, { back: show });
      });

      return {
        onChange: () => {
          refreshListItems(videoList, account.videos.map((v) => v?.toString() ?? ""));
        },
      };
    },
    extraActions: () => [{
      label: "Add Video",
      run: async () => {
        const newVideo = await Video.load(randomID());
        if (!newVideo) throw new Error(`Failed to create new Video`);
        account.addVideo(newVideo);
      }
    }, {
      label: "Delete",
      run: async () => await account.delete()
    }]
  });
}
