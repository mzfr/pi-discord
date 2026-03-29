/**
 * Daemon entry point.
 * Loads config, starts session manager and Discord bot.
 */

import { loadConfig } from "./config.js";
import { SessionManager } from "./session-manager.js";
import { DiscordBot } from "./bot.js";

async function main() {
  console.log("[daemon] Starting pi-discord daemon...");

  const config = loadConfig();
  console.log(`[daemon] Loaded config: ${config.projects.length} project(s), max ${config.max_sessions} sessions`);

  const sessions = new SessionManager(config);
  const bot = new DiscordBot(config, sessions);

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\n[daemon] Shutting down...");
    await bot.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await bot.start();
  console.log("[daemon] Ready. Waiting for Discord commands...");
}

main().catch((err) => {
  console.error("[daemon] Fatal:", err.message || err);
  process.exit(1);
});
