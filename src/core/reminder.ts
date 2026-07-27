import type { RowDataPacket } from "mysql2";
import { Entity, getPool, randomID, type EntityData } from "./db.ts";

export type ReminderTargetType = "manager" | "contentCreator";

interface ReminderData extends EntityData {
  targetType: ReminderTargetType;
  targetID: string;
  wakeAt: string;
  message?: string;
  fired: 0 | 1;
}

// Backs todo.txt #3 (reminder table) / #4 (release schedule) / #5 (sleep
// states) — the generic wake-up mechanism a `sleeping` ContentCreator or an
// idle Manager gets scheduled against. targetType/targetID is a polymorphic
// reference rather than two nullable FKs (see db/init/007_reminders.sql).
export class Reminder extends Entity<ReminderData> {
  static table = "reminders";

  get targetType() { return this.data.targetType }
  get targetID() { return this.data.targetID }
  get wakeAt() { return new Date(this.data.wakeAt) }
  get message() { return this.data.message }
  get fired() { return this.data.fired === 1 }

  async setTargetType(t: ReminderTargetType) { await this.set("targetType", t) }
  async setTargetID(id: string) { await this.set("targetID", id) }
  async setWakeAt(d: Date) { await this.set("wakeAt", d) }
  async setMessage(m: string) { await this.set("message", m) }
  async setFired(f: boolean) { await this.set("fired", f ? 1 : 0) }

  static async schedule(targetType: ReminderTargetType, targetID: string, wakeAt: Date, message?: string): Promise<Reminder> {
    const reminder = await Reminder.load(randomID());
    if (!reminder) throw new Error("Failed to create Reminder");
    await reminder.setTargetType(targetType);
    await reminder.setTargetID(targetID);
    await reminder.setWakeAt(wakeAt);
    if (message) await reminder.setMessage(message);
    return reminder;
  }

  // Used before scheduling a startup/recurring reminder to avoid piling up
  // duplicates — e.g. Manager.onLoad() runs once per process, but a process
  // that gets restarted repeatedly without the scheduler ever getting to
  // consume the previous reminder would otherwise leave one unfired row per
  // restart.
  static async hasPending(targetType: ReminderTargetType, targetID: string): Promise<boolean> {
    const [rows] = await getPool().query<RowDataPacket[]>(
      `SELECT id FROM ${Reminder.table} WHERE targetType = ? AND targetID = ? AND fired = 0 AND deletedAt IS NULL LIMIT 1`,
      [targetType, targetID],
    );
    return rows.length > 0;
  }

  // Polled by the scheduler in src/core/scheduler.ts — every unfired,
  // non-deleted reminder whose wakeAt has passed.
  static async loadDue(): Promise<Reminder[]> {
    const [rows] = await getPool().query<RowDataPacket[]>(
      `SELECT id FROM ${Reminder.table} WHERE fired = 0 AND deletedAt IS NULL AND wakeAt <= NOW()`,
    );
    const loaded = await Promise.all(rows.map((r) => Reminder.load(r.id as string)));
    return loaded.filter((r): r is Reminder => r !== undefined);
  }

  async onLoad() { }

  toString() {
    return `${"Reminder".padEnd(12)} ${this.id.padEnd(8)} [${this.targetType}:${this.targetID}] @ ${this.wakeAt.toLocaleString()}${this.fired ? " (fired)" : ""}`;
  }
}
