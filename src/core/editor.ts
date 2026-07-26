import { ContentCreator } from "./contentCreator.js";
import { Entity, type EntityData } from "./db.ts";

export type EditorState = "online" | "starting" | "offline" | "shuttingDown" | "stuck";
interface EditorData extends EntityData {
  contentCreatorID?: string;
  state: EditorState;
}

const stateColor = {
  online: "{green-bg} {/green-bg}",
  starting: "{blue-bg} {/blue-bg}",
  offline: "{black-bg} {/black-bg}",
  shuttingDown: "{red-bg} {/red-bg}",
  stuck: "{yellow-bg} {/yellow-bg}",
}

export class Editor extends Entity<EditorData> {
  static table = "editors";

  contentCreator: ContentCreator | undefined;
  async setContentCreator(cc: any) {
    this.contentCreator = cc;
    await this.set("contentCreatorID", cc.id);
  }

  get state() { return this.data.state }
  async setState(s: EditorState) { this.data.state = s; await this.set("state", s); }

  async onLoad() {
    this.contentCreator = await ContentCreator.load(this.data.contentCreatorID);
  }

  async shutdown() {
    console.log(`ContentCreator(${this.id}) Shutting Down...`);
    await this.setState("shuttingDown");
    await this.setState("offline");
    console.log(`ContentCreator(${this.id}) Offline`);
  }

  async start() {
    if (this.contentCreator && this.contentCreator?.state !== "online") {
      console.log(`ContentCreator(${this.id}) Start Failed : Manager is not Online`);
      return;
    }
    console.log(`ContentCreator(${this.id}) Starting...`);
    await this.setState("starting");
    await this.setState("online");
    console.log(`ContentCreator(${this.id}) Online`);
  }

  toString() { return `${"CCreator".padEnd(12)} ${this.id.padEnd(8)} ${stateColor[this.state]} ${this.state.padEnd(8)}` }
  toDetailString() {
    return `
${"ID".padEnd(5)} ${this.id}
${"State".padEnd(5)} ${stateColor[this.state]} ${this.state.padEnd(11)}
${"UpdatedAt".padEnd(10)} ${this.updatedAt.toLocaleString().padEnd(11)}
${"CreatedAt".padEnd(10)} ${this.createdAt.toLocaleString().padEnd(11)}
`
  }
}
