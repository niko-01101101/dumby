import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";

const YOUTUBE_UPLOAD_SCOPE = "https://www.googleapis.com/auth/youtube.upload";
const OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export function buildAuthURL(redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: requireEnv("YOUTUBE_OAUTH_CLIENT_ID"),
    redirect_uri: redirectUri,
    response_type: "code",
    scope: YOUTUBE_UPLOAD_SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

// Google's OAuth "Desktop app" client type allows a redirect_uri of
// http://127.0.0.1:<any port>/... without pre-registering the port (RFC
// 8252 loopback flow) — the same mechanism gcloud/aws-cli use. Their older
// manual-code-paste ("out of band") flow is deprecated and unavailable to
// new OAuth clients, so this loopback server is the only viable way to
// complete this exchange, not just a style choice.
export async function startLoopbackServer(): Promise<{ redirectUri: string; waitForCode: (expectedState: string) => Promise<string>; close: () => void }> {
  let resolveCode: ((code: string) => void) | undefined;
  let rejectCode: ((err: Error) => void) | undefined;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/oauth2callback") {
      res.writeHead(404).end();
      return;
    }
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(error
      ? `<html><body>Authorization failed: ${error}. You can close this tab.</body></html>`
      : `<html><body>Authorization received. You can close this tab.</body></html>`);

    if (error) {
      rejectCode?.(new Error(`YouTube authorization failed: ${error}`));
    } else if (!code || !state) {
      rejectCode?.(new Error("YouTube authorization callback missing code/state"));
    } else {
      resolveCode?.(JSON.stringify({ code, state }));
    }
  });

  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });

  return {
    redirectUri: `http://127.0.0.1:${port}/oauth2callback`,
    waitForCode: (expectedState: string) => {
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timed out waiting for YouTube OAuth consent")), OAUTH_CALLBACK_TIMEOUT_MS);
        resolveCode = (raw) => {
          clearTimeout(timer);
          const { code, state } = JSON.parse(raw) as { code: string; state: string };
          if (state !== expectedState) {
            reject(new Error("YouTube OAuth state mismatch — possible CSRF, aborting"));
            return;
          }
          resolve(code);
        };
        rejectCode = (err) => { clearTimeout(timer); reject(err); };
      });
    },
    close: () => server.close(),
  };
}

export function randomOAuthState(): string {
  return randomBytes(16).toString("hex");
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

export async function exchangeCodeForTokens(code: string, redirectUri: string): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: requireEnv("YOUTUBE_OAUTH_CLIENT_ID"),
      client_secret: requireEnv("YOUTUBE_OAUTH_CLIENT_SECRET"),
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });
  if (!res.ok) throw new Error(`YouTube token exchange failed: ${res.status} ${await res.text()}`);
  const data = await res.json() as TokenResponse;
  if (!data.refresh_token) throw new Error("YouTube token exchange did not return a refresh_token — retry with prompt=consent");
  return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresIn: data.expires_in };
}

export async function refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; expiresIn: number }> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: requireEnv("YOUTUBE_OAUTH_CLIENT_ID"),
      client_secret: requireEnv("YOUTUBE_OAUTH_CLIENT_SECRET"),
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`YouTube token refresh failed: ${res.status} ${await res.text()}`);
  const data = await res.json() as TokenResponse;
  return { accessToken: data.access_token, expiresIn: data.expires_in };
}

export async function fetchChannelInfo(accessToken: string): Promise<{ channelId: string; channelTitle: string }> {
  const res = await fetch("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`YouTube channel lookup failed: ${res.status} ${await res.text()}`);
  const data = await res.json() as { items?: { id: string; snippet: { title: string } }[] };
  const channel = data.items?.[0];
  if (!channel) throw new Error("YouTube account has no channel to upload to");
  return { channelId: channel.id, channelTitle: channel.snippet.title };
}

export type PrivacyStatus = "public" | "unlisted" | "private";

// Single-shot resumable upload: short-form clips are small enough to buffer
// whole, so this skips chunking (which the protocol supports but doesn't
// require) — one POST to open the session, one PUT with the whole file.
export async function uploadVideo(
  accessToken: string,
  localPath: string,
  meta: { title: string; description: string; privacyStatus: PrivacyStatus },
): Promise<{ videoId: string }> {
  const initRes = await fetch("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "X-Upload-Content-Type": "video/mp4",
    },
    body: JSON.stringify({
      snippet: { title: meta.title, description: meta.description },
      status: { privacyStatus: meta.privacyStatus },
    }),
  });
  if (!initRes.ok) throw new Error(`YouTube upload session init failed: ${initRes.status} ${await initRes.text()}`);
  const uploadUrl = initRes.headers.get("location");
  if (!uploadUrl) throw new Error("YouTube upload session did not return a resumable upload URL");

  const fileBuffer = await readFile(localPath);
  const putRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(fileBuffer.length),
    },
    body: fileBuffer,
  });
  if (!putRes.ok) throw new Error(`YouTube upload failed: ${putRes.status} ${await putRes.text()}`);
  const data = await putRes.json() as { id: string };
  return { videoId: data.id };
}
