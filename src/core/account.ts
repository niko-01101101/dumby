import type { RowDataPacket } from "mysql2";
import { Entity, type EntityData } from "./db.ts";
import { ContentCreator } from "./contentCreator.ts";
import { Video } from "./video.ts";
import { platformLabel, type Platform } from "./platforms.ts";
import {
  buildAuthURL,
  exchangeCodeForTokens,
  fetchChannelInfo,
  randomOAuthState,
  refreshAccessToken,
  startLoopbackServer,
} from "./youtube.ts";

interface AccountData extends EntityData {
  contentCreatorID?: string;
  platform: Platform;
  contentDescription?: string;
  credentials?: string;
}

export interface YouTubeCredentials {
  refreshToken: string;
  accessToken: string;
  accessTokenExpiresAt: string;
  channelId: string;
  channelTitle: string;
}

// A safety buffer so a token isn't handed to a caller moments before it
// actually expires mid-request.
const TOKEN_EXPIRY_BUFFER_MS = 60_000;

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

  // Stored as manually (de)serialized JSON in a TEXT column, not a MySQL
  // JSON column — mysql2/sqlstring doesn't auto-stringify a plain object
  // passed through Entity.set()'s `?` placeholder the way a JSON column
  // would need, and no other table in this codebase uses one.
  get credentials(): YouTubeCredentials | undefined {
    if (!this.data.credentials) return undefined;
    return JSON.parse(this.data.credentials) as YouTubeCredentials;
  }
  async setCredentials(c: YouTubeCredentials) { await this.set("credentials", JSON.stringify(c)) }

  get isConnected() { return !!this.credentials?.refreshToken }

  // Human-driven by construction: opens a real Google consent screen in the
  // user's own browser. Never AI-invoked — only reachable from the CLI (see
  // cli/displays/account.ts's "Connect YouTube" action).
  async connectYouTube(): Promise<string> {
    if (this.platform !== "youtube") throw new Error(`Account(${this.id}) is not a YouTube account`);
    const server = await startLoopbackServer();
    try {
      const state = randomOAuthState();
      console.log(`Open this URL to connect Account(${this.id}) to YouTube:\n${buildAuthURL(server.redirectUri, state)}`);
      const code = await server.waitForCode(state);
      const { accessToken, refreshToken, expiresIn } = await exchangeCodeForTokens(code, server.redirectUri);
      const { channelId, channelTitle } = await fetchChannelInfo(accessToken);
      await this.setCredentials({
        refreshToken,
        accessToken,
        accessTokenExpiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
        channelId,
        channelTitle,
      });
      return `Account(${this.id}) connected to YouTube channel "${channelTitle}"`;
    } finally {
      server.close();
    }
  }

  async getValidAccessToken(): Promise<string> {
    const creds = this.credentials;
    if (!creds) throw new Error(`Account(${this.id}) is not connected to YouTube yet`);
    if (new Date(creds.accessTokenExpiresAt).getTime() - TOKEN_EXPIRY_BUFFER_MS > Date.now()) {
      return creds.accessToken;
    }
    const { accessToken, expiresIn } = await refreshAccessToken(creds.refreshToken);
    await this.setCredentials({
      ...creds,
      accessToken,
      accessTokenExpiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    });
    return accessToken;
  }

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
${"Connected".padEnd(11)} ${this.isConnected ? `Yes (channel: ${this.credentials?.channelTitle})` : "No"}
${"UpdatedAt".padEnd(11)} ${this.updatedAt.toLocaleString()}
${"CreatedAt".padEnd(11)} ${this.createdAt.toLocaleString()}
`
  }
}
