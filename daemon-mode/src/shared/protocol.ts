/**
 * Socket protocol types for daemon <-> extension communication.
 * JSON lines over Unix socket.
 */

// ── Daemon → Extension ──────────────────────────────────────────────────────

export type DaemonMessage =
  | { type: "message"; text: string; images?: ImageData[] }
  | { type: "abort" }
  | { type: "set_model"; provider: string; modelId: string }
  | { type: "approval_response"; id: string; approved?: boolean; value?: string }
  | { type: "ping" };

export interface ImageData {
  data: string; // base64
  mimeType: string;
}

// ── Extension → Daemon ──────────────────────────────────────────────────────

export type ExtensionMessage =
  | { type: "response"; text: string; usage?: UsageInfo }
  | { type: "approval_request"; id: string; method: "confirm"; title: string; message: string }
  | { type: "approval_request"; id: string; method: "select"; title: string; options: string[] }
  | { type: "approval_request"; id: string; method: "input"; title: string; placeholder?: string }
  | { type: "notify"; message: string; level: "info" | "warning" | "error" }
  | { type: "error"; message: string }
  | { type: "session_name"; name: string }
  | { type: "status"; streaming: boolean; model?: string }
  | { type: "pong" };

export interface UsageInfo {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

// ── Config ───────────────────────────────────────────────────────────────────

export interface ProjectConfig {
  name: string;
  path: string;
}

export interface DaemonConfig {
  discord_token: string;
  authorized_user_id: string;
  timezone: string;
  max_sessions: number;
  socket_dir: string;
  projects: ProjectConfig[];
}
