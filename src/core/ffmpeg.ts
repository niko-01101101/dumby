import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
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

export interface CompileAudio {
  voiceoverPath?: string;
  musicPath?: string;
}

export async function compileVideo(clipPaths: string[], audio: CompileAudio, outputPath: string): Promise<void> {
  if (!clipPaths.length) throw new Error("compileVideo requires at least one clip");
  const { voiceoverPath, musicPath } = audio;

  await mkdir(dirname(outputPath), { recursive: true });

  const listPath = `${outputPath}.concat.txt`;
  // The concat demuxer resolves relative entries against the list file's own
  // directory, not the process cwd - since the list lives inside mediaDir()
  // alongside clips whose stored localPath is *itself* already relative to
  // mediaDir(), a relative entry here would get mediaDir() prepended twice
  // (e.g. "media/media/<id>/<file>.mp4") and fail to open. Absolute paths sidestep that.
  const listContents = clipPaths.map((p) => `file '${resolve(p).replace(/'/g, "'\\''")}'`).join("\n");
  await writeFile(listPath, listContents, "utf8");

  try {
    const args = ["-y", "-f", "concat", "-safe", "0", "-i", listPath];
    let nextInput = 1;
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

    args.push("-map", "0:v");

    if (voiceoverInput !== undefined && musicInput !== undefined) {
      const filter = [
        `[${musicInput}:a]volume=${MUSIC_VOLUME}[music_vol]`,
        `[music_vol][${voiceoverInput}:a]sidechaincompress=threshold=0.05:ratio=8:attack=5:release=400[music_duck]`,
        `[music_duck][${voiceoverInput}:a]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[aout]`,
      ].join(";");
      args.push("-filter_complex", filter, "-map", "[aout]", "-shortest");
    } else if (voiceoverInput !== undefined) {
      args.push("-map", `${voiceoverInput}:a`, "-shortest");
    } else if (musicInput !== undefined) {
      args.push("-filter_complex", `[${musicInput}:a]volume=${MUSIC_VOLUME}[aout]`, "-map", "[aout]", "-shortest");
    }

    args.push("-c:v", "libx264", "-pix_fmt", "yuv420p");
    if (voiceoverInput !== undefined || musicInput !== undefined) args.push("-c:a", "aac");
    args.push(outputPath);

    await runFfmpeg(args);
  } finally {
    await rm(listPath, { force: true });
  }
}
