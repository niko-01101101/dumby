import { Entity, type EntityData } from "./db.ts";
import { Manager } from "./manager.ts";

export type ContentCreatorState = "online" | "starting" | "offline" | "shuttingDown" | "stuck";
export const contentCreatorStates: ContentCreatorState[] = ["online", "starting", "offline", "shuttingDown", "stuck"];

interface ContentCreatorData extends EntityData {
  managerID?: string;
  state: ContentCreatorState;
}

const stateColor = {
  online: "{green-bg} {/green-bg}",
  starting: "{blue-bg} {/blue-bg}",
  offline: "{black-bg} {/black-bg}",
  shuttingDown: "{red-bg} {/red-bg}",
  stuck: "{yellow-bg} {/yellow-bg}",
}

export class ContentCreator extends Entity<ContentCreatorData> {
  static table = "contentCreators";

  manager: Manager | undefined;
  async setManager(m: any) {
    this.manager = m;
    await this.set("managerID", m.id);
  }

  get state() { return this.data.state }
  async setState(s: ContentCreatorState) { this.data.state = s; await this.set("state", s); }

  async onLoad() {
    this.manager = await Manager.load(this.data.managerID);
  }

  async shutdown() {
    console.log(`ContentCreator(${this.id}) Shutting Down...`);
    await this.setState("shuttingDown");
    await this.setState("offline");
    console.log(`ContentCreator(${this.id}) Offline`);
  }

  async start() {
    console.log(this.manager);
    if (this.manager && this.manager?.state !== "online") {
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
