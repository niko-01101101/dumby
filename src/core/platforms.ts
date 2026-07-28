// Fundamentals base for todo.txt #6: the shared vocabulary + extension point
// every Account/publishing feature builds on.

import path from "node:path";
import type { Account } from "./account.ts";
import type { Video } from "./video.ts";
import { uploadVideo } from "./youtube.ts";

function mediaDir() { return process.env.MEDIA_DIR ?? "./media"; }

export const PLATFORMS = ["youtube", "tiktok", "instagram_reels"] as const;
export type Platform = typeof PLATFORMS[number];

export function isPlatform(value: string): value is Platform {
  return (PLATFORMS as readonly string[]).includes(value);
}

export function platformLabel(platform: Platform): string {
  switch (platform) {
    case "youtube": return "YouTube";
    case "tiktok": return "TikTok";
    case "instagram_reels": return "Instagram Reels";
  }
}

// The single seam callers (ContentCreator/CLI) go through to publish,
// rather than three platform-specific upload functions scattered around.
// YouTube is wired up (needs the Account already connected via
// Account.connectYouTube()); TikTok/Instagram Reels still need that
// platform's own OAuth app registration + upload API before they can follow
// the same pattern (see CLAUDE.md's note on why Reddit was dropped for
// exactly this class of problem — self-serve app registration/approval is
// often the actual blocker, not the upload API itself).
export async function publishVideo(account: Account, video: Video): Promise<{ videoId: string; url: string }> {
  if (account.platform !== "youtube") {
    throw new Error(
      `Publishing to ${platformLabel(account.platform)} is not implemented yet — needs that platform's API credentials/OAuth flow wired up first.`
    );
  }

  const accessToken = await account.getValidAccessToken();
  const localPath = path.join(mediaDir(), `${video.id}.mp4`);
  const { videoId } = await uploadVideo(accessToken, localPath, {
    title: (video.prompt ?? "Untitled").slice(0, 95),
    description: video.prompt ?? "",
    privacyStatus: "public",
  });

  const url = `https://youtu.be/${videoId}`;
  await video.setPostedUrl(url);
  await video.setState("posted");
  return { videoId, url };
}
