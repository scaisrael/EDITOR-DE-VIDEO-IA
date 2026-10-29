import OpenAI from "openai";
import type { GenerateTimelineInput, Timeline, TimelineClip } from "../types";

const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
const EDITOR_MODEL = "deepseek-ai/deepseek-v4.1-flash";

const SYSTEM_PROMPT = `You are a video editor agent.
Return ONLY valid JSON for an automated FFmpeg timeline. No markdown, no commentary.

JSON schema:
{
  "title": string,
  "clips": [
    {
      "id": string,
      "sourcePath": string,
      "startSeconds": number,
      "endSeconds": number,
      "text": string
    }
  ],
  "outputPath": string,
  "width": number,
  "height": number,
  "fps": number
}

Rules:
- Use only the provided source clip paths.
- startSeconds and endSeconds must be numbers in seconds, with endSeconds > startSeconds.
- Prefer high-signal transcript segments; drop silence, filler, and repeats.
- Keep clips in chronological order.
- If outputPath, width, height, or fps are provided, keep those values.`;

export async function generateTimeline(input: GenerateTimelineInput): Promise<Timeline> {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) {
    throw new Error("Missing NVIDIA_API_KEY in .env");
  }

  const client = new OpenAI({
    apiKey,
    baseURL: NVIDIA_BASE_URL,
  });

  const completion = await client.chat.completions.create({
    model: EDITOR_MODEL,
    temperature: 0.3,
    max_tokens: 4096,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserPrompt(input) },
    ],
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) {
    throw new Error("NVIDIA NIM returned an empty timeline response.");
  }

  return parseTimeline(content, input);
}

function buildUserPrompt(input: GenerateTimelineInput): string {
  return JSON.stringify(
    {
      editBrief: input.prompt,
      defaults: {
        outputPath: input.outputPath ?? "output/edit.mp4",
        width: input.width ?? 1920,
        height: input.height ?? 1080,
        fps: input.fps ?? 30,
      },
      clips: input.clips,
      transcript: {
        text: input.transcript.text,
        language: input.transcript.language,
        durationSeconds: input.transcript.durationSeconds,
        segments: input.transcript.segments,
      },
    },
    null,
    2
  );
}

function parseTimeline(raw: string, input: GenerateTimelineInput): Timeline {
  const parsed = JSON.parse(extractJson(raw)) as Partial<Timeline>;
  const clips = Array.isArray(parsed.clips) ? parsed.clips.map(normalizeClip) : [];

  if (clips.length === 0) {
    throw new Error("Timeline JSON did not include any clips.");
  }

  return {
    title: parsed.title?.trim() || "Untitled edit",
    clips,
    outputPath: parsed.outputPath ?? input.outputPath ?? "output/edit.mp4",
    width: parsed.width ?? input.width ?? 1920,
    height: parsed.height ?? input.height ?? 1080,
    fps: parsed.fps ?? input.fps ?? 30,
  };
}

function normalizeClip(clip: Partial<TimelineClip>, index: number): TimelineClip {
  const startSeconds = Number(clip.startSeconds ?? 0);
  const endSeconds = Number(clip.endSeconds ?? startSeconds);
  if (!clip.sourcePath || Number.isNaN(startSeconds) || Number.isNaN(endSeconds) || endSeconds <= startSeconds) {
    throw new Error(`Invalid timeline clip at index ${index}.`);
  }

  return {
    id: clip.id?.trim() || `clip-${index + 1}`,
    sourcePath: clip.sourcePath,
    startSeconds,
    endSeconds,
    text: clip.text,
  };
}

function extractJson(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }

  return trimmed;
}
