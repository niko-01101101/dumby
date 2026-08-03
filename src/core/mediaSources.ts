import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`[ERROR] Missing required env var: ${name}`);
  return value;
}

// None of fetch()'s calls here had any timeout — a stalled connection (server
// accepts but never finishes responding) hangs the awaiting command forever
// with no error, which from the AI loop's perspective looks like it just
// stopped mid-turn rather than failing. Search/API calls should be quick;
// the actual clip download gets more room since it's transferring real bytes.
const API_FETCH_TIMEOUT_MS = 20_000;
const DOWNLOAD_TIMEOUT_MS = 2 * 60 * 1000;

async function downloadToFile(url: string, destPath: string): Promise<void> {
  await mkdir(dirname(destPath), { recursive: true });
  const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok || !res.body) throw new Error(`Failed to download ${url}: ${res.status} ${res.statusText}`);
  await pipeline(Readable.fromWeb(res.body as any), createWriteStream(destPath));
}

interface PexelsVideoFile { link: string; quality: string; }
interface PexelsVideo { id: number; video_files: PexelsVideoFile[]; }
interface PexelsSearchResponse { videos: PexelsVideo[]; }

export async function fetchPexelsClip(query: string, destPath: string): Promise<void> {
  const apiKey = requireEnv("PEXELS_API_KEY");
  // Short-form output is a vertical 1080x1920 canvas (see ffmpeg.ts) — asking
  // Pexels for portrait-shot source footage up front means less of the frame
  // has to be cropped away to fill it, instead of relying entirely on the
  // compile-time crop to fix up whatever orientation happened to come back.
  const url = `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=1&orientation=portrait`;
  const res = await fetch(url, { headers: { Authorization: apiKey }, signal: AbortSignal.timeout(API_FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Pexels search failed: ${res.status} ${res.statusText}`);

  const data = await res.json() as PexelsSearchResponse;
  const video = data.videos[0];
  if (!video) throw new Error(`Pexels returned no results for "${query}"`);
  const file = video.video_files.find((f) => f.quality === "hd") ?? video.video_files[0];
  if (!file) throw new Error(`Pexels video ${video.id} has no downloadable files`);

  await downloadToFile(file.link, destPath);
}

interface PixabayHit { id: number; videos: { medium?: { url: string }; small?: { url: string } }; }
interface PixabaySearchResponse { hits: PixabayHit[]; }

export async function fetchPixabayClip(query: string, destPath: string): Promise<void> {
  const apiKey = requireEnv("PIXABAY_API_KEY");
  const url = `https://pixabay.com/api/videos/?key=${apiKey}&q=${encodeURIComponent(query)}&per_page=3`;
  const res = await fetch(url, { signal: AbortSignal.timeout(API_FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Pixabay search failed: ${res.status} ${res.statusText}`);

  const data = await res.json() as PixabaySearchResponse;
  const hit = data.hits[0];
  if (!hit) throw new Error(`Pixabay returned no results for "${query}"`);
  const file = hit.videos.medium ?? hit.videos.small;
  if (!file) throw new Error(`Pixabay video ${hit.id} has no downloadable files`);

  await downloadToFile(file.url, destPath);
}

interface FreesoundResult { id: number; previews: Record<string, string>; duration: number; }
interface FreesoundSearchResponse { results: FreesoundResult[]; }

// Freesound is a sound-effects/field-recordings library first and a music
// library second, so results for a mood/genre query are hit-or-miss compared
// to a curated music service — it was picked anyway because, like
// Pexels/Pixabay for video, it's keyed search with no OAuth dance: the normal
// full-quality download endpoint requires an OAuth2 user token, but the
// "previews" (a standard set of lower-bitrate transcodes Freesound generates
// for every upload, meant for in-browser playback before download) are public
// CDN URLs servable with just the api key used for search — good enough
// quality for background music sitting under other audio in a short-form video.
const durationFilter = "duration:[15 TO 300]";

export async function fetchFreesoundMusic(query: string, destPath: string): Promise<void> {
  const apiKey = requireEnv("FREESOUND_API_KEY");
  const url = `https://freesound.org/apiv2/search/text/?query=${encodeURIComponent(query)}&token=${apiKey}&fields=id,previews,duration&filter=${encodeURIComponent(durationFilter)}&sort=score`;
  const res = await fetch(url, { signal: AbortSignal.timeout(API_FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Freesound search failed: ${res.status} ${res.statusText}`);

  const data = await res.json() as FreesoundSearchResponse;
  const sound = data.results[0];
  if (!sound) throw new Error(`Freesound returned no results for "${query}"`);
  const previewUrl = sound.previews["preview-hq-mp3"] ?? sound.previews["preview-lq-mp3"];
  if (!previewUrl) throw new Error(`Freesound sound ${sound.id} has no downloadable preview`);

  await downloadToFile(previewUrl, destPath);
}

// Twitch gameplay clips, added to the Editor's toolkit alongside Pexels/
// Pixabay stock footage for tasks that call for actual game footage rather
// than generic B-roll — neither stock service indexes real gameplay.
// Twitch's Helix API needs an app access token (client-credentials grant),
// not a user OAuth login: same "keyed search, no OAuth dance" shape as
// Pexels/Pixabay/Freesound above, just with an extra token-fetch step, since
// Helix doesn't accept the client id/secret directly on each request.
interface TwitchToken { token: string; expiresAt: number; }
let twitchToken: TwitchToken | undefined;

async function getTwitchAppToken(): Promise<string> {
  if (twitchToken && twitchToken.expiresAt > Date.now()) return twitchToken.token;

  const clientId = requireEnv("TWITCH_CLIENT_ID");
  const clientSecret = requireEnv("TWITCH_CLIENT_SECRET");
  const url = `https://id.twitch.tv/oauth2/token?client_id=${clientId}&client_secret=${clientSecret}&grant_type=client_credentials`;
  const res = await fetch(url, { method: "POST", signal: AbortSignal.timeout(API_FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Twitch app token request failed: ${res.status} ${res.statusText}`);

  const data = await res.json() as { access_token: string; expires_in: number };
  // Refresh a minute early rather than exactly on expiry, so a token that's
  // about to lapse mid-request doesn't get reused right up to the wire.
  twitchToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  return twitchToken.token;
}

function twitchAuthHeaders(clientId: string, token: string): Record<string, string> {
  return { "Client-Id": clientId, Authorization: `Bearer ${token}` };
}

interface TwitchGame { id: string; }
interface TwitchGamesResponse { data: TwitchGame[]; }
interface TwitchClip { id: string; thumbnail_url: string; }
interface TwitchClipsResponse { data: TwitchClip[]; }

// A clip's downloadable .mp4 isn't in the API response directly — Twitch
// derives it from the thumbnail URL by dropping the "-preview-<WxH>.jpg"
// suffix and appending ".mp4", a widely-relied-on convention rather than a
// documented field (Helix's own "get clip" response only ever exposes the
// thumbnail and an embeddable player URL, not a raw file).
function clipDownloadUrl(thumbnailUrl: string): string {
  return `${thumbnailUrl.replace(/-preview-\d+x\d+\.jpg$/, "")}.mp4`;
}

export async function fetchTwitchGameplayClip(query: string, destPath: string): Promise<void> {
  const clientId = requireEnv("TWITCH_CLIENT_ID");
  const token = await getTwitchAppToken();
  const headers = twitchAuthHeaders(clientId, token);

  const gameRes = await fetch(`https://api.twitch.tv/helix/games?name=${encodeURIComponent(query)}`, {
    headers,
    signal: AbortSignal.timeout(API_FETCH_TIMEOUT_MS),
  });
  if (!gameRes.ok) throw new Error(`Twitch game lookup failed: ${gameRes.status} ${gameRes.statusText}`);
  const gameData = await gameRes.json() as TwitchGamesResponse;
  const game = gameData.data[0];
  if (!game) throw new Error(`Twitch has no game matching "${query}"`);

  const clipsRes = await fetch(`https://api.twitch.tv/helix/clips?game_id=${game.id}&first=1`, {
    headers,
    signal: AbortSignal.timeout(API_FETCH_TIMEOUT_MS),
  });
  if (!clipsRes.ok) throw new Error(`Twitch clip search failed: ${clipsRes.status} ${clipsRes.statusText}`);
  const clipsData = await clipsRes.json() as TwitchClipsResponse;
  const clip = clipsData.data[0];
  if (!clip) throw new Error(`Twitch returned no clips for "${query}"`);

  await downloadToFile(clipDownloadUrl(clip.thumbnail_url), destPath);
}

// Nothing bounds how long a model's reply can get (no token limit is set on
// the Ollama chat calls in ContentCreator/Editor), and VOICEOVER hands that
// reply straight to the TTS engine as narration text. A stuck/repetitive
// model could hand it an enormous script, which would otherwise just run —
// however long that takes — with no feedback until it's done. This timeout
// turns an unbounded synthesis into a clear, bounded failure instead.
const PIPER_TIMEOUT_MS = 2 * 60 * 1000;

async function synthesizeWithPiper(text: string, destPath: string): Promise<void> {
  await mkdir(dirname(destPath), { recursive: true });
  const bin = process.env.PIPER_BIN ?? "piper";
  const model = requireEnv("PIPER_VOICE_MODEL");

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(bin, ["--model", model, "--output_file", destPath]);
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, PIPER_TIMEOUT_MS);
    proc.stderr.on("data", (chunk) => { stderr += chunk; });
    proc.on("error", (err) => { clearTimeout(timer); reject(err); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`piper timed out after ${PIPER_TIMEOUT_MS}ms (script too long?)`));
      else if (code === 0) resolve();
      else reject(new Error(`piper exited with code ${code}: ${stderr}`));
    });
    proc.stdin.write(text);
    proc.stdin.end();
  });
}

// Google Cloud Text-to-Speech — default voiceover engine (see CLAUDE.md).
// Called directly via its REST API with an API key (same convention as
// Gemini in llm.ts and the Pexels/Pixabay/Freesound fetchers above) rather
// than the `@google-cloud/text-to-speech` SDK, so this stays a plain-`fetch`
// dependency like the rest of the file. Needs the Cloud Text-to-Speech API
// enabled on whatever GCP project `GOOGLE_TTS_API_KEY` belongs to — that can
// be the same key/project already used for `GEMINI_API_KEY`, or a separate
// one; a distinct env var is used either way so one key's quota isn't
// silently shared across two unrelated services.
//
// `audioEncoding: "LINEAR16"` is requested specifically because Google's
// synthesize endpoint wraps LINEAR16 PCM in a WAV container automatically —
// matching the .wav Piper already produces means callers don't need to know
// or care which engine actually ran.
//
// A 429 here is Google Cloud's standard quota-exceeded response (same shape
// as Gemini's in llm.ts). Treated as "free-tier quota exhausted for this
// key" and made sticky for the rest of the process (see `synthesizeVoiceover`
// below) — retrying a known-exhausted quota on every voiceover would just be
// another way to burn through whatever's left of it.
class GoogleTtsQuotaError extends Error { }
let googleTtsExhausted = false;

function googleTtsVoice(): string {
  return process.env.GOOGLE_TTS_VOICE ?? "en-US-Neural2-C";
}

// Google wants languageCode ("en-US") separately from the voice name
// ("en-US-Neural2-C") that already encodes it — derived here so overriding
// GOOGLE_TTS_VOICE doesn't also require setting a second, redundant env var.
function googleTtsLanguageCode(voice: string): string {
  const [lang, region] = voice.split("-");
  return lang && region ? `${lang}-${region}` : "en-US";
}

interface GoogleTtsResponse { audioContent?: string; }

async function synthesizeWithGoogleTts(text: string, destPath: string): Promise<void> {
  const apiKey = requireEnv("GOOGLE_TTS_API_KEY");
  const voice = googleTtsVoice();
  const url = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode: googleTtsLanguageCode(voice), name: voice },
      audioConfig: { audioEncoding: "LINEAR16" },
    }),
    signal: AbortSignal.timeout(API_FETCH_TIMEOUT_MS),
  });

  if (res.status === 429) throw new GoogleTtsQuotaError("Google Cloud TTS quota exhausted (429)");
  if (!res.ok) throw new Error(`Google Cloud TTS request failed: ${res.status} ${res.statusText}`);

  const data = await res.json() as GoogleTtsResponse;
  if (!data.audioContent) throw new Error("Google Cloud TTS returned no audio content");

  await mkdir(dirname(destPath), { recursive: true });
  await writeFile(destPath, Buffer.from(data.audioContent, "base64"));
}

export type VoiceoverEngine = "google-tts" | "piper";

// Tries Google Cloud TTS first (if GOOGLE_TTS_API_KEY is set and not yet
// known to be quota-exhausted), falling back to local Piper — mirrors
// llm.ts's chat()/Gemini-then-Ollama pattern exactly, including the sticky
// exhausted flag. Returns which engine actually produced the audio so
// callers can record it on the Media row rather than assuming Piper.
export async function synthesizeVoiceover(text: string, destPath: string): Promise<VoiceoverEngine> {
  if (process.env.GOOGLE_TTS_API_KEY && !googleTtsExhausted) {
    try {
      await synthesizeWithGoogleTts(text, destPath);
      return "google-tts";
    } catch (e) {
      if (e instanceof GoogleTtsQuotaError) {
        googleTtsExhausted = true;
        console.error(`${e.message} — falling back to local Piper for the rest of this run.`);
      } else {
        throw e;
      }
    }
  }
  await synthesizeWithPiper(text, destPath);
  return "piper";
}
