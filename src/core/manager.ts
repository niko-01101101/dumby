import type { RowDataPacket } from "mysql2";
import { ContentCreator } from "./contentCreator.ts";
import { Entity } from "./db.ts";

export type ManagerState = "online" | "offline" | "turningOff" | "stuck";
interface ManagerData {
  id: string;
  state: ManagerState;
  updatedAt: string;
  createdAt: string;
}

export class Manager extends Entity<ManagerData> {
  table = "managers";

  get state() { return this.data.state }
  set state(s: ManagerState) { this.data.state = s; void this.set("state", s) }

  private _contentCreators: (ContentCreator | undefined)[] = [];
  get contentCreators() { return this._contentCreators }
  async loadContentCreators() {
    const [rows] = await this.pool.query<RowDataPacket[]>(`SELECT id FROM ${this.table} WHERE id = ?`, [this.id]);
    this._contentCreators = await Promise.all(rows.map(async (cc) => await ContentCreator.load(cc.id)));
  }

  async addContentCreator(cc: ContentCreator) { await cc.setManager(this); this.contentCreators?.push(cc) }

  async removeContentCreator(cc: ContentCreator) { await (this.contentCreators?.find((_cc) => _cc === cc))?.setManager(undefined) }

  async onLoad() {
    this.state = "online";

    await this.loadContentCreators();
  }

  async shutdown() {
    console.log(`Manager(${this.id}) Turning Off...`);
    this.state = "turningOff";

    await Promise.all(this.contentCreators.map(async (cc) => { await cc?.shutdown(); }));

    this.state = "offline";
    console.log(`Manager(${this.id}) Offline`);
  }

  get columnsString() {
    return `|   id   |   state   |   updatedAt   |   createdAt   |
------------------------------------------------------`}

  get rowString() {
    return `|${this.id.padEnd(8)}|${this.state.padEnd(11)}|${this.updatedAt?.toLocaleDateString().padEnd(15)}|${this.createdAt?.toLocaleDateString().padEnd(15)}|`
  }
}
