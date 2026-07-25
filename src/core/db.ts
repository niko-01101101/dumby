import { createPool, type Pool, type RowDataPacket } from "mysql2/promise";

let pool: Pool | undefined;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`[ERROR] Missing required env var: ${name}`);
  return value;
}

export function getPool(): Pool {
  pool ??= createPool({
    host: process.env.MYSQL_HOST ?? "127.0.0.1",
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: requireEnv("MYSQL_USER"),
    password: requireEnv("MYSQL_PASSWORD"),
    database: requireEnv("MYSQL_DATABASE"),
    waitForConnections: true,
    connectionLimit: 10,
  });
  return pool;
}

export interface EntityData {
  id: string;
  updatedAt: string;
  createdAt: string;
}
export type NonstaticField<T extends EntityData> = Omit<T, "id" | "updatedAt" | "createdAt">;

export abstract class Entity<T extends EntityData> {
  abstract table: string;
  protected pool: Pool;
  protected data: T = {} as T;

  get id() { return this.data.id }
  get updatedAt() { return new Date(this.data.updatedAt) }
  get createdAt() { return new Date(this.data.createdAt) }

  abstract onLoad(): Promise<void>;

  protected constructor(id: string) {
    this.data.id = id;
    this.pool = getPool();
  }

  static async load<C extends typeof Entity<any>>(this: C, id?: string): Promise<C["prototype"] | undefined> {
    try {
      if (!id) return undefined;
      const obj = new (this as any)(id) as C["prototype"];
      const exists = await obj.fetch();
      if (!exists) await obj.create();
      obj.onLoad();
      return obj;
    } catch (e: any) {
      throw new Error("Failed to load Entity", { cause: e });
    }
  }

  async set(column: keyof NonstaticField<T>, value: any): Promise<boolean> {
    try {
      await this.pool.execute(`UPDATE ${this.table} SET ${String(column)} = ? WHERE id = ?`, [value, this.id]);
      this.data[column] = value;
      return true;
    } catch (e: any) {
      throw new Error(`Failed to set column(${String(column)}) to ${value} on Entity(${this.table}, ${this.id})`, { cause: e });
    }
  }

  async fetch() {
    try {
      const [rows] = await this.pool.query<RowDataPacket[]>(`SELECT * FROM ${this.table} WHERE id = ? LIMIT 1`, [this.id]);
      const exists = rows.length !== 0;
      if (exists) this.data = rows[0] as T;
      return exists;
    } catch (e: any) {
      throw new Error(`Failed to fetch Entity(${this.table}, ${this.id})`, { cause: e });
    }
  }

  async create(): Promise<boolean> {
    await this.pool.execute(`INSERT INTO ${this.table} (id) VALUES (?)`, [this.id]);
    this.fetch();
    return true;
  }
}
