import { Entity, type EntityData } from "./db.ts";
import { Video } from "./video.ts";

export type MediaKind = "clip" | "image" | "audio";
export type MediaSourceType = "generated" | "pexels" | "pixabay" | "twitch" | "piper" | "google-tts" | "freesound";

interface MediaData extends EntityData {
  videoID?: string;
  kind: MediaKind;
  source: MediaSourceType;
  sourceRef?: string;
  localPath?: string;
  position: number;
}

export class Media extends Entity<MediaData> {
  static table = "media";

  video: Video | undefined;
  async setVideo(video: Video) {
    this.video = video;
    await this.set("videoID", video.id);
  }

  get kind() { return this.data.kind }
  get source() { return this.data.source }
  get sourceRef() { return this.data.sourceRef }
  get localPath() { return this.data.localPath }
  get position() { return this.data.position }

  async setKind(kind: MediaKind) { this.data.kind = kind; await this.set("kind", kind); }
  async setSource(source: MediaSourceType) { this.data.source = source; await this.set("source", source); }
  async setSourceRef(ref: string) { this.data.sourceRef = ref; await this.set("sourceRef", ref); }
  async setLocalPath(path: string) { this.data.localPath = path; await this.set("localPath", path); }
  async setPosition(position: number) { this.data.position = position; await this.set("position", position); }

  async onLoad() {
    this.video = await Video.load(this.data.videoID);
  }

  toString() { return `${"Media".padEnd(12)} ${this.id.padEnd(8)} ${this.kind.padEnd(6)} ${this.source}` }
}
