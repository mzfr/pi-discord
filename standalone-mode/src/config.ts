/**
 * Configuration loader.
 * Reads discord-relay.json from ~/.pi/agent/extensions/
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

export interface DiscordRelayConfig {
  discord_token: string;
  authorized_user_id: string;
}

const CONFIG_PATH = join(homedir(), ".pi", "agent", "extensions", "discord-relay.json");

export function loadConfig(): DiscordRelayConfig {
  if (!existsSync(CONFIG_PATH)) {
    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify({ discord_token: "", authorized_user_id: "" }, null, 2) + "\n");
    throw new Error(`Config created at ${CONFIG_PATH} — fill in discord_token and authorized_user_id.`);
  }

  const config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as DiscordRelayConfig;
  if (!config.discord_token) throw new Error(`discord_token is empty in ${CONFIG_PATH}`);
  if (!config.authorized_user_id) throw new Error(`authorized_user_id is empty in ${CONFIG_PATH}`);
  return config;
}
