// Polls for due Reminders (todo.txt #3) and wakes whichever entity each one
// targets — a ContentCreator via a fresh start() (see ContentCreator.start's
// wakeReason param) or a Manager via reviewSystem() (todo #2). This is the
// piece that actually makes "sleeping" (todo #5) and the release schedule
// (todo #4) do something instead of just sitting there — nothing else in the
// process checks reminders on its own.

import { Reminder } from "./reminder.ts";
import { Manager } from "./manager.ts";
import { ContentCreator } from "./contentCreator.ts";

const POLL_INTERVAL_MS = 60_000;

async function wake(reminder: Reminder): Promise<void> {
  await reminder.setFired(true);

  if (reminder.targetType === "manager") {
    const manager = await Manager.load(reminder.targetID);
    if (!manager) return;
    await manager.reviewSystem();
    return;
  }

  const cc = await ContentCreator.load(reminder.targetID);
  if (!cc) return;
  // Already running (woken some other way, or a manual Start beat this
  // reminder to it) — nothing to do.
  if (cc.state === "online" || cc.state === "starting") return;
  await cc.start(reminder.message);
}

async function processDueReminders(): Promise<void> {
  const due = await Reminder.loadDue();
  for (const reminder of due) {
    try {
      await wake(reminder);
    } catch (e: any) {
      console.error(`Reminder(${reminder.id}) wake failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

export function startScheduler(): () => void {
  processDueReminders().catch((e: unknown) => console.error(`Scheduler poll failed: ${e instanceof Error ? e.message : String(e)}`));
  const timer = setInterval(() => {
    processDueReminders().catch((e: unknown) => console.error(`Scheduler poll failed: ${e instanceof Error ? e.message : String(e)}`));
  }, POLL_INTERVAL_MS);
  return () => clearInterval(timer);
}
