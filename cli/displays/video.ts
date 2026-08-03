import { Video } from "#core/video";
import blessed from 'blessed';
import { entityDisplay } from "./entityDisplay.ts";

export function videoDisplay(video: Video, opts?: { back?: () => void; onDelete?: () => void }) {
  return entityDisplay(video, {
    label: "Video Display",
    detail: (v) => v.toDetailString(),
    back: opts?.back,
    // Read-only view of the ContentCreator's reasoning trail that led to
    // this video's prompt (see Video.promptProcess) — same widget shape as
    // the "Brain" log on contentCreatorDisplay/editorDisplay, but static
    // (this video's process was recorded once, at creation).
    extend: ({ display, registerFocusable }) => {
      const processLog = blessed.log({
        parent: display,
        bottom: 0,
        left: 0,
        width: "66%-1",
        height: "50%-1",
        keys: true,
        mouse: true,
        tags: true,
        vi: true,
        scrollback: 200,
        scrollbar: { ch: ' ', style: { bg: 'blue' } },
        border: { type: 'line', fg: 3 },
      });
      processLog.setLabel("Process");
      registerFocusable(processLog);

      return {
        onChange: () => {
          processLog.setContent(video.promptProcess ?? "(no process recorded for this video)");
        },
      };
    },
    // Manual audience-response entry — stands in for real platform analytics
    // (see the `feedback` field's comment in video.ts) and is what lets a
    // ContentCreator's self-improvement loop react to something other than a
    // blank slate every session.
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
