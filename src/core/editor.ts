import path from "node:path";
import type { Account } from "./account.ts";
import { Manager } from "./manager.ts";
import { Entity, randomID, type EntityData } from "./db.ts";
import { compileVideo, type CompileAudio } from "./ffmpeg.ts";
import { Media } from "./media.ts";
import { fetchFreesoundMusic, fetchPexelsClip, fetchPixabayClip, synthesizeVoiceover } from "./mediaSources.ts";
import { Video } from "./video.ts";
import { chat } from "./llm.ts";

function mediaDir() { return process.env.MEDIA_DIR ?? "./media"; }

// Piper reads voiceover text aloud verbatim, so strip any tone/stage
// directions the model adds despite the system prompt (e.g. "(cheerfully)",
// "[upbeat tone]", "*excited*") before it's spoken as text.
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
const MAX_EDIT_STEPS = 8;
const THINK_TIMEOUT_MS = 3 * 60 * 1000;
// Short-form narration should be a few sentences at most. Nothing caps how
// long a model's reply can get (no token limit is set on the Ollama chat
// call below), so without this a stuck/repetitive model could hand Piper an
// arbitrarily long script and produce an arbitrarily long voiceover track.
const MAX_VOICEOVER_CHARS = 1000;

const KNOWN_COMMANDS = ["PEXELS CLIP", "PIXABAY CLIP", "VOICEOVER", "MUSIC", "COMPILE"]
  .sort((a, b) => b.length - a.length);

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

// Falls back to a bare command name (e.g. "COMPILE") when the model skips
// the INVOKE:/END_INVOKE wrapper entirely — small local models often echo
// the "AVAILABLE COMMANDS" list's own syntax as plain prose instead of using
// the format. Without this the attempt is silently discarded and the model
// just gets a CONTINUE_REMINDER as if it had said nothing at all.
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
// Unlike ContentCreator's loop, omitting an INVOKE block here does NOT end
// the session cleanly — only COMPILE is treated as terminal (see think()
// below) — so this reminder pushes toward finishing, not stopping.
const CONTINUE_REMINDER = `Continue. Reminder: to run a command, respond with:
INVOKE: <COMMAND NAME>
<input, if the command takes any>
END_INVOKE
Include at most one INVOKE block. You must call COMPILE to finish — stopping without it, or running out of turns, abandons the video.`;

const editorSystemPrompt = (task: string) => `
YOU ARE AN EXPERIENCED VIDEO EDITOR.
YOUR JOB IS TO ASSEMBLE A SHORT VIDEO FOR THE FOLLOWING TASK, GIVEN TO YOU BY YOUR CONTENT CREATOR:
${task}

YOU HAVE THE ABILITY TO RUN COMMANDS TO GATHER MEDIA AND ASSEMBLE THE VIDEO. FOLLOW THESE RULES EXACTLY:
- INCLUDE AT MOST ONE INVOKE BLOCK PER RESPONSE. ANYTHING AFTER THE FIRST IS IGNORED.
- THE COMMAND NAME MUST BE SPELLED EXACTLY AS LISTED BELOW, ON ITS OWN LINE.
- YOU MUST CALL COMPILE TO FINISH. IT IS THE ONLY WAY YOUR WORK IS SAVED — IF YOU STOP WITHOUT IT, THE VIDEO IS ABANDONED.

COMMANDS ARE FORMATTED EXACTLY LIKE THIS, WITH THE COMMAND NAME ON ITS OWN LINE:
INVOKE: PEXELS CLIP
a cat playing piano
END_INVOKE

AVAILABLE COMMANDS
PEXELS CLIP <search query> - add a licensed stock video clip
PIXABAY CLIP <search query> - add a licensed stock video clip
VOICEOVER <script text> - add a narrated voiceover track. THE SCRIPT TEXT IS SPOKEN ALOUD EXACTLY AS WRITTEN, WORD FOR WORD, BY A TEXT-TO-SPEECH ENGINE. DO NOT INCLUDE TONE, STYLE, OR STAGE DIRECTIONS (e.g. "(cheerfully)", "[upbeat tone]", "*excited*") OR ANY OTHER TEXT THAT ISN'T MEANT TO BE SPOKEN OUT LOUD. ONLY WRITE THE WORDS TO BE NARRATED.
MUSIC <mood/genre query, e.g. "upbeat lofi", "tense cinematic"> - add a background music track. It plays under the whole video at low volume, automatically ducking further under any voiceover so narration stays clear. Optional, but adds a lot of production value. At most one per video.
COMPILE - assemble all added media into the final video. Call this once you have a handful of clips (typically 3-6 for a short-form video) and, if the task calls for narration, a voiceover. This is your last step.
`;

// "sleeping" (todo.txt #5) is entered once a video finishes (or is
// abandoned) and there's no next task queued yet — Manager.findAvailableEditor
// wakes a sleeping Editor back up (via start()) rather than skipping it, so
// it still counts as available to the pool, just not actively spending
// think() calls while idle.
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

  async addVoiceover(video: Video, text: string) {
    const media = await Media.load(randomID());
    if (!media) throw new Error(`Failed to create new Media`);
    await media.setKind("audio");
    await media.setSource("piper");
    await media.setSourceRef(text);

    const script = stripStageDirections(text);
    const destPath = path.join(mediaDir(), video.id, `${media.id}.wav`);
    await synthesizeVoiceover(script, destPath);
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

    const clips = video.media
      .filter((m): m is Media => m !== undefined && m.kind === "clip")
      .sort((a, b) => a.position - b.position);
    const voiceover = video.media.find((m): m is Media => m !== undefined && m.kind === "audio" && m.source === "piper");
    const music = video.media.find((m): m is Media => m !== undefined && m.kind === "audio" && m.source === "freesound");

    if (!clips.length) throw new Error(`Video(${video.id}) has no clips to compile`);
    const clipPaths = clips.map((c) => c.localPath);
    if (clipPaths.some((p) => !p)) throw new Error(`Video(${video.id}) has a clip with no downloaded media`);

    const outputPath = path.join(mediaDir(), `${video.id}.mp4`);
    const audio: CompileAudio = {};
    if (voiceover?.localPath) audio.voiceoverPath = voiceover.localPath;
    if (music?.localPath) audio.musicPath = music.localPath;
    await compileVideo(clipPaths as string[], audio, outputPath);

    await video.setState("completed");
    return outputPath;
  }

  async createVideo(account: Account, task: string): Promise<Video> {
    if (this.state !== "online") throw new Error(`Editor(${this.id}) must be online to create a video`);

    const video = await Video.load(randomID());
    if (!video) throw new Error(`Failed to create new Video`);
    await account.addVideo(video);
    await video.setPrompt(task);
    await video.setState("workingOn");

    this.activeVideo = video;
    this.history = [];

    try {
      let message = editorSystemPrompt(task);
      for (let step = 0; step < MAX_EDIT_STEPS; step++) {
        if (this.state !== "online") break;
        const done = await this.think(message);
        if (done) break;
        message = CONTINUE_REMINDER;
      }

      // The loop above only stops early on a successful COMPILE; if the model
      // spends its whole step budget gathering clips/voiceover (or rambling
      // without an INVOKE block, which doesn't end the loop early either) and
      // never gets to COMPILE, the gathered media would otherwise just be
      // discarded. Compile whatever was gathered rather than losing the work.
      if (video.state === "workingOn") {
        await video.loadMedia();
        const hasClip = video.media.some((m) => m?.kind === "clip");
        if (hasClip) await this.compile(video);
      }
    } finally {
      if (video.state === "workingOn") await video.setState("notStarted");
      this.activeVideo = undefined;
      // Done with this task and nothing else queued — sleep until the next
      // CREATE VIDEO wakes this Editor back up (see Manager.findAvailableEditor).
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
      // See ContentCreator.think() for why: unbounded history plus a small
      // default context window is a real way to blow the budget mid-session.
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
      // line itself (e.g. "INVOKE: COMPILE <nothing>") instead of leaving it
      // bare — an exact-string match on rawName would treat that as an
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

    let done = false;
    if (parsed) {
      const { message, ok } = await this.runCommand(parsed.name, parsed.context);
      this.history.push({ role: "user", content: `[${parsed.name}] ${message}` });
      done = parsed.name === "COMPILE" && ok;
    }

    this.notify("change");
    return done;
  }

  private async runCommand(name: string, context: string): Promise<{ message: string; ok: boolean }> {
    const video = this.activeVideo;
    if (!video) return { message: "No active Video", ok: false };

    try {
      switch (name) {
        case "PEXELS CLIP": {
          const media = await this.addPexelsClip(video, context);
          return { message: `Added Pexels clip(${media.id}) for "${context}"`, ok: true };
        }
        case "PIXABAY CLIP": {
          const media = await this.addPixabayClip(video, context);
          return { message: `Added Pixabay clip(${media.id}) for "${context}"`, ok: true };
        }
        case "VOICEOVER": {
          if (!context) return { message: "VOICEOVER requires script text", ok: false };
          if (context.length > MAX_VOICEOVER_CHARS) {
            return {
              message: `VOICEOVER script is ${context.length} characters, over the ${MAX_VOICEOVER_CHARS} limit for short-form narration — shorten it`,
              ok: false,
            };
          }
          const media = await this.addVoiceover(video, context);
          return { message: `Added voiceover(${media.id})`, ok: true };
        }
        case "MUSIC": {
          if (!context) return { message: "MUSIC requires a mood/genre query", ok: false };
          const media = await this.addMusic(video, context);
          return { message: `Added background music(${media.id}) for "${context}"`, ok: true };
        }
        case "COMPILE": {
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
