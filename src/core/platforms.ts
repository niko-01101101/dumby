// Fundamentals base for todo.txt #6: the shared vocabulary + extension point
// every Account/publishing feature builds on, without pretending to already
// have working OAuth/upload integrations for any of the three platforms —
// none of that exists yet, and faking it would be worse than not having it.

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

// Deliberately unimplemented: uploading real video to any of these three
// requires that platform's OAuth app registration + user consent flow (see
// CLAUDE.md's note on why Reddit was dropped for exactly this class of
// problem — self-serve app registration/approval is often the actual
// blocker, not the upload API itself). Video.state has a "posted" value with
// nothing that sets it yet; this is the single place that will need to fill
// in once real credentials/upload flows exist for a given platform, so
// callers (Editor/CLI) have one function to call rather than three
// platform-specific ones scattered around.
export async function publishVideo(platform: Platform, _localVideoPath: string): Promise<never> {
  throw new Error(
    `Publishing to ${platformLabel(platform)} is not implemented yet — needs that platform's API credentials/OAuth flow wired up first.`
  );
}
