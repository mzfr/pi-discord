/**
 * Tmux session management.
 * Spawns pi inside tmux sessions, checks existence, lists sessions.
 */

import { execSync } from "node:child_process";

export function tmuxSessionExists(name: string): boolean {
  try {
    execSync(`tmux has-session -t ${shellEscape(name)} 2>/dev/null`);
    return true;
  } catch {
    return false;
  }
}

export function tmuxListSessions(): string[] {
  try {
    const output = execSync("tmux list-sessions -F '#{session_name}' 2>/dev/null", {
      encoding: "utf-8",
    });
    return output.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

export function tmuxSpawnPi(sessionName: string, cwd: string, timezone: string): void {
  const tzPrefix = timezone && timezone !== "UTC" ? `TZ=${shellEscape(timezone)} ` : "";
  const cmd = `tmux new-session -d -s ${shellEscape(sessionName)} -c ${shellEscape(cwd)} "${tzPrefix}pi"`;
  execSync(cmd);
}

export function tmuxKillSession(name: string): void {
  try {
    execSync(`tmux kill-session -t ${shellEscape(name)} 2>/dev/null`);
  } catch {
    // Session may already be dead
  }
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
