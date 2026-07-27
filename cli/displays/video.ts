import { Video } from "#core/video";
import { entityDisplay } from "./entityDisplay.ts";

export function videoDisplay(video: Video, opts?: { back?: () => void; onDelete?: () => void }) {
  return entityDisplay(video, {
    label: "Video Display",
    detail: (v) => v.toDetailString(),
    back: opts?.back,
    extraActions: (_v, { pause }) => [{
      label: "Delete",
      run: async () => {
        await video.delete();
        pause();
        opts?.onDelete ? opts.onDelete() : opts?.back?.();
      }
    }]
  });
}
