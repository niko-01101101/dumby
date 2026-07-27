import type { RowDataPacket } from "mysql2";
import { Entity, type EntityData } from "./db.ts";
import { ContentCreator } from "./contentCreator.ts";
import { Video } from "./video.ts";
import { platformLabel, type Platform } from "./platforms.ts";

interface AccountData extends EntityData {
  contentCreatorID?: string;
  platform: Platform;
  contentDescription?: string;
}

export class Account extends Entity<AccountData> {
  static table = "accounts";

  contentCreator: ContentCreator | undefined;
  async setContentCreator(cc: ContentCreator) {
    this.contentCreator = cc;
    await this.set("contentCreatorID", cc.id);
  }

  get platform() { return this.data.platform }
  async setPlatform(p: Platform) { await this.set("platform", p) }

  get contentDescription() { return this.data.contentDescription }
  async setContentDescription(d: string) { await this.set("contentDescription", d) }

  videos: (Video | undefined)[] = [];
  async loadVideos() {
    const [rows] = await this.pool.query<RowDataPacket[]>(`SELECT id FROM ${Video.table} WHERE accountID = ? AND deletedAt IS NULL`, [this.id]);
    this.videos = await Promise.all(rows.map(async (v) => await Video.load(v.id)));
  }

  async addVideo(video: Video) {
    await video.setAccount(this);
    this.videos.push(video);
    this.notify("change");
  }

  removeVideoFromList(video: Video) {
    this.videos = this.videos.filter((v) => v !== video);
    this.notify("change");
  }

  async loadDeletedVideos(): Promise<Video[]> {
    return Video.loadDeletedByColumn("accountID", this.id);
  }

  async onLoad() {
    this.contentCreator = await ContentCreator.load(this.data.contentCreatorID);
    await this.loadVideos();
  }

  toString() { return `${"Account".padEnd(12)} ${this.id.padEnd(8)} ${platformLabel(this.platform).padEnd(16)} ${(this.contentDescription ?? "").slice(0, 30)}` }
  toDetailString() {
    return `
${"ID".padEnd(11)} ${this.id}
${"Platform".padEnd(11)} ${platformLabel(this.platform)}
${"Content".padEnd(11)} ${this.contentDescription ?? "(none yet)"}
${"UpdatedAt".padEnd(11)} ${this.updatedAt.toLocaleString()}
${"CreatedAt".padEnd(11)} ${this.createdAt.toLocaleString()}
`
  }
}
