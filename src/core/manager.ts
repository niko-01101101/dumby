import type { RowDataPacket } from "mysql2";
import { ContentCreator } from "./contentCreator.ts";
import { Editor } from "./editor.ts";
import { Entity, randomID, type EntityData } from "./db.ts";
import { Reminder } from "./reminder.ts";

export type ManagerState = "online" | "starting" | "offline" | "shuttingDown" | "stuck";
interface ManagerData extends EntityData {
  state: ManagerState;
  maxAllocatedCreators: number;
  maxAllocatedEditors: number;
  releaseIntervalMinutes: number;
}

// How often reviewSystem() re-runs itself via a self-scheduled Reminder —
// independent of releaseIntervalMinutes, which paces content releases, not
// health checks.
const REVIEW_INTERVAL_MINUTES = 15;

// Set by a read-only dashboard process (cli/dashboard.ts) before it loads the
// Manager, so onLoad() doesn't cascade into starting every ContentCreator/
// Editor a second time in a process that's only meant to be viewing state a
// separate headless daemon process (cli/daemon.ts) already owns and is
// driving. Process-wide by design — a dashboard process should never start
// anything, full stop.
let viewOnly = false;
export function setViewOnly(v: boolean) { viewOnly = v; }

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

  // How often a ContentCreator under this Manager re-wakes itself to look
  // for new content, once its current session winds down and it goes to
  // sleep (see ContentCreator.start()).
  get releaseIntervalMinutes() { return this.data.releaseIntervalMinutes }
  async setReleaseIntervalMinutes(m: number) { await this.set("releaseIntervalMinutes", m) }

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

  // Detaches a just-deleted ContentCreator from the in-memory list so the
  // CLI reflects the deletion immediately, without needing a full
  // loadContentCreators() round-trip. Deleting doesn't clear managerID (it's
  // a soft delete — see Entity.delete()), so this only ever touches the
  // in-memory array, never the DB.
  removeContentCreatorFromList(cc: ContentCreator) {
    this._contentCreators = this._contentCreators.filter((c) => c !== cc);
    this.notify("change");
  }

  async loadDeletedContentCreators(): Promise<ContentCreator[]> {
    return ContentCreator.loadDeletedByColumn("managerID", this.id);
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

  removeEditorFromList(editor: Editor) {
    this._editors = this._editors.filter((e) => e !== editor);
    this.notify("change");
  }

  async loadDeletedEditors(): Promise<Editor[]> {
    return Editor.loadDeletedByColumn("managerID", this.id);
  }

  // Single source of truth for "which Editor should pick up the next video" —
  // used by ContentCreator's CREATE VIDEO so it can hand off the whole
  // find-an-editor-and-assign-it step as one call instead of the caller
  // reaching into `manager.editors` itself. Prefers an Editor that's already
  // online (and not already mid-task, see Editor.busy — "online" alone
  // covers both a freshly-started idle Editor and one still working a
  // previous createVideo() call, and handing work to the latter would
  // clobber its in-progress activeVideo/history); falls back to a sleeping
  // one (see EditorState) — the caller is responsible for waking it
  // (editor.start()) before handing it work.
  findAvailableEditor(): Editor | undefined {
    return this.editors.find((e): e is Editor => e !== undefined && e.state === "online" && !e.busy)
      ?? this.editors.find((e): e is Editor => e !== undefined && e.state === "sleeping");
  }

  // Re-reads this whole tree from the DB (Entity.refresh() on every row,
  // loadX() on every list) and notifies listeners — the counterpart to a
  // fresh onLoad(), for an already-loaded Manager picking up writes made by
  // a *different* process. Two callers: cli/daemon.ts polls this on an
  // interval so edits made from a separate, data-mutation-enabled dashboard
  // process (cli/dashboard.ts — see entityDisplay.ts's blockLifecycleActions)
  // actually take effect on the running daemon (a new Account, an edited
  // Feedback/Release Interval, ...) without needing a restart; cli/app.ts's
  // own dashboard-mode polling calls it too, so both sides use the same
  // walk instead of keeping two copies in sync.
  async refreshTree(): Promise<void> {
    await this.refresh();
    await this.loadContentCreators();
    await this.loadEditors();

    for (const cc of this.contentCreators) {
      if (!cc) continue;
      await cc.refresh();
      await cc.loadAccounts();
      for (const account of cc.accounts) {
        if (!account) continue;
        await account.refresh();
        await account.loadVideos();
        for (const video of account.videos) {
          if (video) await video.refresh();
        }
      }
    }
    for (const editor of this.editors) {
      if (editor) await editor.refresh();
    }
  }

  async onLoad() {
    // Load children before start() fans out to them — start() previously
    // ran concurrently with these loads, so its Promise.all iterated an
    // empty contentCreators/editors array and immediately reported "online"
    // without actually starting anything that existed in the DB.
    await this.loadContentCreators();
    await this.loadEditors();
    if (viewOnly) return;
    // Deliberately NOT awaited: start() cascades into each ContentCreator's
    // full think() session (real LLM calls, up to MAX_THINK_STEPS turns,
    // potentially slow or — if it falls back to a local Ollama that isn't
    // running — indefinitely stalled). cli/index.ts awaits Manager.load(...)
    // before it ever constructs the blessed screen, so awaiting start() here
    // blocked the entire terminal UI from appearing until that whole AI
    // cascade finished (symptom: process sits there printing plain
    // "Starting.../Online" to stdout and never renders). Let it run in the
    // background the same way the original code did, and surface a failure
    // via the log instead of losing it as an unhandled rejection.
    this.start().catch((e: unknown) => console.error(`Manager(${this.id}) start failed: ${e instanceof Error ? e.message : String(e)}`));
    if (!(await Reminder.hasPending("manager", this.id))) {
      await Reminder.schedule("manager", this.id, new Date(), "Initial system review on startup.");
    }
  }

  // The Manager's own periodic check-and-debug pass, woken via Reminder
  // rather than a setInterval, so it survives process restarts the same way
  // ContentCreator's release schedule does. Two jobs:
  //  1. Debug — anything "stuck" or unexpectedly "offline" gets restarted.
  //  2. Allocate — if there's no idle capacity anywhere and there's still
  //     room under maxAllocated*, add one more (see per-entity comments
  //     below for exactly what "no idle capacity" means for each, since
  //     Editor/ContentCreator don't expose the same busy/idle signal).
  async reviewSystem(): Promise<string[]> {
    const notes: string[] = [];
    const restart = async (label: string, entity: ContentCreator | Editor) => {
      notes.push(`${label}(${entity.id}) was ${entity.state} — restarting`);
      try {
        await entity.start();
      } catch (e: any) {
        notes.push(`  restart failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    };

    for (const cc of this.contentCreators) {
      if (cc && (cc.state === "stuck" || cc.state === "offline")) await restart("ContentCreator", cc);
    }
    for (const e of this.editors) {
      if (e && (e.state === "stuck" || e.state === "offline")) await restart("Editor", e);
    }

    // An Editor is only ever provably idle once it's "sleeping" (see
    // EditorState) — a fresh "online" one might just have been assigned a
    // task this instant. Treat zero sleeping editors as "no idle capacity"
    // rather than trying to distinguish busy-online from idle-online.
    const idleEditors = this.editors.filter((e) => e?.state === "sleeping").length;
    if (idleEditors === 0 && this.editors.length < this.maxAllocatedEditors) {
      const editor = await Editor.load(randomID());
      if (editor) {
        await this.addEditor(editor);
        await editor.start();
        notes.push(`Allocated new Editor(${editor.id}) — no idle capacity, ${this.editors.length}/${this.maxAllocatedEditors} allocated`);
      }
    }

    // ContentCreators aren't a work-stealing pool the way Editors are — more
    // of them only helps if every existing one is actively "online" (mid
    // session) rather than "sleeping" (nothing to do right now, more
    // capacity wouldn't change that).
    const busyCreators = this.contentCreators.filter((cc) => cc?.state === "online").length;
    if (busyCreators > 0 && busyCreators === this.contentCreators.length && this.contentCreators.length < this.maxAllocatedCreators) {
      const cc = await ContentCreator.load(randomID());
      if (cc) {
        await this.addContentCreator(cc);
        await cc.start();
        notes.push(`Allocated new ContentCreator(${cc.id}) — all ${busyCreators} existing creators busy, ${this.contentCreators.length}/${this.maxAllocatedCreators} allocated`);
      }
    }

    if (!notes.length) notes.push("Nothing to do — system healthy.");
    for (const note of notes) console.log(`Manager(${this.id}) review: ${note}`);

    await Reminder.schedule("manager", this.id, new Date(Date.now() + REVIEW_INTERVAL_MINUTES * 60_000), "Scheduled system review.");
    return notes;
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
    // Mark online BEFORE cascading to children, not after — every child's
    // own start() refuses to run unless `this.manager?.state === "online"`
    // (see ContentCreator.start()/Editor.start()), so starting them first and
    // flipping this Manager to "online" afterward was a deadlock: children
    // always saw "starting" and immediately bailed out, so nothing under a
    // freshly-loaded Manager ever actually started. This mirrors how
    // ContentCreator/Editor themselves go "starting" -> "online" immediately,
    // then do their real (async) work afterward.
    await this.setState("online");
    console.log(`Manager(${this.id}) Online`);

    await Promise.all([
      ...this.contentCreators.map(async (cc) => { await cc?.start(); }),
      ...this.editors.map(async (e) => { await e?.start(); }),
    ]);
  }

  toString() { return `${"Manager".padEnd(12)} ${this.id.padEnd(8)} ${stateColor[this.state]} ${this.state.padEnd(11)}` }
  toDetailString() {
    return `
${"ID".padEnd(25)} ${this.id} 
${"State".padEnd(25)} ${stateColor[this.state]} ${this.state.padEnd(11)}
${"Max Allocated Creators".padEnd(25)} ${this.maxAllocatedCreators.toString().padEnd(11)}
${"Max Allocated Editors".padEnd(25)} ${this.maxAllocatedEditors.toString().padEnd(11)}
${"Release Interval (min)".padEnd(25)} ${this.releaseIntervalMinutes.toString().padEnd(11)}
${"UpdatedAt".padEnd(25)} ${this.updatedAt.toLocaleString().padEnd(11)}
${"CreatedAt".padEnd(25)} ${this.createdAt.toLocaleString().padEnd(11)}
`
  }
}
