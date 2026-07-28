import { createPool, type Pool, type RowDataPacket } from "mysql2/promise";

let pool: Pool | undefined;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`[ERROR] Missing required env var: ${name}`);
  return value;
}

export function randomID(): string { return crypto.randomUUID(); }

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

export let entityCache: Map<string, Entity<any>> = new Map();

export interface EntityData {
  id: string;
  updatedAt: string;
  createdAt: string;
  deletedAt: string;
}
export type NonstaticField<T extends EntityData> = Omit<T, "id" | "updatedAt" | "createdAt">;
export type EntityEventType = "change" | "delete";

export abstract class Entity<T extends EntityData> {
  protected get table(): string { return (this.constructor as typeof Entity).table; }
  static table: string;

  protected pool: Pool;
  protected data: T = {} as T;

  private _listeners: { evt: EntityEventType, fn: () => void }[] = [];
  on(evt: EntityEventType, fn: () => void) {
    const nl = { evt, fn };
    this._listeners.push(nl);
    fn();
    return () => this._listeners = this._listeners.filter((l) => l !== nl);
  }

  protected notify(evt: EntityEventType) {
    this._listeners.filter((l) => l.evt === evt).forEach((l) => l.fn());
  }

  get id() { return this.data.id }
  get updatedAt() { return new Date(this.data.updatedAt) }
  get createdAt() { return new Date(this.data.createdAt) }

  abstract toString(): string;
  abstract onLoad(): Promise<void>;

  protected constructor(id: string) {
    this.data.id = id;
    this.pool = getPool();
  }

  static async load<C extends typeof Entity<any>>(this: C, id?: string): Promise<C["prototype"] | undefined> {
    if (!id) return undefined;
    const cacheID = `${id}:${this.table}`;

    const cached = entityCache.get(cacheID);
    if (cached) return cached as C["prototype"];

    try {
      const obj = new (this as any)(id) as C["prototype"];
      entityCache.set(cacheID, obj);

      const exists = await obj.fetch();
      if (!exists) await obj.create();
      await obj.onLoad();
      return obj;
    } catch (e: any) {
      entityCache.delete(cacheID);
      throw new Error("Failed to load Entity", { cause: e });
    }
  }

  // The soft-delete counterpart to every loadX() method's `WHERE deletedAt IS
  // NULL` filter — used to back an archive view (list what got deleted under
  // a given parent) without every entity needing its own hand-written
  // "loadDeletedFoo" query. `column`/`value` scope it to a parent the same
  // way loadX() does (e.g. `ContentCreator.loadDeletedByColumn("managerID",
  // this.id)`).
  static async loadDeletedByColumn<C extends typeof Entity<any>>(this: C, column: string, value: string): Promise<C["prototype"][]> {
    const [rows] = await getPool().query<RowDataPacket[]>(
      `SELECT id FROM ${this.table} WHERE ${column} = ? AND deletedAt IS NOT NULL`,
      [value],
    );
    const loaded = await Promise.all(rows.map((r) => (this as any).load(r.id as string)));
    return loaded.filter((e): e is C["prototype"] => e !== undefined);
  }

  async set(column: keyof NonstaticField<T>, value: any): Promise<boolean> {
    try {
      await this.pool.execute(`UPDATE ${this.table} SET ${String(column)} = ? WHERE id = ?`, [value, this.id]);
      this.data[column] = value;
      this.notify("change");
      return true;
    } catch (e: any) {
      throw new Error(`Failed to set column(${String(column)}) to ${value} on Entity(${this.table}, ${this.id})`, { cause: e });
    }
  }

  // Re-reads this row from the DB and notifies listeners — unlike fetch(),
  // which a fresh load() uses to populate a brand-new instance silently, this
  // is for an already-loaded instance picking up changes made by a *different*
  // process (e.g. a dashboard process polling state a headless daemon process
  // is mutating — see cli/app.ts). Entity.on("change", ...) is in-process
  // only, so a second process has no other way to find out.
  async refresh(): Promise<boolean> {
    const exists = await this.fetch();
    this.notify("change");
    return exists;
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
    await this.fetch();
    return true;
  }

  async delete(): Promise<boolean> {
    try {
      await this.pool.execute(`UPDATE ${this.table} SET deletedAt = NOW() WHERE id = ?`, [this.id]);
      this.data.deletedAt = new Date().toISOString();
      const cacheID = `${this.id}:${this.table}`;
      entityCache.delete(cacheID);
      this.notify("delete");
      return true;
    } catch (e: any) {
      throw new Error(`Failed to delete Entity(${this.table}, ${this.id})`, { cause: e });
    }
  }

  get deletedAt(): Date | undefined { return this.data.deletedAt ? new Date(this.data.deletedAt) : undefined; }
  get isDeleted(): boolean { return this.deletedAt !== undefined; }

  async restore(): Promise<boolean> {
    try {
      await this.pool.execute(`UPDATE ${this.table} SET deletedAt = NULL WHERE id = ?`, [this.id]);
      this.data.deletedAt = undefined as unknown as T["deletedAt"];
      this.notify("change");
      return true;
    } catch (e: any) {
      throw new Error(`Failed to restore Entity(${this.table}, ${this.id})`, { cause: e });
    }
  }
}
