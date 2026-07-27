import type { RowDataPacket } from "mysql2";
import { ContentCreator } from "./contentCreator.ts";
import { Editor } from "./editor.ts";
import { Entity, type EntityData } from "./db.ts";

export type ManagerState = "online" | "starting" | "offline" | "shuttingDown" | "stuck";
interface ManagerData extends EntityData {
  state: ManagerState;
  maxAllocatedCreators: number;
  maxAllocatedEditors: number;
}

const stateColor = {
  online: "{green-bg} {/green-bg}",
  starting: "{blue-bg} {/blue-bg}",
  offline: "{black-bg} {/black-bg}",
  shuttingDown: "{red-bg} {/red-bg}",
  stuck: "{yellow-bg} {/yellow-bg}",
}

export class Manager extends Entity<ManagerData> {
  static table = "managers";

  get state() { return this.data.state }
  async setState(s: ManagerState) { this.data.state = s; await this.set("state", s) }

  get maxAllocatedCreators() { return this.data.maxAllocatedCreators }
  async setMaxAllocatedCreators(a: number) { await this.set("maxAllocatedCreators", a) }

  get maxAllocatedEditors() { return this.data.maxAllocatedEditors }
  async setMaxAllocatedEditors(a: number) { await this.set("maxAllocatedEditors", a) }

  private _contentCreators: (ContentCreator | undefined)[] = [];
  get contentCreators() { return this._contentCreators }
  async loadContentCreators() {
    const [rows] = await this.pool.query<RowDataPacket[]>(`SELECT id FROM ${ContentCreator.table} WHERE managerID = ? AND deletedAt IS NULL`, [this.id]);
    this._contentCreators = await Promise.all(rows.map(async (cc) => await ContentCreator.load(cc.id)));
  }

  async addContentCreator(cc: ContentCreator) {
    await cc.setManager(this);
    this.contentCreators?.push(cc);
    this.notify("change");
  }

  async removeContentCreator(cc: ContentCreator) {
    await (this.contentCreators?.find((_cc) => _cc === cc))?.setManager(undefined);
    this.notify("change");
  }

  private _editors: (Editor | undefined)[] = [];
  get editors() { return this._editors }
  async loadEditors() {
    const [rows] = await this.pool.query<RowDataPacket[]>(`SELECT id FROM ${Editor.table} WHERE managerID = ? AND deletedAt IS NULL`, [this.id]);
    this._editors = await Promise.all(rows.map(async (e) => await Editor.load(e.id)));
  }

  async addEditor(editor: Editor) {
    await editor.setManager(this);
    this.editors.push(editor);
    this.notify("change");
  }

  async onLoad() {
    this.start();
    await this.loadContentCreators();
    await this.loadEditors();
  }

  async shutdown() {
    console.log(`Manager(${this.id}) Shutting Down...`);
    await this.setState("shuttingDown");

    await Promise.all([
      ...this.contentCreators.map(async (cc) => { await cc?.shutdown(); }),
      ...this.editors.map(async (e) => { await e?.shutdown(); }),
    ]);

    await this.setState("offline");
    console.log(`Manager(${this.id}) Offline`);
  }

  async start() {
    console.log(`Manager(${this.id}) Starting...`);
    await this.setState("starting");

    await Promise.all([
      ...this.contentCreators.map(async (cc) => { await cc?.start(); }),
      ...this.editors.map(async (e) => { await e?.start(); }),
    ]);

    await this.setState("online");
    console.log(`Manager(${this.id}) Online`);
  }

  toString() { return `${"Manager".padEnd(12)} ${this.id.padEnd(8)} ${stateColor[this.state]} ${this.state.padEnd(11)}` }
  toDetailString() {
    return `
${"ID".padEnd(25)} ${this.id} 
${"State".padEnd(25)} ${stateColor[this.state]} ${this.state.padEnd(11)}
${"Max Allocated Creators".padEnd(25)} ${this.maxAllocatedCreators.toString().padEnd(11)}
${"Max Allocated Editors".padEnd(25)} ${this.maxAllocatedEditors.toString().padEnd(11)}
${"UpdatedAt".padEnd(25)} ${this.updatedAt.toLocaleString().padEnd(11)}
${"CreatedAt".padEnd(25)} ${this.createdAt.toLocaleString().padEnd(11)}
`
  }
}
