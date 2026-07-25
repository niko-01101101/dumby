import type { Pool, RowDataPacket } from "mysql2/promise";
import { getPool, Object } from "./db.ts";

export type ContentCreatorState = "online" | "offline" | "stuck";
interface ContentCreatorData {
  id: string;
  managerID?: string;
  state: ContentCreatorState;
  updatedAt: Date;
  createdAt: Date;
}

export class ContentCreator extends Object<ContentCreatorData> {
  private pool: Pool;
  private data: ContentCreatorData = {} as ContentCreatorData;

  private _manager: any;
  get manager() { return _manager }

  async manager(m: Manager) {
    this._manager = m;
    this.data.managerID = m.id;
    this.set("managerID", m.id);
  }

  get id() { return this.data.id }
  get updatedAt() { return this.data.updatedAt }
  get createdAt() { return this.data.createdAt }

  get state() { return this.data.state }
  set state(s: ContentCreatorState) { this.data.state = s; this.set("state", s) }

  static async load(id: string): Promise<ContentCreator> {
    try {
      const cc = new ContentCreator(id);
      const exists = await cc.fetch();
      if (!exists) await cc.create();
      return cc;
    } catch (e: any) {
      throw new Error("Failed to initalize ContentCreator", { cause: e });
    }
  }

  private async fetch() {
    try {
      const [rows] = await this.pool.query<RowDataPacket[]>("SELECT * FROM contentCreators WHERE id = ? LIMIT 1", [this.id]);
      const exists = rows.length !== 0;
      if (exists) this.data = rows[0] as ContentCreatorData;
      return exists;
    } catch (e: any) {
      throw new Error(`Failed to fetch ContentCreator(${this.id})`, { cause: e });
    }
  }

  private async set(column, value) {
    try {
      const result = await this.pool.execute(`UPDATE contentCreators SET ${column} = ? WHERE id = ?`, [value])
      this.data[column] = value;
      console.log(result);
      return result.;
    } catch (e: any) {
      throw new Error(`Failed to set column(${column}) to ${value} on ContentCreator(${this.id})`, { cause: e });
      return false;
    }
  }

  private async create() {
    const result = await this.pool.execute(`INSERT INTO contentCreators (id) VALUES (?)`, [this.id])
    console.log(result);
  }
}

const testCC = await ContentCreator.load("0");
console.log(testCC);
