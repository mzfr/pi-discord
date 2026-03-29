/**
 * Daemon configuration loader.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { DaemonConfig, ProjectConfig } from "../shared/protocol.js";

const CONFIG_DIR = join(homedir(), ".pi", "discord");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const STATE_PATH = join(CONFIG_DIR, "state.json");

const DEFAULT_CONFIG: DaemonConfig = {
  discord_token: "",
  authorized_user_id: "",
  timezone: "UTC",
  max_sessions: 5,
  socket_dir: join(homedir(), ".pi", "agent", "sockets"),
  projects: [],
};

export function loadConfig(): DaemonConfig {
  if (!existsSync(CONFIG_PATH)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
    throw new Error(
      `Config not found. Created default at ${CONFIG_PATH}.\n` +
      `Edit it with your discord_token, authorized_user_id, and projects.`
    );
  }

  const raw = readFileSync(CONFIG_PATH, "utf-8");
  const config = JSON.parse(raw) as DaemonConfig;

  if (!config.discord_token) {
    throw new Error(`discord_token is empty in ${CONFIG_PATH}`);
  }
  if (!config.authorized_user_id) {
    throw new Error(`authorized_user_id is empty in ${CONFIG_PATH}`);
  }
  if (!config.projects || config.projects.length === 0) {
    throw new Error(`No projects configured in ${CONFIG_PATH}`);
  }

  return {
    ...DEFAULT_CONFIG,
    ...config,
  };
}

// ── State persistence ────────────────────────────────────────────────────────

export interface SessionPairing {
  projectName: string;
  channelId: string;
  tmuxSession: string;
  socketPath: string;
  connectedAt: string;
}

export interface DaemonState {
  pairings: SessionPairing[];
}

export function loadState(): DaemonState {
  if (!existsSync(STATE_PATH)) {
    return { pairings: [] };
  }
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf-8"));
  } catch {
    return { pairings: [] };
  }
}

export function saveState(state: DaemonState) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}
