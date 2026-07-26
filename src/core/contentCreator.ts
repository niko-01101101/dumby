import type { RowDataPacket } from "mysql2";
import { Entity, type EntityData } from "./db.ts";
import { Editor } from "./editor.ts";
import { Manager } from "./manager.ts";
import { Ollama } from "ollama";

type ContentCreatorModel = "laguna-s-2.1" | "laguna-xs-2.1";
type Message = { role: "system" | "user" | "assistant"; content: string };
export type ContentCreatorState = "online" | "starting" | "offline" | "shuttingDown" | "stuck";
interface ContentCreatorData extends EntityData {
  managerID?: string;
  state: ContentCreatorState;
}

const ContentCreatorSystemPrompt = `
YOU ARE AN EXPERIENCED CONTENT CREATOR.
YOUR JOB IS TO CREATE CONTENT AND GET THE MOST AMOUNT OF VIEWS AS POSSIBLE.
DO NOT CREATE ANY TABOO OR RESTRICTED CONTENT.
YOU HAVE THE ABILITY TO RUN COMMANDS TO HELP YOU IN YOUR GOAL.
EXAMPLE. \CREATE VIDEO\

COMMAND DICTONARY
CREATE (VIDEO)
`;

const stateColor = {
  online: "{green-bg} {/green-bg}",
  starting: "{blue-bg} {/blue-bg}",
  offline: "{black-bg} {/black-bg}",
  shuttingDown: "{red-bg} {/red-bg}",
  stuck: "{yellow-bg} {/yellow-bg}",
}

export class ContentCreator extends Entity<ContentCreatorData> {
  static table = "contentCreators";
  private ollama: Ollama = new Ollama();
  private currentStream: { abort: () => void } | null = null;
  private model: ContentCreatorModel = "laguna-s-2.1";
  private history: Message[] = [];

  manager: Manager | undefined;
  async setManager(m: any) {
    this.manager = m;
    await this.set("managerID", m.id);
  }

  editors: (Editor | undefined)[] = [];
  async loadEditors() {
    const [rows] = await this.pool.query<RowDataPacket[]>(`SELECT id FROM ${Editor.table} WHERE contentCreatorID = ? AND deletedAt IS NULL`, [this.id]);
    this.editors = await Promise.all(rows.map(async (e) => await Editor.load(e.id)));
  }

  async addEditor(editor: Editor) {
    await editor.setContentCreator(this);
    this.editors.push(editor);
    this.notify("change");
  }

  get state() { return this.data.state }
  async setState(s: ContentCreatorState) { this.data.state = s; await this.set("state", s); }

  async onLoad() {
    this.manager = await Manager.load(this.data.managerID);
    await this.loadEditors();
  }

  async shutdown() {
    console.log(`ContentCreator(${this.id}) Shutting Down...`);
    await this.setState("shuttingDown");
    await this.setState("offline");
    console.log(`ContentCreator(${this.id}) Offline`);
  }

  async start() {
    console.log(this.manager);
    if (this.manager && this.manager?.state !== "online") {
      console.log(`ContentCreator(${this.id}) Start Failed : Manager is not Online`);
      return;
    }
    console.log(`ContentCreator(${this.id}) Starting...`);
    await this.setState("starting");
    try {
      this.history = [];
      await this.think(ContentCreatorSystemPrompt);
    } catch (e: any) {
      await this.setState("offline");
      throw new Error("`ContentCreator(${this.id}) Start Failed", { cause: e });
    }
    await this.setState("online");
    console.log(`ContentCreator(${this.id}) Online`);
  }

  async think(msg: string) {
    let content: string;

    try {
      this.history.push({ role: "system", content: msg });
      const stream = await this.ollama.chat({
        model: this.model,
        messages: this.history,
        stream: true
      })
      this.currentStream = stream;
      content = "";
    } catch (e: any) {
      throw new Error(`Failed to think`, { cause: e });
    }

    const invokeMatch = content.match(
      /INVOKE:\s*(\w+)\n([\s\S]*?)END_INVOKE/,
    );
  }

  public interrupt(): void {
    if (this.currentStream) {
      this.currentStream.abort();
      this.currentStream = null;
    }
  }

  toString() { return `${"CCreator".padEnd(12)} ${this.id.padEnd(8)} ${stateColor[this.state]} ${this.state.padEnd(8)}` }
  toDetailString() {
    return `
${"ID".padEnd(5)} ${this.id}
${"State".padEnd(5)} ${stateColor[this.state]} ${this.state.padEnd(11)}
${"UpdatedAt".padEnd(10)} ${this.updatedAt.toLocaleString().padEnd(11)}
${"CreatedAt".padEnd(10)} ${this.createdAt.toLocaleString().padEnd(11)}
`
  }
}
