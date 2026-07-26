import { Entity, type EntityData } from "./db.ts";
import { Editor } from "./editor.ts";

export type VideoState = "notStarted" | "workingOn" | "completed" | "posted";
const videoStates: VideoState[] = ["notStarted", "workingOn", "completed", "posted"];

interface VideoData extends EntityData {
  editorID?: string;
  state: VideoState;
}

const stateColor = {
  notStarted: "{black-bg} {/black-bg}",
  workingOn: "{blue-bg} {/blue-bg}",
  completed: "{green-bg} {/green-bg}",
  posted: "{magenta-bg} {/magenta-bg}",
}

export class Video extends Entity<VideoData> {
  static table = "videos";

  editor: Editor | undefined;
  async setEditor(editor: Editor) {
    this.editor = editor;
    await this.set("editorID", editor.id);
  }

  get state() { return this.data.state }
  async setState(s: VideoState) { this.data.state = s; await this.set("state", s) }

  async onLoad() {
    this.editor = await Editor.load(this.data.editorID);
  }

  async start() {
    const next = videoStates[videoStates.indexOf(this.state) + 1];
    if (next) await this.setState(next);
  }

  async shutdown() {
    const prev = videoStates[videoStates.indexOf(this.state) - 1];
    if (prev) await this.setState(prev);
  }

  toString() { return `${"Video".padEnd(12)} ${this.id.padEnd(8)} ${stateColor[this.state]} ${this.state.padEnd(8)}` }
  toDetailString() {
    return `
${"ID".padEnd(5)} ${this.id}
${"State".padEnd(5)} ${stateColor[this.state]} ${this.state.padEnd(11)}
${"UpdatedAt".padEnd(10)} ${this.updatedAt.toLocaleString().padEnd(11)}
${"CreatedAt".padEnd(10)} ${this.createdAt.toLocaleString().padEnd(11)}
`
  }
}
