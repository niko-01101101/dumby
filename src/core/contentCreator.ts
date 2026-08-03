import type { RowDataPacket } from "mysql2";
import { Entity, randomID, type EntityData } from "./db.ts";
import { Account } from "./account.ts";
import type { Editor } from "./editor.ts";
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
import { isPlatform, PLATFORMS, platformLabel, publishVideo } from "./platforms.ts";
import { Reminder } from "./reminder.ts";

type ContentCreatorModel = "gemma4:latest";
type Message = { role: "system" | "user" | "assistant"; content: string };
export type ContentCreatorState = "online" | "starting" | "offline" | "shuttingDown" | "stuck" | "sleeping";
interface ContentCreatorData extends EntityData {
  managerID?: string;
  state: ContentCreatorState;
  personality?: string;
  typeOfContent?: string;
}

const MAX_THINK_STEPS = 8;
const THINK_TIMEOUT_MS = 3 * 60 * 1000;
const MAX_HISTORY_MESSAGES = 16;
const RECENT_VIDEO_CONTEXT_LIMIT = 5;
const MAX_CONSECUTIVE_MISSES = 3;
const DEFAULT_RELEASE_INTERVAL_MINUTES = 1440;

const KNOWN_COMMANDS = [
  "setGoal", "setPersonality", "setTypeOfContent",
  "createAccount", "createVideo", "postVideo",
  "listEditors", "listVideos", "listAccounts",
  "searchHackerNews", "searchNews", "hackerNewsTrends",
  "googleTrends", "youtubeTrending",
].sort((a, b) => b.length - a.length);

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Primary parse path: commandName(argument text); — built from
// KNOWN_COMMANDS rather than a bare `\w+\(...\)` pattern so an incidental
// parenthetical in the model's own prose (e.g. "a video about AI (LLMs
// specifically)") can't be mistaken for a call. `[^()]*` allows a
// multi-line argument but can't handle a nested `(`/`)` inside it — the
// match just truncates at the first `)`, unlike the old INVOKE/END_INVOKE
// format's explicit delimiter.
const CALL_PATTERN = new RegExp(`\\b(${KNOWN_COMMANDS.map(escapeRegex).join("|")})\\s*\\(([^()]*)\\)\\s*;?`, "g");

function matchCommandPrefix(text: string): { name: string; rest: string } | null {
  const trimmed = text.trim();
  for (const cmd of KNOWN_COMMANDS) {
    const match = trimmed.match(new RegExp(`^${escapeRegex(cmd)}\\b[:\\-]?\\s*(.*)$`, "i"));
    if (match) return { name: cmd, rest: (match[1] ?? "").trim() };
  }
  return null;
}

// Fallback for a model that drops the parens/semicolon entirely and just
// writes the command name as a plain-text prefix (e.g. "setGoal make funny
// videos about cats").
function parseBareCommand(content: string): { name: string; context: string } | null {
  const lines = content.trim().split("\n");
  const firstLine = lines[0] ?? "";
  const match = matchCommandPrefix(firstLine);
  if (!match) return null;
  const context = match.rest || lines.slice(1).join("\n").trim();
  return { name: match.name, context };
}

function continueReminder(extra?: string): string {
  return `Continue. Reminder: to run a command, call it like:
commandName(argument, if the command takes one);
You may include multiple commands in one response to run several in sequence. Respond without any commands only once you have nothing further to do right now.${extra ? `\n${extra}` : ""}`;
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
- YOU MAY INCLUDE MULTIPLE COMMANDS IN ONE RESPONSE TO RUN SEVERAL COMMANDS IN SEQUENCE.
- THE COMMAND NAME MUST BE SPELLED EXACTLY AS LISTED BELOW.
- RESPOND WITHOUT ANY COMMANDS ONLY ONCE YOU HAVE NOTHING FURTHER TO DO RIGHT NOW.

AVAILABLE COMMANDS

GETTING STARTED
setGoal(<description>); - set your goal for this session. Do this first, before anything else.
setPersonality(<description>); - define or change your personality: the tone, voice, and niche your content is created under.
setTypeOfContent(<description>); - define or change your type of content: what your media is centered around.

RESEARCH — use these to find real stories and trends worth turning into content before you CREATE VIDEO
searchNews(<query>); - search recent news headlines matching a topic.
searchHackerNews(<query>); - search Hacker News for stories matching a topic.
hackerNewsTrends(); - see what's currently on the Hacker News front page.
googleTrends(<region code (optional, defaults to US)>); - see today's top trending Google searches and the news stories driving them.
youtubeTrending(<region code (optional, defaults to US)>); - see today's most popular YouTube videos.

PRODUCTION
createAccount(<platform: ${PLATFORMS.join(" | ")}> <content description>); - create an Account to publish videos under. Do this once per platform before creating videos — createVideo requires at least one Account to exist. Example: createAccount(youtube a channel breaking down obscure programming history);
createVideo(<task description>); - hands the task to an online Editor (a shared resource your Manager provisions — you don't create your own), who builds the video under one of your Accounts and reports back. Fails if you have no Account yet, or no Editor is online. Be specific: describe the story/topic, the angle, and the tone, not just a subject.
postVideo(<videoID>); - publish a completed video to its Account's platform (YouTube only for now). THIS GOES LIVE PUBLICLY AND IMMEDIATELY, WITH NO REVIEW STEP — only do this once you're confident the video is finished and appropriate. Fails if the video isn't "completed" yet, or its Account isn't connected to that platform.
listEditors(); - list Editors available under your Manager, with their state.
listVideos(); - list videos across all of your Accounts, with their state.
listAccounts(); - list your Accounts, with their content description.
`;

const stateColor = {
  online: "{green-bg} {/green-bg}",
  starting: "{blue-bg} {/blue-bg}",
  offline: "{black-bg} {/black-bg}",
  shuttingDown: "{red-bg} {/red-bg}",
  stuck: "{yellow-bg} {/yellow-bg}",
  sleeping: "{cyan-bg} {/cyan-bg}",
}

export class ContentCreator extends Entity<ContentCreatorData> {
  static table = "contentCreators";
  private currentStream: { abort: () => void } | null = null;
  private model: ContentCreatorModel = "gemma4:latest";
  history: Message[] = [];
  private _goal = "";
  get goal() { return this._goal }

  get personality() { return this.data.personality }
  async setPersonality(p: string) { await this.set("personality", p) }

  get typeOfContent() { return this.data.typeOfContent }
  async setTypeOfContent(c: string) { await this.set("typeOfContent", c) }

  manager: Manager | undefined;
  async setManager(m: Manager) {
    this.manager = m;
    await this.set("managerID", m.id);
  }

  accounts: (Account | undefined)[] = [];
  async loadAccounts() {
    const [rows] = await this.pool.query<RowDataPacket[]>(`SELECT id FROM ${Account.table} WHERE contentCreatorID = ? AND deletedAt IS NULL`, [this.id]);
    this.accounts = await Promise.all(rows.map(async (a) => await Account.load(a.id)));
  }

  async addAccount(account: Account) {
    await account.setContentCreator(this);
    this.accounts.push(account);
    this.notify("change");
  }

  removeAccountFromList(account: Account) {
    this.accounts = this.accounts.filter((a) => a !== account);
    this.notify("change");
  }

  async loadDeletedAccounts(): Promise<Account[]> {
    return Account.loadDeletedByColumn("contentCreatorID", this.id);
  }

  async createVideo(task: string): Promise<string> {
    const account = this.accounts.find((a): a is Account => a !== undefined);
    if (!account) return "No Account available to build this video under — run createAccount(...) first";
    const editor = this.manager?.findAvailableEditor();
    if (!editor) return "No online Editor available under your Manager to build this video — ask your Manager to add and start one";
    if (editor.state === "sleeping") await editor.start();
    const video = await editor.createVideo(account, task, this.recentVideoContext(3), this.processTranscript());
    return `Editor(${editor.id}) created Video(${video.id}) under Account(${account.id})`;
  }

  // The session's reasoning trail (research commands, results, and the
  // model's own replies) up to and not including this createVideo() call
  // itself — recorded onto the Video so it's later possible to see why this
  // prompt was chosen, not just what it was.
  private processTranscript(): string {
    return this.history.map((m) => `[${m.role}] ${m.content}`).join("\n\n");
  }

  private recentVideoContext(limit = RECENT_VIDEO_CONTEXT_LIMIT): string {
    const videos = this.accounts
      .filter((a): a is Account => a !== undefined)
      .flatMap((a) => a.videos.filter((v): v is Video => v !== undefined))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
    if (!videos.length) return "";

    const lines = videos.map((v) =>
      `- "${v.prompt ?? "(no prompt)"}" [${v.state}]${v.feedback ? ` — feedback: ${v.feedback}` : ""}`
    );
    return `YOUR ${videos.length} MOST RECENT VIDEOS — avoid repeating the same topic or angle, and let any feedback below inform your next setPersonality/setTypeOfContent and createVideo choices:\n${lines.join("\n")}`;
  }

  get state() { return this.data.state }
  async setState(s: ContentCreatorState) { this.data.state = s; await this.set("state", s); }

  async onLoad() {
    this.manager = await Manager.load(this.data.managerID);
    await this.loadAccounts();
  }

  async shutdown() {
    console.log(`ContentCreator(${this.id}) Shutting Down...`);
    await this.setState("shuttingDown");
    this.interrupt();

    await this.setState("offline");
    console.log(`ContentCreator(${this.id}) Offline`);
  }

  async start(wakeReason?: string) {
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
      this._goal = "";
      let message = contentCreatorSystemPrompt(this.personality, this.typeOfContent);
      const recentContext = this.recentVideoContext();
      if (recentContext) message += `\n\n${recentContext}`;
      if (wakeReason) message += `\n\nYOU WERE JUST WOKEN UP. REASON: ${wakeReason}`;
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
        message = continueReminder(this._goal ? `CURRENT GOAL: ${this._goal}` : undefined);
      }

      if (this.state === "online") {
        await this.setState("sleeping");
        console.log(`ContentCreator(${this.id}) Sleeping`);
        const intervalMinutes = this.manager?.releaseIntervalMinutes ?? DEFAULT_RELEASE_INTERVAL_MINUTES;
        const wakeAt = new Date(Date.now() + intervalMinutes * 60_000);
        await Reminder.schedule("contentCreator", this.id, wakeAt, "Scheduled release cycle — time to check for new content to make.");
      }
    } catch (e: any) {
      await this.setState("offline");
      throw new Error(`ContentCreator(${this.id}) Start Failed: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
    }
  }

  async think(msg: string): Promise<boolean> {
    if (this.state !== "online") return false;
    let content: string;

    try {
      this.history.push({ role: "system", content: msg });
      this.notify("change");
      const handle = chat(this.history, { ollamaModel: this.model, numCtx: 8192, maxHistoryMessages: MAX_HISTORY_MESSAGES });
      this.currentStream = handle;
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; handle.abort(); }, THINK_TIMEOUT_MS);
      try {
        content = await handle.result;
      } finally {
        clearTimeout(timer);
      }
      if (timedOut) throw new Error(`Chat response timed out after ${THINK_TIMEOUT_MS}ms`);
    } catch (e: any) {
      throw new Error(`Failed to think: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
    }

    this.history.push({ role: "assistant", content });

    const invokeMatches = [...content.matchAll(CALL_PATTERN)];
    let parsedList: { name: string; context: string }[];
    if (invokeMatches.length) {
      parsedList = invokeMatches.map((invokeMatch) => ({
        name: invokeMatch[1] ?? "",
        context: (invokeMatch[2] ?? "").trim(),
      }));
    } else {
      const bare = parseBareCommand(content);
      parsedList = bare ? [bare] : [];
    }

    for (const parsed of parsedList) {
      const result = await this.dispatchCommand(parsed.name, parsed.context);
      this.history.push({ role: "user", content: `[${parsed.name}] ${result}` });
    }

    this.notify("change");
    return parsedList.length > 0;
  }

  private async dispatchCommand(name: string, context: string): Promise<string> {
    try {
      switch (name) {
        case "setGoal": {
          if (!context) return "setGoal(...) requires a description";
          this._goal = context;
          this.notify("change");
          return `Goal set to: ${context}`;
        }
        case "setPersonality": {
          if (!context) return "setPersonality(...) requires a description";
          await this.setPersonality(context);
          return `Personality set to: ${context}`;
        }
        case "setTypeOfContent": {
          if (!context) return "setTypeOfContent(...) requires a description";
          await this.setTypeOfContent(context);
          return `Type Of Content set to: ${context}`;
        }
        case "createAccount": {
          const [platformRaw, ...rest] = context.trim().split(/\s+/);
          const description = rest.join(" ").trim();
          if (!platformRaw || !description) {
            return `createAccount(...) requires a platform and a content description, e.g. createAccount(youtube a channel about ...) — valid platforms: ${PLATFORMS.join(", ")}`;
          }
          if (!isPlatform(platformRaw)) {
            return `createAccount(...) unknown platform "${platformRaw}" — valid platforms: ${PLATFORMS.join(", ")}`;
          }
          const account = await Account.load(randomID());
          if (!account) return "Failed to create new Account";
          await account.setPlatform(platformRaw);
          await account.setContentDescription(description);
          await this.addAccount(account);
          return `Created Account(${account.id}) on ${platformLabel(platformRaw)}: ${description}`;
        }
        case "createVideo": {
          if (!context) return "createVideo(...) requires a task description";
          return await this.createVideo(context);
        }
        case "postVideo": {
          const videoID = context.trim();
          if (!videoID) return "postVideo(...) requires a videoID";
          const account = this.accounts.find((a): a is Account => a !== undefined && a.videos.some((v) => v?.id === videoID));
          const video = account?.videos.find((v): v is Video => v !== undefined && v.id === videoID);
          if (!account || !video) return `No video found with id ${videoID} under any of your Accounts`;
          if (video.state !== "completed") return `Video(${video.id}) is not ready to post — its state is "${video.state}", not "completed"`;
          if (!account.isConnected) return `Account(${account.id}) is not connected to ${platformLabel(account.platform)} yet — connect it from the CLI first`;
          const { url } = await publishVideo(account, video);
          return `Posted Video(${video.id}) to ${platformLabel(account.platform)} -> ${url}`;
        }
        case "listEditors": {
          const editors = (this.manager?.editors ?? []).filter((e): e is Editor => e !== undefined);
          return editors.length ? editors.map((e) => `${e.id} (${e.state})`).join(", ") : "No editors available under your Manager";
        }
        case "listVideos": {
          const videos: Video[] = this.accounts
            .filter((a): a is Account => a !== undefined)
            .flatMap((a) => a.videos.filter((v): v is Video => v !== undefined));
          return videos.length ? videos.map((v) => `${v.id} (${v.state})`).join(", ") : "No videos";
        }
        case "listAccounts": {
          const accounts = this.accounts.filter((a): a is Account => a !== undefined);
          return accounts.length ? accounts.map((a) => `${a.id} [${platformLabel(a.platform)}] (${a.contentDescription ?? "no description"})`).join(", ") : "No accounts";
        }
        case "searchNews": {
          if (!context) return "searchNews(...) requires a search query";
          return await searchNews(context);
        }
        case "searchHackerNews": {
          if (!context) return "searchHackerNews(...) requires a search query";
          return await searchHackerNews(context);
        }
        case "hackerNewsTrends":
          return await fetchHackerNewsTrends();
        case "googleTrends":
          return await fetchGoogleTrends(context || undefined);
        case "youtubeTrending":
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
${"Goal".padEnd(11)} ${this.goal || "(none yet)"}
${"UpdatedAt".padEnd(10)} ${this.updatedAt.toLocaleString().padEnd(11)}
${"CreatedAt".padEnd(10)} ${this.createdAt.toLocaleString().padEnd(11)}
`
  }
}
