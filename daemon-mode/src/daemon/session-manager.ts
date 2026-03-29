/**
 * Manages pi session lifecycle and daemon <-> extension socket connections.
 */

import { connect } from "node:net";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { SocketConnection } from "../extension/socket.js";
import type { DaemonMessage, ExtensionMessage, DaemonConfig, ProjectConfig } from "../shared/protocol.js";
import { tmuxSessionExists, tmuxSpawnPi, tmuxListSessions } from "./tmux.js";
import { loadState, saveState, type SessionPairing, type DaemonState } from "./config.js";

const SOCKET_POLL_INTERVAL = 500;
const SOCKET_POLL_TIMEOUT = 30_000;

export interface PiSession {
  projectName: string;
  channelId: string;
  tmuxSession: string;
  socketPath: string;
  connection: SocketConnection | null;
}

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, PiSession>(); // channelId -> session
  private config: DaemonConfig;

  constructor(config: DaemonConfig) {
    super();
    this.config = config;
  }

  /**
   * Start a new pi session for a project, pair it with a Discord channel.
   */
  async startSession(project: ProjectConfig, channelId: string): Promise<PiSession> {
    // Check if channel already has a session
    const existing = this.sessions.get(channelId);
    if (existing) {
      throw new Error(`Channel already paired with project "${existing.projectName}"`);
    }

    // Check if project already has a tmux session
    if (tmuxSessionExists(project.name)) {
      // Connect to existing tmux session
      return this.connectToExisting(project, channelId);
    }

    // Check session limit
    if (this.sessions.size >= this.config.max_sessions) {
      throw new Error(`Session limit reached (${this.config.max_sessions}). Stop a session first.`);
    }

    // Spawn new tmux session with pi
    tmuxSpawnPi(project.name, project.path, this.config.timezone);

    // Wait for socket to appear and connect
    const socketPath = await this.waitForSocket(project.name);
    const connection = await this.connectSocket(socketPath, channelId);

    const session: PiSession = {
      projectName: project.name,
      channelId,
      tmuxSession: project.name,
      socketPath,
      connection,
    };

    this.sessions.set(channelId, session);
    this.persistState();
    return session;
  }

  /**
   * Connect to an already-running pi tmux session.
   */
  private async connectToExisting(project: ProjectConfig, channelId: string): Promise<PiSession> {
    const socketPath = this.findSocketForSession(project.name);
    if (!socketPath) {
      throw new Error(`Tmux session "${project.name}" exists but no socket found. Pi may still be starting.`);
    }

    const connection = await this.connectSocket(socketPath, channelId);

    const session: PiSession = {
      projectName: project.name,
      channelId,
      tmuxSession: project.name,
      socketPath,
      connection,
    };

    this.sessions.set(channelId, session);
    this.persistState();
    return session;
  }

  /**
   * Disconnect from a pi session without killing it.
   */
  async stopSession(channelId: string): Promise<string | null> {
    const session = this.sessions.get(channelId);
    if (!session) return null;

    if (session.connection) {
      session.connection.close();
    }

    const projectName = session.projectName;
    this.sessions.delete(channelId);
    this.persistState();
    return projectName;
  }

  /**
   * Get session for a channel.
   */
  getSession(channelId: string): PiSession | undefined {
    return this.sessions.get(channelId);
  }

  /**
   * Get all active sessions.
   */
  getAllSessions(): PiSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Send a message to the extension in a specific channel's session.
   */
  sendToSession(channelId: string, msg: DaemonMessage): boolean {
    const session = this.sessions.get(channelId);
    if (!session?.connection?.alive) return false;
    session.connection.send(msg);
    return true;
  }

  /**
   * Try to reconnect sessions from persisted state.
   */
  async reconnectFromState() {
    const state = loadState();
    for (const pairing of state.pairings) {
      try {
        if (!tmuxSessionExists(pairing.tmuxSession)) continue;
        if (!existsSync(pairing.socketPath)) continue;

        const connection = await this.connectSocket(pairing.socketPath, pairing.channelId);
        const session: PiSession = {
          projectName: pairing.projectName,
          channelId: pairing.channelId,
          tmuxSession: pairing.tmuxSession,
          socketPath: pairing.socketPath,
          connection,
        };
        this.sessions.set(pairing.channelId, session);
      } catch {
        // Skip sessions that can't be reconnected
        this.emit("reconnect_failed", pairing);
      }
    }
  }

  /**
   * Find which projects have running tmux sessions (for listing).
   */
  getRunningProjects(): Array<{ name: string; paired: boolean; channelId?: string }> {
    const tmuxSessions = tmuxListSessions();
    const projectNames = new Set(this.config.projects.map((p) => p.name));
    const result: Array<{ name: string; paired: boolean; channelId?: string }> = [];

    for (const name of tmuxSessions) {
      if (!projectNames.has(name)) continue;
      const pairing = Array.from(this.sessions.values()).find((s) => s.tmuxSession === name);
      result.push({
        name,
        paired: !!pairing,
        channelId: pairing?.channelId,
      });
    }

    return result;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private findSocketForSession(sessionName: string): string | null {
    const dir = this.config.socket_dir;
    if (!existsSync(dir)) return null;

    const files = readdirSync(dir);
    for (const file of files) {
      if (file.endsWith(".sock")) {
        // Socket files may be named by session ID, session name, or PID.
        // Try to match by name prefix.
        if (file.startsWith(sessionName) || file.includes(sessionName)) {
          return join(dir, file);
        }
      }
    }

    // If no match by name, return the most recently created socket
    // (heuristic: the pi process we just checked exists)
    if (files.filter((f) => f.endsWith(".sock")).length === 1) {
      const f = files.find((f) => f.endsWith(".sock"))!;
      return join(dir, f);
    }

    return null;
  }

  private async waitForSocket(sessionName: string): Promise<string> {
    const start = Date.now();
    while (Date.now() - start < SOCKET_POLL_TIMEOUT) {
      const path = this.findSocketForSession(sessionName);
      if (path && existsSync(path)) return path;
      await sleep(SOCKET_POLL_INTERVAL);
    }
    throw new Error(`Timed out waiting for socket for session "${sessionName}"`);
  }

  private connectSocket(socketPath: string, channelId: string): Promise<SocketConnection> {
    return new Promise((resolve, reject) => {
      const socket = connect(socketPath);
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Timed out connecting to ${socketPath}`));
      }, 10_000);

      socket.on("connect", () => {
        clearTimeout(timeout);
        const conn = new SocketConnection(socket, (msg: ExtensionMessage) => {
          this.emit("extension_message", channelId, msg);
        });
        resolve(conn);
      });

      socket.on("error", (err) => {
        clearTimeout(timeout);
        reject(new Error(`Socket connection failed: ${err.message}`));
      });

      // Handle unexpected disconnect
      socket.on("close", () => {
        const session = this.sessions.get(channelId);
        if (session && session.socketPath === socketPath) {
          session.connection = null;
          this.emit("session_disconnected", channelId, session.projectName);
        }
      });
    });
  }

  private persistState() {
    const pairings: SessionPairing[] = Array.from(this.sessions.values()).map((s) => ({
      projectName: s.projectName,
      channelId: s.channelId,
      tmuxSession: s.tmuxSession,
      socketPath: s.socketPath,
      connectedAt: new Date().toISOString(),
    }));
    saveState({ pairings });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
