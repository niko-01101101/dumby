import { Video } from "#core/video";
import { entityDisplay } from "./entityDisplay.ts";

export function videoDisplay(video: Video, opts?: { back?: () => void }) {
  return entityDisplay(video, {
    label: "Video Display",
    detail: (v) => v.toDetailString(),
    back: opts?.back,
    extraActions: () => [{
      label: "Delete",
      run: async () => await video.delete()
    }]
  });
}
