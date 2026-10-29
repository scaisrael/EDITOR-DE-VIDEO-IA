import "dotenv/config";
import fs from "fs";
import path from "path";
import { generateTimeline } from "./agents/editorAgent";
import { transcribeVideoAudio } from "./services/transcribeService";
import { renderTimeline } from "./services/ffmpegService";

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"]);

async function main(): Promise<void> {
  if (!process.env.NVIDIA_API_KEY) {
    throw new Error("Missing NVIDIA_API_KEY in .env");
  }

  const videoPath = await resolveTestVideo(process.argv[2]);
  const prompt = process.argv[3] ?? "Corta un edit corto con los momentos más claros y evita silencios.";
  const outputPath = path.resolve("output", "edit.mp4");

  console.log(`Video de prueba: ${videoPath}`);
  console.log("1/3 Transcribiendo audio...");
  const transcript = await transcribeVideoAudio(videoPath);
  console.log(`Transcripción (${transcript.segments.length} segmentos): ${preview(transcript.text)}`);

  console.log("2/3 Generando línea de tiempo con deepseek-v4.1-flash...");
  const timeline = await generateTimeline({
    prompt,
    transcript,
    clips: [{ id: "source-1", kind: "video", path: videoPath }],
    outputPath,
    width: 1280,
    height: 720,
    fps: 30,
  });
  console.log(`Timeline: ${timeline.title} (${timeline.clips.length} clips)`);

  console.log("3/3 Renderizando con FFmpeg...");
  const renderedPath = await renderTimeline(timeline);
  console.log(`Listo: ${renderedPath}`);
}

async function resolveTestVideo(cliPath?: string): Promise<string> {
  const inputDir = path.resolve("input");
  const candidates: string[] = [];

  if (cliPath) {
    const cleaned = collapseDuplicateVideoExt(cliPath.trim());
    candidates.push(path.resolve(cleaned));
    candidates.push(path.resolve(inputDir, path.basename(cleaned)));
    if (!hasVideoExt(cleaned)) {
      candidates.push(path.resolve(inputDir, `${path.basename(cleaned)}.mp4`));
    }
  }

  candidates.push(path.join(inputDir, "sample.mp4"));
  candidates.push(path.join(inputDir, "test.mp4"));

  for (const candidate of uniqueExistingFiles(candidates)) {
    return candidate;
  }

  if (fs.existsSync(inputDir)) {
    const match = (await fs.promises.readdir(inputDir)).find((name) => hasVideoExt(name));
    if (match) {
      return path.join(inputDir, match);
    }
  }

  throw new Error(
    "No hay video de prueba. Coloca un archivo en input/sample.mp4 o ejecuta: npm run dev -- input\\sample.mp4"
  );
}

function collapseDuplicateVideoExt(filePath: string): string {
  return filePath.replace(/(\.(mp4|mov|mkv|webm|avi|m4v))\1+$/i, "$1");
}

function hasVideoExt(filePath: string): boolean {
  return VIDEO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function uniqueExistingFiles(paths: string[]): string[] {
  const seen = new Set<string>();
  const found: string[] = [];
  for (const candidate of paths) {
    const normalized = path.resolve(candidate);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    try {
      if (fs.statSync(normalized).isFile()) {
        found.push(normalized);
      }
    } catch {
      // skip missing paths
    }
  }
  return found;
}

function preview(text: string, max = 180): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized || "(vacío)";
  }
  return `${normalized.slice(0, max)}...`;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
