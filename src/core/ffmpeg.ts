import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

// Bounds how long a single compile can run — a malformed or absurdly long
// input (e.g. a corrupt clip, or audio far longer than intended) should fail
// clearly rather than run indefinitely with no feedback.
const FFMPEG_TIMEOUT_MS = 5 * 60 * 1000;

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args);
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, FFMPEG_TIMEOUT_MS);
    proc.stderr.on("data", (chunk) => { stderr += chunk; });
    proc.on("error", (err) => { clearTimeout(timer); reject(err); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`ffmpeg timed out after ${FFMPEG_TIMEOUT_MS}ms`));
      else if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr}`));
    });
  });
}

// Background music sits well under narration at roughly -12dB (amplitude
// ratio 0.25) before ducking kicks in further while the voiceover is
// speaking — loud enough to be felt, quiet enough to never compete with it.
const MUSIC_VOLUME = 0.25;

// Clips pulled from Pexels/Pixabay rarely share resolution, aspect ratio, or
// frame rate with each other. Every clip is normalized to this frame before
// concatenation (letterboxed on whichever axis it doesn't fill) so the join
// below is well-defined regardless of source. Short-form output is vertical.
const OUTPUT_WIDTH = 1080;
const OUTPUT_HEIGHT = 1920;
const OUTPUT_FPS = 30;

export interface CompileAudio {
  voiceoverPath?: string;
  musicPath?: string;
}

export async function compileVideo(clipPaths: string[], audio: CompileAudio, outputPath: string): Promise<void> {
  if (!clipPaths.length) throw new Error("compileVideo requires at least one clip");
  const { voiceoverPath, musicPath } = audio;

  await mkdir(dirname(outputPath), { recursive: true });

  const args = ["-y"];
  for (const p of clipPaths) args.push("-i", resolve(p));

  let nextInput = clipPaths.length;
  let voiceoverInput: number | undefined;
  let musicInput: number | undefined;

  if (voiceoverPath) {
    args.push("-i", voiceoverPath);
    voiceoverInput = nextInput++;
  }
  if (musicPath) {
    // Looped infinitely so a music track shorter than the finished video
    // still covers the whole thing — -shortest below then relies on the
    // video (and voiceover, if any) to be the stream that actually ends,
    // trimming an infinite loop down rather than cutting the video early
    // if the track happens to be the shorter of the two.
    args.push("-stream_loop", "-1", "-i", musicPath);
    musicInput = nextInput++;
  }

  // The concat *demuxer* (`-f concat`) splices input files at the packet
  // level and requires every one of them to share codec/resolution/frame
  // rate — a mismatch mid-splice silently breaks decoding right after the
  // first clip instead of erroring, which is why a compile with several
  // clips queued up used to produce a video that was effectively just the
  // first one. Decoding each clip as its own input and normalizing it before
  // joining via the concat *filter* (frame-level, not packet-level) avoids
  // that requirement entirely.
  //
  // Stock footage is frequently landscape even when the search query asks
  // for portrait clips, so scaling to *fit* (force_original_aspect_ratio=
  // decrease) followed by a black pad left most of a landscape clip's frame
  // as dead letterbox space — the wrong ratio todo.txt flagged. Scaling to
  // *cover* (increase) and then center-cropping to the output frame fills
  // the whole 1080x1920 canvas instead, at the cost of cropping the edges of
  // non-vertical source footage, which is the standard trade-off short-form
  // video makes.
  const normalized = clipPaths.map((_, i) =>
    `[${i}:v]scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=increase,` +
    `crop=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT},setsar=1,fps=${OUTPUT_FPS}[v${i}]`
  );
  const concatInputs = clipPaths.map((_, i) => `[v${i}]`).join("");
  const filters = [...normalized, `${concatInputs}concat=n=${clipPaths.length}:v=1:a=0[vcat]`];

  const mapArgs = ["-map", "[vcat]"];
  if (voiceoverInput !== undefined && musicInput !== undefined) {
    filters.push(
      `[${musicInput}:a]volume=${MUSIC_VOLUME}[music_vol]`,
      `[music_vol][${voiceoverInput}:a]sidechaincompress=threshold=0.05:ratio=8:attack=5:release=400[music_duck]`,
      `[music_duck][${voiceoverInput}:a]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[aout]`,
    );
    mapArgs.push("-map", "[aout]", "-shortest");
  } else if (voiceoverInput !== undefined) {
    mapArgs.push("-map", `${voiceoverInput}:a`, "-shortest");
  } else if (musicInput !== undefined) {
    filters.push(`[${musicInput}:a]volume=${MUSIC_VOLUME}[aout]`);
    mapArgs.push("-map", "[aout]", "-shortest");
  }

  args.push("-filter_complex", filters.join(";"), ...mapArgs);
  args.push("-c:v", "libx264", "-pix_fmt", "yuv420p");
  if (voiceoverInput !== undefined || musicInput !== undefined) args.push("-c:a", "aac");
  args.push(outputPath);

  await runFfmpeg(args);
}
