import type { RowDataPacket } from "mysql2";
import { Entity, randomID, type EntityData } from "./db.ts";
import { Editor } from "./editor.ts";
import { Manager } from "./manager.ts";
import type { Video } from "./video.ts";
import { Ollama } from "ollama";

type ContentCreatorModel = "gemma4:latest";
type Message = { role: "system" | "user" | "assistant"; content: string };
export type ContentCreatorState = "online" | "starting" | "offline" | "shuttingDown" | "stuck";
interface ContentCreatorData extends EntityData {
  managerID?: string;
  state: ContentCreatorState;
}

const MAX_THINK_STEPS = 8;

const ContentCreatorSystemPrompt = `
YOU ARE AN EXPERIENCED CONTENT CREATOR.
YOUR JOB IS TO CREATE CONTENT AND GET THE MOST AMOUNT OF VIEWS AS POSSIBLE.
DO NOT CREATE ANY TABOO OR RESTRICTED CONTENT.
YOU HAVE THE ABILITY TO RUN COMMANDS TO HELP YOU IN YOUR GOAL.
COMMANDS MUST BE FORMATTED EXACTLY LIKE THIS, WITH THE COMMAND NAME ON ITS OWN LINE:
INVOKE: LIST VIDEOS
END_INVOKE

SOME COMMANDS TAKE INPUT ON THE LINES BETWEEN THE COMMAND AND END_INVOKE, FOR EXAMPLE:
INVOKE: CREATE VIDEO
a 30 second video about a cat learning piano
END_INVOKE

RESPOND WITHOUT AN INVOKE BLOCK WHEN YOU HAVE NOTHING FURTHER TO DO RIGHT NOW.

COMMAND DICTONARY
LIST ACCOUNTS - list known accounts
LIST VIDEOS - list videos across all of your Editors, with their state
LIST EDITORS - list your Editors, with their state
CREATE EDITOR - hire a new Editor to build videos for you (do this first if LIST EDITORS is empty). New Editors start offline.
START EDITOR - turn on an offline Editor. An Editor must be online before it can be given a video to build.
CREATE VIDEO <task description> - hands the task to an online Editor, who assembles the video and reports back. Fails if no Editor is online yet.
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
  private model: ContentCreatorModel = "gemma4:latest";
  history: Message[] = [];

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
    this.interrupt();

    await Promise.all(this.editors.map(async (e) => { await e?.shutdown(); }));

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
    await this.setState("online");
    console.log(`ContentCreator(${this.id}) Online`);

    try {
      this.history = [];
      let message = ContentCreatorSystemPrompt;
      for (let step = 0; step < MAX_THINK_STEPS; step++) {
        if (this.state !== "online") break;
        const acted = await this.think(message);
        if (!acted) break;
        message = "Continue.";
      }
    } catch (e: any) {
      await this.setState("offline");
      throw new Error("`ContentCreator(${this.id}) Start Failed", { cause: e });
    }
  }

  async think(msg: string): Promise<boolean> {
    if (this.state !== "online") return false;
    let content: string;

    try {
      this.history.push({ role: "system", content: msg });
      this.notify("change");
      const stream = await this.ollama.chat({
        model: this.model,
        messages: this.history,
        stream: true
      })
      this.currentStream = stream;
      content = "";
      for await (const chunk of stream) {
        content += chunk.message.content;
      }
    } catch (e: any) {
      throw new Error(`Failed to think`, { cause: e });
    }

    this.history.push({ role: "assistant", content });

    const invokeMatch = content.match(/INVOKE:\s*([^\n]+)\n([\s\S]*?)END_INVOKE/);
    if (invokeMatch) {
      const name = (invokeMatch[1] ?? "").trim().toUpperCase();
      const context = (invokeMatch[2] ?? "").trim();
      const result = await this.dispatchCommand(name, context);
      this.history.push({ role: "user", content: `[${name}] ${result}` });
    }

    this.notify("change");
    return invokeMatch !== null;
  }

  private async dispatchCommand(name: string, context: string): Promise<string> {
    try {
      switch (name) {
        case "CREATE EDITOR": {
          const editor = await Editor.load(randomID());
          if (!editor) return "Failed to create new Editor";
          await this.addEditor(editor);
          return `Created Editor(${editor.id})`;
        }
        case "START EDITOR": {
          const editor = this.editors.find((e): e is Editor => e !== undefined && e.state !== "online");
          if (!editor) return "No offline Editor available to start — run CREATE EDITOR first";
          await editor.start();
          return `Editor(${editor.id}) is now ${editor.state}`;
        }
        case "CREATE VIDEO": {
          const editor = this.editors.find((e): e is Editor => e !== undefined && e.state === "online");
          if (!editor) return "No online Editor available to build this video — run CREATE EDITOR then START EDITOR first";
          const video = await editor.createVideo(context);
          return `Editor(${editor.id}) created Video(${video.id})`;
        }
        case "LIST EDITORS": {
          const editors = this.editors.filter((e): e is Editor => e !== undefined);
          return editors.length ? editors.map((e) => `${e.id} (${e.state})`).join(", ") : "No editors";
        }
        case "LIST VIDEOS": {
          const videos: Video[] = this.editors
            .filter((e): e is Editor => e !== undefined)
            .flatMap((e) => e.videos.filter((v): v is Video => v !== undefined));
          return videos.length ? videos.map((v) => `${v.id} (${v.state})`).join(", ") : "No videos";
        }
        case "LIST ACCOUNTS":
          return "Accounts not yet implemented";
        default:
          return `Unknown command: ${name}`;
      }
    } catch (e: any) {
      return `Command failed: ${e instanceof Error ? e.message : String(e)}`;
    }
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
