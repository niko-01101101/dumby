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

export async function compileVideo(clipPaths: string[], audioPath: string | undefined, outputPath: string): Promise<void> {
  if (!clipPaths.length) throw new Error("compileVideo requires at least one clip");

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
    if (audioPath) args.push("-i", audioPath);
    args.push("-map", "0:v");
    if (audioPath) args.push("-map", "1:a", "-shortest");
    args.push("-c:v", "libx264", "-pix_fmt", "yuv420p");
    if (audioPath) args.push("-c:a", "aac");
    args.push(outputPath);

    await runFfmpeg(args);
  } finally {
    await rm(listPath, { force: true });
  }
}
