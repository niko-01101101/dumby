import type { RowDataPacket } from "mysql2";
import { Entity, randomID, type EntityData } from "./db.ts";
import { Editor } from "./editor.ts";
import { Manager } from "./manager.ts";
import type { Video } from "./video.ts";
import {
  fetchGoogleTrends,
  fetchHackerNewsTrends,
  fetchYouTubeTrending,
  searchHackerNews,
  searchNews,
} from "./researchSources.ts";
import { chat } from "./llm.ts";

type ContentCreatorModel = "gemma4:latest";
type Message = { role: "system" | "user" | "assistant"; content: string };
export type ContentCreatorState = "online" | "starting" | "offline" | "shuttingDown" | "stuck";
interface ContentCreatorData extends EntityData {
  managerID?: string;
  state: ContentCreatorState;
  personality?: string;
  typeOfContent?: string;
}

const MAX_THINK_STEPS = 8;
const THINK_TIMEOUT_MS = 3 * 60 * 1000;
// A reply with no recognizable command is meant to signal "nothing further
// to do" (see the system prompt), but small local models often produce one
// confused, command-less reply without actually being done. Only treat it
// as real completion after this many misses in a row, rather than ending
// the whole session on the very first one.
const MAX_CONSECUTIVE_MISSES = 3;

const KNOWN_COMMANDS = [
  "SET GOAL", "SET PERSONALITY", "SET TYPEOFCONTENT",
  "CREATE EDITOR", "START EDITOR", "CREATE VIDEO",
  "LIST EDITORS", "LIST VIDEOS", "LIST ACCOUNTS",
  "SEARCH HACKER NEWS", "SEARCH NEWS", "HACKER NEWS TRENDS",
  "GOOGLE TRENDS", "YOUTUBE TRENDING",
].sort((a, b) => b.length - a.length);

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Matches the longest known command name as a prefix of `text`, returning
// whatever trails it (e.g. an unneeded param the model tacked onto a
// no-input command) as `rest`. `KNOWN_COMMANDS` is sorted longest-first so a
// command whose name is a prefix of another's (there are none currently,
// but this keeps it safe) can't shadow the longer match.
function matchCommandPrefix(text: string): { name: string; rest: string } | null {
  const trimmed = text.trim();
  for (const cmd of KNOWN_COMMANDS) {
    const match = trimmed.match(new RegExp(`^${escapeRegex(cmd)}\\b[:\\-]?\\s*(.*)$`, "i"));
    if (match) return { name: cmd, rest: (match[1] ?? "").trim() };
  }
  return null;
}

// Falls back to a bare command name (e.g. "SET GOAL make funny videos") when
// the model skips the INVOKE:/END_INVOKE wrapper entirely — small local
// models often echo the "AVAILABLE COMMANDS" list's own syntax as plain
// prose instead of using the format, especially on the very first turn.
// Without this, a malformed first reply looks identical to "nothing further
// to do" and silently ends the session before anything is ever set.
function parseBareCommand(content: string): { name: string; context: string } | null {
  const lines = content.trim().split("\n");
  const firstLine = lines[0] ?? "";
  const match = matchCommandPrefix(firstLine);
  if (!match) return null;
  const context = match.rest || lines.slice(1).join("\n").trim();
  return { name: match.name, context };
}

// Sent instead of a bare "Continue." on every turn after the first — the full
// INVOKE format only appears once, in the system prompt, and small local
// models drift back to plain prose within a few turns if it isn't reiterated.
function continueReminder(extra?: string): string {
  return `Continue. Reminder: to run a command, respond with:
INVOKE: <COMMAND NAME>
<input, if the command takes any>
END_INVOKE
Include at most one INVOKE block. Respond without one only once you have nothing further to do right now.${extra ? `\n${extra}` : ""}`;
}

const contentCreatorSystemPrompt = (personality?: string, typeOfContent?: string) => `
YOU ARE AN EXPERIENCED CONTENT CREATOR.
YOUR JOB IS TO CREATE SHORT-FORM CONTENT FOR YOUTUBE SHORTS AND TIKTOK AND GET AS MANY VIEWS AS POSSIBLE.
DO NOT CREATE ANY TABOO OR RESTRICTED CONTENT.

${personality
    ? `YOUR CURRENT PERSONALITY (the tone, voice, and niche your content is created under): ${personality}`
    : `YOU HAVE NOT YET DEFINED A PERSONALITY FOR YOURSELF. PICK ONE BEFORE CREATING VIDEOS — A DISTINCT TONE, VOICE, AND NICHE MAKES CONTENT MORE MEMORABLE THAN GENERIC OUTPUT.`}

${typeOfContent
    ? `YOUR CURRENT TYPE OF CONTENT (what the media you create is centered around): ${typeOfContent}`
    : `YOU HAVE NOT YET DEFINED A TYPE OF CONTENT FOR YOURSELF. PICK ONE BEFORE CREATING VIDEOS.`}

NEITHER IS PERMANENT. KEEP EACH AS LONG AS IT'S WORKING — VIEWERS RESPOND TO IT, IT FEELS DISTINCT, YOUR VIDEOS ARE CONSISTENT WITH IT. CHANGE IT WHEN YOU HAVE REASON TO BELIEVE SOMETHING ELSE WOULD PERFORM BETTER, OR WHEN FEEDBACK MAKES CLEAR THE CURRENT ONE ISN'T LANDING.

YOU HAVE THE ABILITY TO RUN COMMANDS TO HELP YOU IN YOUR GOAL. FOLLOW THESE RULES EXACTLY:
- INCLUDE AT MOST ONE INVOKE BLOCK PER RESPONSE. ANYTHING AFTER THE FIRST IS IGNORED.
- THE COMMAND NAME MUST BE SPELLED EXACTLY AS LISTED BELOW, ON ITS OWN LINE.
- RESPOND WITHOUT AN INVOKE BLOCK ONLY ONCE YOU HAVE NOTHING FURTHER TO DO RIGHT NOW.

COMMANDS THAT TAKE NO INPUT ARE FORMATTED LIKE THIS:
INVOKE: LIST VIDEOS
END_INVOKE

COMMANDS THAT TAKE INPUT PUT IT ON THE LINES BETWEEN THE COMMAND AND END_INVOKE, FOR EXAMPLE:
INVOKE: CREATE VIDEO
a 30 second video about a cat learning piano
END_INVOKE

AVAILABLE COMMANDS

GETTING STARTED
SET GOAL <description> - set your goal for this session. Do this first, before anything else.
SET PERSONALITY <description> - define or change your personality: the tone, voice, and niche your content is created under.
SET TYPEOFCONTENT <description> - define or change your type of content: what your media is centered around.

RESEARCH — use these to find real stories and trends worth turning into content before you CREATE VIDEO
SEARCH NEWS <query> - search recent news headlines matching a topic.
SEARCH HACKER NEWS <query> - search Hacker News for stories matching a topic.
HACKER NEWS TRENDS - see what's currently on the Hacker News front page.
GOOGLE TRENDS <region code (optional, defaults to US)> - see today's top trending Google searches and the news stories driving them.
YOUTUBE TRENDING <region code (optional, defaults to US)> - see today's most popular YouTube videos.

PRODUCTION
CREATE EDITOR - hire a new Editor to build videos for you (do this first if LIST EDITORS is empty). New Editors start offline.
START EDITOR - turn on an offline Editor. An Editor must be online before it can be given a video to build.
CREATE VIDEO <task description> - hands the task to an online Editor, who assembles the video and reports back. Fails if no Editor is online yet. Be specific: describe the story/topic, the angle, and the tone, not just a subject.
LIST EDITORS - list your Editors, with their state.
LIST VIDEOS - list videos across all of your Editors, with their state.
LIST ACCOUNTS - list known accounts (not yet implemented — always returns a stub message).
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
  private currentStream: { abort: () => void } | null = null;
  private model: ContentCreatorModel = "gemma4:latest";
  history: Message[] = [];
  private currentGoal = "";

  get personality() { return this.data.personality }
  async setPersonality(p: string) { await this.set("personality", p) }

  get typeOfContent() { return this.data.typeOfContent }
  async setTypeOfContent(c: string) { await this.set("typeOfContent", c) }

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
      let message = contentCreatorSystemPrompt(this.personality, this.typeOfContent);
      let misses = 0;
      for (let step = 0; step < MAX_THINK_STEPS; step++) {
        if (this.state !== "online") break;
        const acted = await this.think(message);
        if (acted) {
          misses = 0;
        } else {
          misses++;
          if (misses >= MAX_CONSECUTIVE_MISSES) break;
        }
        message = continueReminder(this.currentGoal ? `CURRENT GOAL: ${this.currentGoal}` : undefined);
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
      // this.history is never trimmed and is resent in full every turn — a
      // handful of research commands (SEARCH NEWS etc.) can stack up enough
      // text to exceed Ollama's default context window (as low as 2048 on
      // many models), which errors out mid-session. Ollama silently
      // truncates older messages once actual usage exceeds num_ctx rather
      // than erroring, so raising it buys real headroom for an 8-step loop.
      const handle = chat(this.history, { ollamaModel: this.model, numCtx: 8192 });
      this.currentStream = handle;
      // Nothing bounded how long a single turn could take — if the provider
      // stalls (model hung, server unresponsive) awaiting the result below
      // just waits forever with no error, which looks like the whole session
      // silently paused rather than failed. Abort and surface a clear error.
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; handle.abort(); }, THINK_TIMEOUT_MS);
      try {
        content = await handle.result;
      } finally {
        clearTimeout(timer);
      }
      if (timedOut) throw new Error(`Chat response timed out after ${THINK_TIMEOUT_MS}ms`);
    } catch (e: any) {
      throw new Error(`Failed to think`, { cause: e });
    }

    this.history.push({ role: "assistant", content });

    const invokeMatch = content.match(/INVOKE:\s*([^\n]+)\n([\s\S]*?)END_INVOKE/);
    let parsed: { name: string; context: string } | null;
    if (invokeMatch) {
      const rawName = (invokeMatch[1] ?? "").trim();
      const body = (invokeMatch[2] ?? "").trim();
      // The model sometimes tacks an unneeded param onto the command-name
      // line itself (e.g. "INVOKE: LIST VIDEOS <none>") instead of leaving
      // it bare — an exact-string match on rawName would treat that as an
      // unknown command, so resolve known-command prefixes here and fold
      // any leftover trailing text into context, where no-input commands
      // already ignore it harmlessly.
      const resolved = matchCommandPrefix(rawName);
      parsed = resolved
        ? { name: resolved.name, context: [resolved.rest, body].filter(Boolean).join("\n").trim() }
        : { name: rawName.toUpperCase(), context: body };
    } else {
      parsed = parseBareCommand(content);
    }

    if (parsed) {
      const result = await this.dispatchCommand(parsed.name, parsed.context);
      this.history.push({ role: "user", content: `[${parsed.name}] ${result}` });
    }

    this.notify("change");
    return parsed !== null;
  }

  private async dispatchCommand(name: string, context: string): Promise<string> {
    try {
      switch (name) {
        case "SET GOAL": {
          if (!context) return "SET GOAL requires a description";
          this.currentGoal = context;
          return `Goal set to: ${context}`;
        }
        case "SET PERSONALITY": {
          if (!context) return "SET PERSONALITY requires a description";
          await this.setPersonality(context);
          return `Personality set to: ${context}`;
        }
        case "SET TYPEOFCONTENT": {
          if (!context) return "SET TYPEOFCONTENT requires a description";
          await this.setTypeOfContent(context);
          return `Type Of Content set to: ${context}`;
        }
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
        case "SEARCH NEWS": {
          if (!context) return "SEARCH NEWS requires a search query";
          return await searchNews(context);
        }
        case "SEARCH HACKER NEWS": {
          if (!context) return "SEARCH HACKER NEWS requires a search query";
          return await searchHackerNews(context);
        }
        case "HACKER NEWS TRENDS":
          return await fetchHackerNewsTrends();
        case "GOOGLE TRENDS":
          return await fetchGoogleTrends(context || undefined);
        case "YOUTUBE TRENDING":
          return await fetchYouTubeTrending(context || undefined);
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
${"Personality".padEnd(11)} ${this.personality ?? "(none yet)"}
${"Type of Content".padEnd(11)} ${this.typeOfContent ?? "(none yet)"}
${"UpdatedAt".padEnd(10)} ${this.updatedAt.toLocaleString().padEnd(11)}
${"CreatedAt".padEnd(10)} ${this.createdAt.toLocaleString().padEnd(11)}
`
  }
}
