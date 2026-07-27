import type { RowDataPacket } from "mysql2";
import { Entity, type EntityData } from "./db.ts";
import { Account } from "./account.ts";
import { Media } from "./media.ts";

export type VideoState = "notStarted" | "workingOn" | "completed" | "posted";

interface VideoData extends EntityData {
  accountID?: string;
  prompt?: string;
  state: VideoState;
}

const stateColor = {
  notStarted: "{black-bg} {/black-bg}",
  workingOn: "{blue-bg} {/blue-bg}",
  completed: "{green-bg} {/green-bg}",
  posted: "{magenta-bg} {/magenta-bg}",
}

export class Video extends Entity<VideoData> {
  static table = "videos";

  account: Account | undefined;
  async setAccount(account: Account) {
    this.account = account;
    await this.set("accountID", account.id);
  }

  get state() { return this.data.state }
  async setState(s: VideoState) { this.data.state = s; await this.set("state", s) }

  get prompt() { return this.data.prompt }
  async setPrompt(p: string) { this.data.prompt = p; await this.set("prompt", p) }

  media: (Media | undefined)[] = [];
  async loadMedia() {
    const [rows] = await this.pool.query<RowDataPacket[]>(`SELECT id FROM ${Media.table} WHERE videoID = ? AND deletedAt IS NULL ORDER BY position ASC`, [this.id]);
    this.media = await Promise.all(rows.map(async (m) => await Media.load(m.id)));
  }

  async addMedia(media: Media) {
    await media.setVideo(this);
    await media.setPosition(this.media.length);
    this.media.push(media);
    this.notify("change");
  }

  async onLoad() {
    this.account = await Account.load(this.data.accountID);
    await this.loadMedia();
  }

  toString() { return `${"Video".padEnd(12)} ${this.id.padEnd(8)} ${stateColor[this.state]} ${this.state.padEnd(8)}` }
  toDetailString() {
    return `
${"ID".padEnd(5)} ${this.id}
${"State".padEnd(5)} ${stateColor[this.state]} ${this.state.padEnd(11)}
${"Prompt".padEnd(10)} ${this.prompt ?? ""}
${"UpdatedAt".padEnd(10)} ${this.updatedAt.toLocaleString().padEnd(11)}
${"CreatedAt".padEnd(10)} ${this.createdAt.toLocaleString().padEnd(11)}
`
  }
}
