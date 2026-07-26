import { Entity, type EntityData } from "./db.ts";

export type VideoState = "notStarted" | "workingOn" | "completed" | "posted";
interface VideoData extends EntityData {
  contentCreatorID?: string;
  state: VideoState;
}

export class Video extends Entity<VideoData> {
  static table = "videos";

  private _contentCreator: any
  get contentCreator() { return this._contentCreator }

  async setContentCreator(cc: any) {
    this._contentCreator = cc;
    await this.set("contentCreatorID", cc.id);
  }

  get state() { return this.data.state }
  set state(s: VideoState) { this.data.state = s; void this.set("state", s) }

  async onLoad() {

  }

  toString() { return `${"Video".padEnd(12)} ${this.id.padEnd(8)} ${this.state.padEnd(8)}` };
}
