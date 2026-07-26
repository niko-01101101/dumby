import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args);
    let stderr = "";
    proc.stderr.on("data", (chunk) => { stderr += chunk; });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr}`));
    });
  });
}

export async function compileVideo(clipPaths: string[], audioPath: string | undefined, outputPath: string): Promise<void> {
  if (!clipPaths.length) throw new Error("compileVideo requires at least one clip");

  await mkdir(dirname(outputPath), { recursive: true });

  const listPath = `${outputPath}.concat.txt`;
  const listContents = clipPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n");
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
