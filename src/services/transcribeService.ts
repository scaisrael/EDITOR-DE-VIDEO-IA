import fs from "fs";
import os from "os";
import path from "path";
import ffmpeg from "fluent-ffmpeg";
import type { TranscriptionResult, TranscriptSegment } from "../types";

const INTEGRATE_TRANSCRIPTIONS_URL = "https://integrate.api.nvidia.com/v1/audio/transcriptions";
const PARAKEET_NVCF_URL =
  "https://1598d209-5e27-4d3c-8079-4751568b1081.invocation.api.nvcf.nvidia.com/v1/audio/transcriptions";

const DEFAULT_MODELS = ["openai/whisper-large-v3", "nvidia/parakeet-ctc-1.1b", "nvidia/parakeet-ctc-1.1b-asr"];
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"]);
const AUDIO_EXTENSIONS = new Set([".wav", ".mp3", ".flac", ".ogg", ".m4a", ".opus"]);

export async function transcribeVideoAudio(
  filePath: string,
  options?: { language?: string }
): Promise<TranscriptionResult> {
  if (isTruthy(process.env.USE_MOCK_TRANSCRIPT)) {
    console.warn("USE_MOCK_TRANSCRIPT=true: usando transcripción simulada.");
    return mockTranscription(filePath);
  }

  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) {
    throw new Error("Missing NVIDIA_API_KEY in .env");
  }

  try {
    const audioPath = await extractAudioWav(filePath);
    try {
      return await transcribeWithNvidia(audioPath, apiKey, options?.language);
    } finally {
      if (audioPath !== path.resolve(filePath)) {
        await fs.promises.unlink(audioPath).catch(() => undefined);
      }
    }
  } catch (error) {
    if (process.env.USE_MOCK_TRANSCRIPT?.toLowerCase() === "false") {
      throw error;
    }
    console.warn(`ASR de NVIDIA no disponible (${explain(error)}). Usando transcripción simulada.`);
    return mockTranscription(filePath);
  }
}

async function transcribeWithNvidia(
  audioPath: string,
  apiKey: string,
  language?: string
): Promise<TranscriptionResult> {
  const models = process.env.NVIDIA_ASR_MODEL ? [process.env.NVIDIA_ASR_MODEL, ...DEFAULT_MODELS] : DEFAULT_MODELS;
  const uniqueModels = [...new Set(models)];
  const endpoints = [INTEGRATE_TRANSCRIPTIONS_URL, PARAKEET_NVCF_URL];
  const errors: string[] = [];

  for (const endpoint of endpoints) {
    for (const model of uniqueModels) {
      try {
        return await postTranscription(endpoint, audioPath, apiKey, model, language);
      } catch (error) {
        errors.push(`${endpoint} [${model}]: ${explain(error)}`);
      }
    }
  }

  throw new Error(`No se pudo transcribir con NVIDIA NIM.\n${errors.join("\n")}`);
}

async function postTranscription(
  endpoint: string,
  audioPath: string,
  apiKey: string,
  model: string,
  language?: string
): Promise<TranscriptionResult> {
  const audio = await fs.promises.readFile(audioPath);
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(audio)], { type: "audio/wav" }),
    path.basename(audioPath)
  );
  form.append("model", model);
  form.append("language", language ?? "en-US");
  form.append("response_format", "json");
  form.append("word_time_offsets", "true");

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
    body: form,
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${raw.slice(0, 300) || response.statusText}`);
  }

  const payload = JSON.parse(raw) as NvidiaTranscriptionResponse;
  const segments = normalizeSegments(payload);
  const text = payload.text?.trim() ?? segments.map((segment) => segment.text).join(" ").trim();
  if (!text && segments.length === 0) {
    throw new Error("La API de audio devolvió una transcripción vacía.");
  }

  return {
    text,
    language: payload.language ?? language,
    durationSeconds: payload.duration ?? payload.usage?.seconds,
    segments,
  };
}

async function extractAudioWav(filePath: string): Promise<string> {
  const resolved = path.resolve(filePath);
  const extension = path.extname(resolved).toLowerCase();
  if (AUDIO_EXTENSIONS.has(extension) && !VIDEO_EXTENSIONS.has(extension)) {
    return resolved;
  }

  const outputPath = path.join(os.tmpdir(), `asr-${Date.now()}.wav`);

  await new Promise<void>((resolve, reject) => {
    ffmpeg(resolved)
      .noVideo()
      .audioChannels(1)
      .audioFrequency(16000)
      .format("wav")
      .on("end", () => resolve())
      .on("error", reject)
      .save(outputPath);
  });

  return outputPath;
}

async function mockTranscription(filePath: string): Promise<TranscriptionResult> {
  const durationSeconds = await probeDuration(filePath);
  const endA = Math.max(1, Math.min(4, durationSeconds));
  const endB = Math.max(endA + 0.5, Math.min(durationSeconds, 10));

  const segments: TranscriptSegment[] = [
    {
      start: 0,
      end: endA,
      text: "This is a mock transcript for testing the editor agent.",
    },
  ];

  if (durationSeconds > endA + 0.75) {
    segments.push({
      start: endA,
      end: endB,
      text: "Keep the strongest moments and cut the silence.",
    });
  }

  return {
    text: segments.map((segment) => segment.text).join(" "),
    language: "en",
    durationSeconds,
    segments,
  };
}

function probeDuration(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (error, metadata) => {
      if (error) {
        resolve(8);
        return;
      }
      resolve(Math.max(1, metadata.format.duration ?? 8));
    });
  });
}

function normalizeSegments(payload: NvidiaTranscriptionResponse): TranscriptSegment[] {
  if (payload.segments?.length) {
    return payload.segments.map((segment) => ({
      start: Number(segment.start ?? 0),
      end: Number(segment.end ?? 0),
      text: (segment.text ?? "").trim(),
    }));
  }

  if (payload.words?.length) {
    return wordsToSegments(payload.words);
  }

  const text = payload.text?.trim();
  if (!text) {
    return [];
  }

  return [{ start: 0, end: payload.duration ?? payload.usage?.seconds ?? 0, text }];
}

function wordsToSegments(words: Array<{ word?: string; start?: number; end?: number }>): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  let bucket: string[] = [];
  let start = words[0]?.start ?? 0;
  let end = start;

  const flush = (): void => {
    if (bucket.length === 0) {
      return;
    }
    segments.push({ start, end, text: bucket.join(" ").trim() });
    bucket = [];
  };

  for (const word of words) {
    const token = (word.word ?? "").trim();
    if (!token) {
      continue;
    }
    if (bucket.length === 0) {
      start = word.start ?? end;
    }
    bucket.push(token);
    end = word.end ?? word.start ?? end;
    if (bucket.length >= 12) {
      flush();
    }
  }
  flush();
  return segments;
}

function isTruthy(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes";
}

function explain(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface NvidiaTranscriptionResponse {
  text?: string;
  language?: string;
  duration?: number;
  usage?: { seconds?: number };
  segments?: Array<{ start?: number; end?: number; text?: string }>;
  words?: Array<{ word?: string; start?: number; end?: number }>;
}
