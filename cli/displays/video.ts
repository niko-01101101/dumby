import { Video } from "#core/video";
import { entityDisplay } from "./entityDisplay.ts";

export function videoDisplay(video: Video, opts?: { back?: () => void; onDelete?: () => void }) {
  return entityDisplay(video, {
    label: "Video Display",
    detail: (v) => v.toDetailString(),
    back: opts?.back,
    // Manual audience-response entry — stands in for real platform analytics
    // (see the `feedback` field's comment in video.ts) and is what lets a
    // ContentCreator's self-improvement loop (todo.txt) react to something
    // other than a blank slate every session.
    fields: [{
      label: "Feedback",
      getValue: (v) => v.feedback ?? "",
      setValue: async (v, value) => { await v.setFeedback(value); },
    }],
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
