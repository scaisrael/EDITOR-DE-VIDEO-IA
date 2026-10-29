import fs from "fs";
import os from "os";
import path from "path";
import ffmpeg from "fluent-ffmpeg";
import type { Timeline, TimelineClip } from "../types";

export async function renderTimeline(timeline: Timeline): Promise<string> {
  const outputPath = path.resolve(timeline.outputPath);
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ai-video-edit-"));

  try {
    const parts: string[] = [];
    for (let index = 0; index < timeline.clips.length; index += 1) {
      const partPath = path.join(tempDir, `part-${index}.mp4`);
      await cutClip(timeline.clips[index], timeline, partPath);
      parts.push(partPath);
    }

    if (parts.length === 1) {
      await fs.promises.copyFile(parts[0], outputPath);
      return outputPath;
    }

    await concatParts(parts, outputPath);
    return outputPath;
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}

function cutClip(clip: TimelineClip, timeline: Timeline, outputPath: string): Promise<void> {
  const duration = clip.endSeconds - clip.startSeconds;

  return new Promise((resolve, reject) => {
    ffmpeg(path.resolve(clip.sourcePath))
      .setStartTime(clip.startSeconds)
      .setDuration(duration)
      .videoFilters([
        `scale=${timeline.width}:${timeline.height}:force_original_aspect_ratio=decrease`,
        `pad=${timeline.width}:${timeline.height}:(ow-iw)/2:(oh-ih)/2`,
        `fps=${timeline.fps}`,
      ])
      .outputOptions([
        "-c:v libx264",
        "-preset veryfast",
        "-crf 20",
        "-c:a aac",
        "-b:a 192k",
        "-pix_fmt yuv420p",
        "-movflags +faststart",
      ])
      .output(outputPath)
      .on("end", () => resolve())
      .on("error", reject)
      .run();
  });
}

function concatParts(parts: string[], outputPath: string): Promise<void> {
  const listPath = `${outputPath}.concat.txt`;
  const listBody = parts
    .map((part) => `file '${part.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`)
    .join("\n");

  return fs.promises.writeFile(listPath, listBody, "utf8").then(
    () =>
      new Promise<void>((resolve, reject) => {
        ffmpeg()
          .input(listPath)
          .inputOptions(["-f concat", "-safe 0"])
          .outputOptions(["-c copy"])
          .output(outputPath)
          .on("end", () => {
            fs.promises.unlink(listPath).catch(() => undefined);
            resolve();
          })
          .on("error", (error) => {
            fs.promises.unlink(listPath).catch(() => undefined);
            reject(error);
          })
          .run();
      })
  );
}
