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

async function downloadToFile(url: string, destPath: string): Promise<void> {
  await mkdir(dirname(destPath), { recursive: true });
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Failed to download ${url}: ${res.status} ${res.statusText}`);
  await pipeline(Readable.fromWeb(res.body as any), createWriteStream(destPath));
}

interface PexelsVideoFile { link: string; quality: string; }
interface PexelsVideo { id: number; video_files: PexelsVideoFile[]; }
interface PexelsSearchResponse { videos: PexelsVideo[]; }

export async function fetchPexelsClip(query: string, destPath: string): Promise<void> {
  const apiKey = requireEnv("PEXELS_API_KEY");
  const url = `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=1`;
  const res = await fetch(url, { headers: { Authorization: apiKey } });
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
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Pixabay search failed: ${res.status} ${res.statusText}`);

  const data = await res.json() as PixabaySearchResponse;
  const hit = data.hits[0];
  if (!hit) throw new Error(`Pixabay returned no results for "${query}"`);
  const file = hit.videos.medium ?? hit.videos.small;
  if (!file) throw new Error(`Pixabay video ${hit.id} has no downloadable files`);

  await downloadToFile(file.url, destPath);
}

export async function synthesizeVoiceover(text: string, destPath: string): Promise<void> {
  await mkdir(dirname(destPath), { recursive: true });
  const bin = process.env.PIPER_BIN ?? "piper";
  const model = requireEnv("PIPER_VOICE_MODEL");

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(bin, ["--model", model, "--output_file", destPath]);
    let stderr = "";
    proc.stderr.on("data", (chunk) => { stderr += chunk; });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`piper exited with code ${code}: ${stderr}`));
    });
    proc.stdin.write(text);
    proc.stdin.end();
  });
}
