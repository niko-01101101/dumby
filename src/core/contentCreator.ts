import { Entity } from "./db.ts";
import { Manager } from "./manager.ts";

export type ContentCreatorState = "online" | "offline" | "turningOff" | "stuck";
interface ContentCreatorData {
  id: string;
  managerID?: string;
  state: ContentCreatorState;
  updatedAt: string;
  createdAt: string;
}

export class ContentCreator extends Entity<ContentCreatorData> {
  table = "contentCreators";

  private _manager: any
  get manager() { return this._manager }

  async setManager(m: any) {
    this._manager = m;
    await this.set("managerID", m.id);
  }

  get state() { return this.data.state }
  set state(s: ContentCreatorState) { this.data.state = s; void this.set("state", s) }

  async onLoad() {
    this.state = "online";
    this._manager = await Manager.load(this.data.managerID);
  }

  async shutdown() {
    console.log(`ContentCreator(${this.id}) Turning Off...`);
    this.state = "turningOff";
    this.state = "offline";
    console.log(`ContentCreator(${this.id}) Offline`);
  }
}
