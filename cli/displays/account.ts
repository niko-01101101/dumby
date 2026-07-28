import { Account } from "#core/account";
import { Video } from "#core/video";
import { randomID } from "#core/db";
import blessed from 'blessed';
import { entityDisplay, refreshListItems } from "./entityDisplay.ts";
import { videoDisplay } from "./video.ts";
import { archiveDisplay } from "./archive.ts";

export function accountDisplay(account: Account, opts?: { back?: () => void; onDelete?: () => void }) {
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
        videoDisplay(video, {
          back: show,
          onDelete: () => { account.removeVideoFromList(video); show(); },
        });
      });

      return {
        onChange: () => {
          refreshListItems(videoList, account.videos.map((v) => v?.toString() ?? ""));
        },
      };
    },
    extraActions: (a, { pause, show }) => [
      ...(a.platform === "youtube" ? [{
        label: a.isConnected ? "Reconnect YouTube" : "Connect YouTube",
        // Fire-and-forget, same as startShutdownAction — EntityAction.run
        // isn't awaited by the caller, so a rejection has to be caught here
        // or it becomes an unhandled rejection instead of a clean log line.
        run: () => { account.connectYouTube().then((m) => console.log(m)).catch((e: unknown) => console.error(`Connect YouTube failed: ${e instanceof Error ? e.message : String(e)}`)); },
      }] : []),
      {
        label: "Add Video",
        run: async () => {
          const newVideo = await Video.load(randomID());
          if (!newVideo) throw new Error(`Failed to create new Video`);
          account.addVideo(newVideo);
        }
      }, {
        label: "Archive: Videos",
        run: () => {
          pause();
          archiveDisplay("Videos", () => account.loadDeletedVideos(), {
            back: show,
            onRestore: (video) => { void account.addVideo(video); },
          });
        }
      }, {
        label: "Delete",
        run: async () => {
          await account.delete();
          pause();
          opts?.onDelete ? opts.onDelete() : opts?.back?.();
        }
      }]
  });
}
