import type { RowDataPacket } from "mysql2";
import path from "node:path";
import { ContentCreator } from "./contentCreator.ts";
import { Entity, randomID, type EntityData } from "./db.ts";
import { compileVideo } from "./ffmpeg.ts";
import { Media } from "./media.ts";
import { fetchPexelsClip, fetchPixabayClip, synthesizeVoiceover } from "./mediaSources.ts";
import { Video } from "./video.ts";
import { Ollama } from "ollama";

function mediaDir() { return process.env.MEDIA_DIR ?? "./media"; }

type EditorModel = "gemma4:latest";
type Message = { role: "system" | "user" | "assistant"; content: string };
const MAX_EDIT_STEPS = 8;

const editorSystemPrompt = (task: string) => `
YOU ARE AN EXPERIENCED VIDEO EDITOR.
YOUR JOB IS TO ASSEMBLE A SHORT VIDEO FOR THE FOLLOWING TASK, GIVEN TO YOU BY YOUR CONTENT CREATOR:
${task}

YOU HAVE THE ABILITY TO RUN COMMANDS TO GATHER MEDIA AND ASSEMBLE THE VIDEO.
COMMANDS MUST BE FORMATTED EXACTLY LIKE THIS, WITH THE COMMAND NAME ON ITS OWN LINE:
INVOKE: PEXELS CLIP
a cat playing piano
END_INVOKE

COMMAND DICTIONARY
PEXELS CLIP <search query> - add a licensed stock video clip
PIXABAY CLIP <search query> - add a licensed stock video clip
VOICEOVER <script text> - add a narrated voiceover track
COMPILE - assemble all added media into the final video and finish
`;

export type EditorState = "online" | "starting" | "offline" | "shuttingDown" | "stuck";
interface EditorData extends EntityData {
  contentCreatorID?: string;
  state: EditorState;
}

const stateColor = {
  online: "{green-bg} {/green-bg}",
  starting: "{blue-bg} {/blue-bg}",
  offline: "{black-bg} {/black-bg}",
  shuttingDown: "{red-bg} {/red-bg}",
  stuck: "{yellow-bg} {/yellow-bg}",
}

export class Editor extends Entity<EditorData> {
  static table = "editors";
  private ollama: Ollama = new Ollama();
  private currentStream: { abort: () => void } | null = null;
  private model: EditorModel = "gemma4:latest";
  private activeVideo: Video | undefined;
  history: Message[] = [];

  contentCreator: ContentCreator | undefined;
  async setContentCreator(cc: any) {
    this.contentCreator = cc;
    await this.set("contentCreatorID", cc.id);
  }

  videos: (Video | undefined)[] = [];
  async loadVideos() {
    const [rows] = await this.pool.query<RowDataPacket[]>(`SELECT id FROM ${Video.table} WHERE editorID = ? AND deletedAt IS NULL`, [this.id]);
    this.videos = await Promise.all(rows.map(async (v) => await Video.load(v.id)));
  }

  async addVideo(video: Video) {
    await video.setEditor(this);
    this.videos.push(video);
    this.notify("change");
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

    const destPath = path.join(mediaDir(), video.id, `${media.id}.wav`);
    await synthesizeVoiceover(text, destPath);
    await media.setLocalPath(destPath);

    await video.addMedia(media);
    return media;
  }

  async compile(video: Video): Promise<string> {
    await video.loadMedia();

    const clips = video.media
      .filter((m): m is Media => m !== undefined && m.kind === "clip")
      .sort((a, b) => a.position - b.position);
    const audio = video.media.find((m): m is Media => m !== undefined && m.kind === "audio");

    if (!clips.length) throw new Error(`Video(${video.id}) has no clips to compile`);
    const clipPaths = clips.map((c) => c.localPath);
    if (clipPaths.some((p) => !p)) throw new Error(`Video(${video.id}) has a clip with no downloaded media`);

    const outputPath = path.join(mediaDir(), `${video.id}.mp4`);
    await compileVideo(clipPaths as string[], audio?.localPath, outputPath);

    await video.setState("completed");
    return outputPath;
  }

  async createVideo(task: string): Promise<Video> {
    if (this.state !== "online") throw new Error(`Editor(${this.id}) must be online to create a video`);

    const video = await Video.load(randomID());
    if (!video) throw new Error(`Failed to create new Video`);
    await this.addVideo(video);
    await video.setPrompt(task);

    this.activeVideo = video;
    this.history = [];

    let message = editorSystemPrompt(task);
    for (let step = 0; step < MAX_EDIT_STEPS; step++) {
      if (this.state !== "online") break;
      const done = await this.think(message);
      if (done) break;
      message = "Continue.";
    }

    this.activeVideo = undefined;
    return video;
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
    let done = false;
    if (invokeMatch) {
      const name = (invokeMatch[1] ?? "").trim().toUpperCase();
      const context = (invokeMatch[2] ?? "").trim();
      const result = await this.runCommand(name, context);
      this.history.push({ role: "user", content: `[${name}] ${result}` });
      done = name === "COMPILE";
    }

    this.notify("change");
    return done;
  }

  private async runCommand(name: string, context: string): Promise<string> {
    const video = this.activeVideo;
    if (!video) return "No active Video";

    try {
      switch (name) {
        case "PEXELS CLIP": {
          const media = await this.addPexelsClip(video, context);
          return `Added Pexels clip(${media.id}) for "${context}"`;
        }
        case "PIXABAY CLIP": {
          const media = await this.addPixabayClip(video, context);
          return `Added Pixabay clip(${media.id}) for "${context}"`;
        }
        case "VOICEOVER": {
          const media = await this.addVoiceover(video, context);
          return `Added voiceover(${media.id})`;
        }
        case "COMPILE": {
          const outputPath = await this.compile(video);
          return `Compiled -> ${outputPath}`;
        }
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

  get state() { return this.data.state }
  async setState(s: EditorState) { this.data.state = s; await this.set("state", s); }

  async onLoad() {
    this.contentCreator = await ContentCreator.load(this.data.contentCreatorID);
    await this.loadVideos();
  }

  async shutdown() {
    console.log(`Editor(${this.id}) Shutting Down...`);
    await this.setState("shuttingDown");
    this.interrupt();
    await this.setState("offline");
    console.log(`Editor(${this.id}) Offline`);
  }

  async start() {
    if (this.contentCreator && this.contentCreator?.state !== "online") {
      console.log(`Editor(${this.id}) Start Failed : Content Creator is not Online`);
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
