import path from "node:path";
import type { Account } from "./account.ts";
import { Manager } from "./manager.ts";
import { Entity, randomID, type EntityData } from "./db.ts";
import { compileVideo, type CompileAudio } from "./ffmpeg.ts";
import { Media } from "./media.ts";
import { fetchFreesoundMusic, fetchPexelsClip, fetchPixabayClip, fetchTwitchGameplayClip, synthesizeVoiceover } from "./mediaSources.ts";
import { Video } from "./video.ts";
import { chat } from "./llm.ts";

function mediaDir() { return process.env.MEDIA_DIR ?? "./media"; }

function stripStageDirections(text: string): string {
  return text
    .replace(/\([^)]*\)/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\*[^*]*\*/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

type EditorModel = "gemma4:latest";
type Message = { role: "system" | "user" | "assistant"; content: string };

const MAX_EDIT_STEPS = 20;
const THINK_TIMEOUT_MS = 3 * 60 * 1000;
const MAX_HISTORY_MESSAGES = 16;
const MAX_VOICEOVER_CHARS = 1000;

const KNOWN_COMMANDS = ["pexelsClip", "pixabayClip", "gameplayClip", "voiceover", "music", "compile"]
  .sort((a, b) => b.length - a.length);

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Primary parse path: commandName(argument text); — built from
// KNOWN_COMMANDS rather than a bare `\w+\(...\)` pattern so an incidental
// parenthetical in the model's own prose can't be mistaken for a call.
// `[^()]*` allows a multi-line argument but can't handle a nested `(`/`)`
// inside it — the match just truncates at the first `)`.
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
// writes the command name as a plain-text prefix (e.g. "compile" on its own
// line) — small local models often echo the "AVAILABLE COMMANDS" list's own
// syntax as plain prose instead of using the format. Without this the
// attempt is silently discarded and the model just gets a CONTINUE_REMINDER
// as if it had said nothing at all.
function parseBareCommand(content: string): { name: string; context: string } | null {
  const lines = content.trim().split("\n");
  const firstLine = lines[0] ?? "";
  const match = matchCommandPrefix(firstLine);
  if (!match) return null;
  const context = match.rest || lines.slice(1).join("\n").trim();
  return { name: match.name, context };
}

// Sent instead of a bare "Continue." on every turn after the first — the
// call syntax only appears once, in the system prompt, and small local
// models drift back to plain prose within a few turns if it isn't
// reiterated. Unlike ContentCreator's loop, omitting a command here does NOT
// end the session cleanly — only compile() is treated as terminal (see
// think() below) — so this reminder pushes toward finishing, not stopping.
const CONTINUE_REMINDER = `Continue. Reminder: to run a command, call it like:
commandName(argument, if the command takes one);
You may include multiple commands in one response to run several in sequence — put compile(); last if you include it, since anything after it is ignored. You must call compile() to finish — stopping without it, or running out of turns, abandons the video.`;

const editorSystemPrompt = (task: string, feedbackContext?: string, existingMediaContext?: string) => `
YOU ARE AN EXPERIENCED VIDEO EDITOR.
YOUR JOB IS TO ASSEMBLE A SHORT VIDEO FOR THE FOLLOWING TASK, GIVEN TO YOU BY YOUR CONTENT CREATOR:
${task}
${feedbackContext ? `\n${feedbackContext}\nLET THIS INFORM YOUR EDITING CHOICES (PACING, CLIP SELECTION, TONE OF ANY VOICEOVER) WHERE RELEVANT.\n` : ""}
${existingMediaContext ? `\n${existingMediaContext}\n` : ""}

YOU HAVE THE ABILITY TO RUN COMMANDS TO GATHER MEDIA AND ASSEMBLE THE VIDEO. FOLLOW THESE RULES EXACTLY:
- YOU MAY INCLUDE MULTIPLE COMMANDS IN ONE RESPONSE TO RUN SEVERAL IN SEQUENCE. IF YOU INCLUDE compile(), IT MUST BE LAST — ANYTHING AFTER IT IS IGNORED.
- THE COMMAND NAME MUST BE SPELLED EXACTLY AS LISTED BELOW.
- YOU MUST CALL compile() TO FINISH. IT IS THE ONLY WAY YOUR WORK IS SAVED — IF YOU STOP WITHOUT IT, THE VIDEO IS ABANDONED.

COMMANDS ARE FORMATTED EXACTLY LIKE THIS:
pexelsClip(a cat playing piano);

AVAILABLE COMMANDS
pexelsClip(<search query>); - add a licensed stock video clip
pixabayClip(<search query>); - add a licensed stock video clip
gameplayClip(<game name>); - add a real Twitch gameplay clip of the named game. Use this instead of pexelsClip/pixabayClip whenever the task is actually about a video game or its gameplay — stock footage services don't carry real gameplay.
voiceover(<script text>); - add a narrated voiceover track. THE SCRIPT TEXT IS SPOKEN ALOUD EXACTLY AS WRITTEN, WORD FOR WORD, BY A TEXT-TO-SPEECH ENGINE. DO NOT INCLUDE TONE, STYLE, OR STAGE DIRECTIONS (e.g. "(cheerfully)", "[upbeat tone]", "*excited*") OR ANY OTHER TEXT THAT ISN'T MEANT TO BE SPOKEN OUT LOUD. ONLY WRITE THE WORDS TO BE NARRATED.
music(<mood/genre query, e.g. "upbeat lofi", "tense cinematic">); - add a background music track. It plays under the whole video at low volume, automatically ducking further under any voiceover so narration stays clear. Add this to every video for production value, before compile() — if you skip it, compile() will still add a generic one automatically. At most one per video.
compile(); - assemble all added media into the final video. Call this once you have a handful of clips (typically 3-6 for a short-form video) and, if the task calls for narration, a voiceover. This is your last step.
`;

export type EditorState = "online" | "starting" | "offline" | "shuttingDown" | "stuck" | "sleeping";
interface EditorData extends EntityData {
  managerID?: string;
  state: EditorState;
}

const stateColor = {
  online: "{green-bg} {/green-bg}",
  starting: "{blue-bg} {/blue-bg}",
  offline: "{black-bg} {/black-bg}",
  shuttingDown: "{red-bg} {/red-bg}",
  stuck: "{yellow-bg} {/yellow-bg}",
  sleeping: "{cyan-bg} {/cyan-bg}",
}

export class Editor extends Entity<EditorData> {
  static table = "editors";
  private currentStream: { abort: () => void } | null = null;
  private model: EditorModel = "gemma4:latest";
  private activeVideo: Video | undefined;
  history: Message[] = [];

  manager: Manager | undefined;
  async setManager(m: Manager) {
    this.manager = m;
    await this.set("managerID", m.id);
  }

  async addPexelsClip(video: Video, query: string) {
    const media = await Media.load(randomID());
    if (!media) throw new Error(`Failed to create new Media`);
    await media.setKind("clip");
    await media.setSource("pexels");
    await media.setSourceRef(query);

    const destPath = path.join(mediaDir(), video.id, `${media.id}.mp4`);
    await fetchPexelsClip(query, destPath);
    await media.setLocalPath(destPath);

    await video.addMedia(media);
    return media;
  }

  async addPixabayClip(video: Video, query: string) {
    const media = await Media.load(randomID());
    if (!media) throw new Error(`Failed to create new Media`);
    await media.setKind("clip");
    await media.setSource("pixabay");
    await media.setSourceRef(query);

    const destPath = path.join(mediaDir(), video.id, `${media.id}.mp4`);
    await fetchPixabayClip(query, destPath);
    await media.setLocalPath(destPath);

    await video.addMedia(media);
    return media;
  }

  async addGameplayClip(video: Video, query: string) {
    const media = await Media.load(randomID());
    if (!media) throw new Error(`Failed to create new Media`);
    await media.setKind("clip");
    await media.setSource("twitch");
    await media.setSourceRef(query);

    const destPath = path.join(mediaDir(), video.id, `${media.id}.mp4`);
    await fetchTwitchGameplayClip(query, destPath);
    await media.setLocalPath(destPath);

    await video.addMedia(media);
    return media;
  }

  async addVoiceover(video: Video, text: string) {
    const media = await Media.load(randomID());
    if (!media) throw new Error(`Failed to create new Media`);
    await media.setKind("audio");
    await media.setSourceRef(text);

    const script = stripStageDirections(text);
    const destPath = path.join(mediaDir(), video.id, `${media.id}.wav`);
    const engine = await synthesizeVoiceover(script, destPath);
    await media.setSource(engine);
    await media.setLocalPath(destPath);

    await video.addMedia(media);
    return media;
  }

  async addMusic(video: Video, query: string) {
    const media = await Media.load(randomID());
    if (!media) throw new Error(`Failed to create new Media`);
    await media.setKind("audio");
    await media.setSource("freesound");
    await media.setSourceRef(query);

    const destPath = path.join(mediaDir(), video.id, `${media.id}.mp3`);
    await fetchFreesoundMusic(query, destPath);
    await media.setLocalPath(destPath);

    await video.addMedia(media);
    return media;
  }

  async compile(video: Video): Promise<string> {
    await video.loadMedia();

    if (!video.media.some((m) => m?.kind === "audio" && m.source === "freesound")) {
      try {
        await this.addMusic(video, video.prompt ? `background music for ${video.prompt}` : "upbeat background music");
      } catch (e: any) {
        console.error(`Editor(${this.id}) auto-add music for Video(${video.id}) failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const clips = video.media
      .filter((m): m is Media => m !== undefined && m.kind === "clip")
      .sort((a, b) => a.position - b.position);
    const voiceovers = video.media
      .filter((m): m is Media => m !== undefined && m.kind === "audio" && (m.source === "google-tts" || m.source === "piper"))
      .sort((a, b) => a.position - b.position);
    const music = video.media.find((m): m is Media => m !== undefined && m.kind === "audio" && m.source === "freesound");

    if (!clips.length) throw new Error(`Video(${video.id}) has no clips to compile`);
    const clipPaths = clips.map((c) => c.localPath);
    if (clipPaths.some((p) => !p)) throw new Error(`Video(${video.id}) has a clip with no downloaded media`);

    const outputPath = path.join(mediaDir(), `${video.id}.mp4`);
    const audio: CompileAudio = {};
    const voiceoverPaths = voiceovers.map((v) => v.localPath).filter((p): p is string => !!p);
    if (voiceoverPaths.length) audio.voiceoverPaths = voiceoverPaths;
    if (music?.localPath) audio.musicPath = music.localPath;
    await compileVideo(clipPaths as string[], audio, outputPath);

    await video.setState("completed");
    return outputPath;
  }

  private findResumableVideo(account: Account, task: string): Video | undefined {
    return account.videos.find(
      (v): v is Video =>
        v !== undefined &&
        (v.state === "notStarted" || v.state === "workingOn") &&
        v.prompt?.trim().toLowerCase() === task.trim().toLowerCase(),
    );
  }

  private describeExistingMedia(video: Video): string | undefined {
    const items = video.media.filter((m): m is Media => m !== undefined);
    if (!items.length) return undefined;
    const lines = items.map((m) => {
      if (m.kind === "clip") return `- ${m.source} clip already added: "${m.sourceRef ?? ""}"`;
      if (m.kind === "audio" && m.source === "freesound") return `- background music already added: "${m.sourceRef ?? ""}"`;
      if (m.kind === "audio") return `- voiceover already recorded, do not add another`;
      return `- ${m.kind} (${m.source}) already added`;
    });
    return `THIS VIDEO WAS PREVIOUSLY STARTED AND ABANDONED BEFORE IT WAS FINISHED. THE FOLLOWING MEDIA WAS ALREADY GATHERED FOR IT — DO NOT RE-FETCH ANY OF IT, BUILD ON TOP OF IT INSTEAD:\n${lines.join("\n")}`;
  }

  async createVideo(account: Account, task: string, feedbackContext?: string, promptProcess?: string): Promise<Video> {
    if (this.state !== "online") throw new Error(`Editor(${this.id}) must be online to create a video`);

    await account.loadVideos();
    const resumed = this.findResumableVideo(account, task);
    let existingMediaContext: string | undefined;

    let video: Video;
    if (resumed) {
      video = resumed;
      existingMediaContext = this.describeExistingMedia(video);
      console.log(`Editor(${this.id}) resuming abandoned Video(${video.id}) with ${video.media.filter((m) => m).length} existing media item(s)`);
    } else {
      const created = await Video.load(randomID());
      if (!created) throw new Error(`Failed to create new Video`);
      await account.addVideo(created);
      await created.setPrompt(task);
      if (promptProcess) await created.setPromptProcess(promptProcess);
      video = created;
    }
    await video.setState("workingOn");

    this.activeVideo = video;
    this.history = [];

    try {
      let message = editorSystemPrompt(task, feedbackContext, existingMediaContext);
      for (let step = 0; step < MAX_EDIT_STEPS; step++) {
        if (this.state !== "online") break;
        const done = await this.think(message);
        if (done) break;
        message = CONTINUE_REMINDER;
      }

      if (video.state === "workingOn") {
        await video.loadMedia();
        const hasClip = video.media.some((m) => m?.kind === "clip");
        if (hasClip) await this.compile(video);
      }
    } finally {
      if (video.state === "workingOn") await video.setState("notStarted");
      this.activeVideo = undefined;
      if (this.state === "online") await this.setState("sleeping");
    }

    return video;
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

    let done = false;
    for (const parsed of parsedList) {
      const { message, ok } = await this.runCommand(parsed.name, parsed.context);
      this.history.push({ role: "user", content: `[${parsed.name}] ${message}` });
      if (parsed.name === "compile" && ok) {
        done = true;
        break;
      }
    }

    this.notify("change");
    return done;
  }

  private async runCommand(name: string, context: string): Promise<{ message: string; ok: boolean }> {
    const video = this.activeVideo;
    if (!video) return { message: "No active Video", ok: false };

    try {
      switch (name) {
        case "pexelsClip": {
          const media = await this.addPexelsClip(video, context);
          return { message: `Added Pexels clip(${media.id}) for "${context}"`, ok: true };
        }
        case "pixabayClip": {
          const media = await this.addPixabayClip(video, context);
          return { message: `Added Pixabay clip(${media.id}) for "${context}"`, ok: true };
        }
        case "gameplayClip": {
          if (!context) return { message: "gameplayClip(...) requires a game name", ok: false };
          const media = await this.addGameplayClip(video, context);
          return { message: `Added Twitch gameplay clip(${media.id}) for "${context}"`, ok: true };
        }
        case "voiceover": {
          if (!context) return { message: "voiceover(...) requires script text", ok: false };
          if (context.length > MAX_VOICEOVER_CHARS) {
            return {
              message: `voiceover(...) script is ${context.length} characters, over the ${MAX_VOICEOVER_CHARS} limit for short-form narration — shorten it`,
              ok: false,
            };
          }
          const media = await this.addVoiceover(video, context);
          return { message: `Added voiceover(${media.id})`, ok: true };
        }
        case "music": {
          if (!context) return { message: "music(...) requires a mood/genre query", ok: false };
          const media = await this.addMusic(video, context);
          return { message: `Added background music(${media.id}) for "${context}"`, ok: true };
        }
        case "compile": {
          const outputPath = await this.compile(video);
          return { message: `Compiled -> ${outputPath}`, ok: true };
        }
        default:
          return { message: `Unknown command: ${name}`, ok: false };
      }
    } catch (e: any) {
      return { message: `Command failed: ${e instanceof Error ? e.message : String(e)}`, ok: false };
    }
  }

  public interrupt(): void {
    if (this.currentStream) {
      this.currentStream.abort();
      this.currentStream = null;
    }
  }

  get state() { return this.data.state }
  async setState(s: EditorState) { this.data.state = s; await this.set("state", s); }

  async onLoad() {
    this.manager = await Manager.load(this.data.managerID);
  }

  async shutdown() {
    console.log(`Editor(${this.id}) Shutting Down...`);
    await this.setState("shuttingDown");
    this.interrupt();
    await this.setState("offline");
    console.log(`Editor(${this.id}) Offline`);
  }

  async start() {
    if (this.manager && this.manager?.state !== "online") {
      console.log(`Editor(${this.id}) Start Failed : Manager is not Online`);
      return;
    }
    console.log(`Editor(${this.id}) Starting...`);
    await this.setState("starting");
    await this.setState("online");
    console.log(`Editor(${this.id}) Online`);
  }

  toString() { return `${"Editor".padEnd(12)} ${this.id.padEnd(8)} ${stateColor[this.state]} ${this.state.padEnd(8)}` }
  toDetailString() {
    return `
${"ID".padEnd(5)} ${this.id}
${"State".padEnd(5)} ${stateColor[this.state]} ${this.state.padEnd(11)}
${"UpdatedAt".padEnd(10)} ${this.updatedAt.toLocaleString().padEnd(11)}
${"CreatedAt".padEnd(10)} ${this.createdAt.toLocaleString().padEnd(11)}
`
  }
}
