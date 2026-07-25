import { createPool, type Pool } from "mysql2/promise";

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

export interface ObjectData {
  id: string;
  updatedAt: Date;
  createdAt: Date;
}
type NonstaticField = Omit<ObjectData, "id" | "updatedAt" | "createdAt">;

export abstract class Object<T extends ObjectData> {
  private pool: Pool;
  private data: T = {} as T;

  protected constructor(id: string) {
    this.data.id = id;
    this.pool = getPool();
  }

  static async load(id: string) {
    try {
      const obj = new this(id);
      const exists = await obj.fetch();
      if (!exists) await obj.create();
      return obj;
    } catch (e: any) {
      throw new Error("Failed to load Object", { cause: e });
    }
  }

  abstract fetch(): Promise<boolean>;
  abstract set(column: keyof NonstaticField, value: any): Promise<boolean>;
  abstract create(): Promise<boolean>;
}
