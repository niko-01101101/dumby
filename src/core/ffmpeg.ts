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
// frame rate with each other. Every clip is scaled-and-cropped to this frame
// before concatenation (see the normalized/filters comment below for why
// cover-crop rather than letterbox) so the join is well-defined regardless
// of source. Short-form output is vertical.
const OUTPUT_WIDTH = 1080;
const OUTPUT_HEIGHT = 1920;
const OUTPUT_FPS = 30;

// A voiceover (one segment up to MAX_VOICEOVER_CHARS, and multiple segments
// can be concatenated into one track — see CompileAudio.voiceoverPaths)
// routinely outlasts the handful of short stock clips backing it. -shortest
// below stops the output at whichever mapped stream ends first, which used
// to mean it cut narration off mid-sentence the moment the clips ran out
// instead of the other way around. Padding the concatenated video with
// frozen last-frame time up to this cap (well over any realistic narration
// length) keeps video from ever being the shorter stream when a voiceover is
// present, without needing to know the voiceover's actual duration up
// front — -shortest still trims the pad down to whatever the real audio
// length turns out to be.
const MAX_VIDEO_PAD_SECONDS = 3600;

export interface CompileAudio {
  // Multiple, in narration order: the model can call VOICEOVER more than
  // once per video (e.g. narrating separate sections across turns), and
  // every segment it recorded should end up in the final track, not just
  // whichever one happened to be added first.
  voiceoverPaths?: string[];
  musicPath?: string;
}

export async function compileVideo(clipPaths: string[], audio: CompileAudio, outputPath: string): Promise<void> {
  if (!clipPaths.length) throw new Error("compileVideo requires at least one clip");
  const { voiceoverPaths, musicPath } = audio;

  await mkdir(dirname(outputPath), { recursive: true });

  const args = ["-y"];
  for (const p of clipPaths) args.push("-i", resolve(p));

  let nextInput = clipPaths.length;
  const voiceoverInputs: number[] = [];
  let musicInput: number | undefined;

  for (const p of voiceoverPaths ?? []) {
    args.push("-i", resolve(p));
    voiceoverInputs.push(nextInput++);
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
  // as dead letterbox space. Scaling to *cover* (increase) and then
  // center-cropping to the output frame fills the whole 1080x1920 canvas
  // instead, at the cost of cropping the edges of non-vertical source
  // footage, which is the standard trade-off short-form video makes.
  const normalized = clipPaths.map((_, i) =>
    `[${i}:v]scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=increase,` +
    `crop=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT},setsar=1,fps=${OUTPUT_FPS}[v${i}]`
  );
  const concatInputs = clipPaths.map((_, i) => `[v${i}]`).join("");
  const filters = [...normalized, `${concatInputs}concat=n=${clipPaths.length}:v=1:a=0[vcat]`];

  // Every voiceover segment is joined end-to-end into one continuous [voice]
  // track before anything else touches it, so a video narrated across
  // several VOICEOVER calls doesn't lose all but the first segment.
  const hasVoice = voiceoverInputs.length > 0;
  if (voiceoverInputs.length === 1) {
    filters.push(`[${voiceoverInputs[0]}:a]anull[voice]`);
  } else if (voiceoverInputs.length > 1) {
    const voiceConcatInputs = voiceoverInputs.map((i) => `[${i}:a]`).join("");
    filters.push(`${voiceConcatInputs}concat=n=${voiceoverInputs.length}:v=0:a=1[voice]`);
  }

  // See MAX_VIDEO_PAD_SECONDS: only needed when there's a voiceover that
  // could outlast the clips — without one, -shortest bounding video against
  // an infinitely-looped music track (or no audio at all) is already correct
  // and shouldn't be stretched.
  let videoOut = "vcat";
  if (hasVoice) {
    filters.push(`[vcat]tpad=stop_mode=clone:stop_duration=${MAX_VIDEO_PAD_SECONDS}[vpad]`);
    videoOut = "vpad";
  }

  const mapArgs = ["-map", `[${videoOut}]`];
  if (hasVoice && musicInput !== undefined) {
    // [voice] is a filter output, not a raw input stream — unlike an "[N:a]"
    // input reference, a filter's own output pad can only feed one
    // downstream filter, so it has to be explicitly split before both
    // sidechaincompress (the ducking trigger) and amix (the actual mix) can
    // each consume their own copy of it.
    filters.push(
      `[voice]asplit=2[voice_duck][voice_mix]`,
      `[${musicInput}:a]volume=${MUSIC_VOLUME}[music_vol]`,
      `[music_vol][voice_duck]sidechaincompress=threshold=0.05:ratio=8:attack=5:release=400[music_duck]`,
      `[music_duck][voice_mix]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[aout]`,
    );
    mapArgs.push("-map", "[aout]", "-shortest");
  } else if (hasVoice) {
    mapArgs.push("-map", "[voice]", "-shortest");
  } else if (musicInput !== undefined) {
    filters.push(`[${musicInput}:a]volume=${MUSIC_VOLUME}[aout]`);
    mapArgs.push("-map", "[aout]", "-shortest");
  }

  args.push("-filter_complex", filters.join(";"), ...mapArgs);
  args.push("-c:v", "libx264", "-pix_fmt", "yuv420p");
  if (hasVoice || musicInput !== undefined) args.push("-c:a", "aac");
  args.push(outputPath);

  await runFfmpeg(args);
}
