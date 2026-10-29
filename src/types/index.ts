export type MediaKind = "video" | "audio" | "image";

export interface MediaClip {
  id: string;
  kind: MediaKind;
  path: string;
  startSeconds?: number;
  durationSeconds?: number;
}

export interface TimelineClip {
  id: string;
  sourcePath: string;
  startSeconds: number;
  endSeconds: number;
  text?: string;
}

export interface Timeline {
  title: string;
  clips: TimelineClip[];
  outputPath: string;
  width: number;
  height: number;
  fps: number;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface TranscriptionResult {
  text: string;
  language?: string;
  durationSeconds?: number;
  segments: TranscriptSegment[];
}

export interface AgentTask {
  id: string;
  prompt: string;
  context?: string;
}

export interface GenerateTimelineInput {
  prompt: string;
  transcript: TranscriptionResult;
  clips: MediaClip[];
  outputPath?: string;
  width?: number;
  height?: number;
  fps?: number;
}
