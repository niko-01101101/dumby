import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
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
  const url = `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=1`;
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

// Nothing bounds how long a model's reply can get (no token limit is set on
// the Ollama chat calls in ContentCreator/Editor), and VOICEOVER hands that
// reply straight to Piper as narration text. A stuck/repetitive model could
// hand Piper an enormous script, which would otherwise just run — however
// long that takes — with no feedback until it's done. This timeout turns an
// unbounded synthesis into a clear, bounded failure instead.
const PIPER_TIMEOUT_MS = 2 * 60 * 1000;

export async function synthesizeVoiceover(text: string, destPath: string): Promise<void> {
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
