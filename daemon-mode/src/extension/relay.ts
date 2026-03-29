/**
 * Discord Relay Extension
 *
 * Loaded by every pi session. Opens a Unix socket at a known path.
 * Stays dormant until a daemon connects. When connected, relays
 * messages between the daemon and pi internals.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";
import { createServer, type Server } from "node:net";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { DaemonMessage, ExtensionMessage, UsageInfo } from "../shared/protocol.js";
import { SocketConnection } from "./socket.js";

type AnyCtx = ExtensionContext | ExtensionCommandContext;

function getSocketDir(): string {
  return process.env.PI_DISCORD_SOCKET_DIR || join(homedir(), ".pi", "agent", "sockets");
}

function getSocketPath(sessionId: string): string {
  const dir = getSocketDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return join(dir, `${sessionId}.sock`);
}

export class DiscordRelay {
  private pi: ExtensionAPI;
  private server: Server | null = null;
  private connection: SocketConnection | null = null;
  private socketPath: string | null = null;
  private latestCtx: AnyCtx | null = null;
  private latestCommandCtx: ExtensionCommandContext | null = null;
  private connected = false;
  private sessionId: string | null = null;
  private pendingApprovals = new Map<string, {
    resolve: (value: { approved?: boolean; value?: string }) => void;
    timer: NodeJS.Timeout;
  }>();
  private turnUsage: UsageInfo = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  private namePrefix = "[DISCORD] ";
  private hasPrefixedName = false;

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
  }

  register() {
    this.pi.on("session_start", async (_event, ctx) => {
      this.captureCtx(ctx);
      await this.startSocketServer();
    });

    this.pi.on("session_switch", async (_event, ctx) => {
      this.captureCtx(ctx);
      // Restart socket with new session ID
      await this.stopSocketServer();
      await this.startSocketServer();
    });

    this.pi.on("session_shutdown", async () => {
      await this.stopSocketServer();
    });

    this.pi.on("agent_start", async (_event, ctx) => {
      this.captureCtx(ctx);
      if (!this.connected) return;
      this.turnUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
      this.sendToClient({ type: "status", streaming: true, model: this.getModelLabel() });
    });

    this.pi.on("agent_end", async (event, ctx) => {
      this.captureCtx(ctx);
      if (!this.connected) return;

      // Extract final assistant text from the turn's messages
      const text = this.extractFinalText(event.messages);
      this.sendToClient({
        type: "response",
        text,
        usage: this.turnUsage,
      });
      this.sendToClient({ type: "status", streaming: false, model: this.getModelLabel() });

      // Handle session naming
      this.maybeApplyNamePrefix();
    });

    this.pi.on("message_end", async (event, ctx) => {
      this.captureCtx(ctx);
      if (!this.connected) return;

      const msg = event.message as any;
      if (msg?.role === "assistant" && msg?.usage) {
        this.turnUsage.input += msg.usage.input || 0;
        this.turnUsage.output += msg.usage.output || 0;
        this.turnUsage.cacheRead += msg.usage.cacheRead || 0;
        this.turnUsage.cacheWrite += msg.usage.cacheWrite || 0;
        this.turnUsage.cost += msg.usage.cost?.total || 0;
      }
    });

    // Emit discord-relay event for guardrails coordination
    this.pi.on("tool_call", async (event, ctx) => {
      this.captureCtx(ctx);
      if (!this.connected) return undefined;
      // In the future, we can intercept dangerous tool calls here
      // and forward approval requests to the daemon.
      // For now, pass through.
      return undefined;
    });
  }

  private captureCtx(ctx: AnyCtx) {
    this.latestCtx = ctx;
    if (typeof (ctx as ExtensionCommandContext).waitForIdle === "function") {
      this.latestCommandCtx = ctx as ExtensionCommandContext;
    }
  }

  private getModelLabel(): string | undefined {
    const model = this.latestCtx?.model;
    if (!model) return undefined;
    return `${model.provider}/${model.id}`;
  }

  private getSessionIdentifier(): string {
    const ctx = this.latestCtx;
    if (!ctx) return `pi-${process.pid}`;

    // Try session name first, then session ID
    const name = (ctx as any).sessionManager?.getSessionName?.();
    if (name) return name.replace(/[^a-zA-Z0-9_-]/g, "_");

    const id = (ctx as any).sessionManager?.getSessionId?.();
    if (id) return id;

    return `pi-${process.pid}`;
  }

  // ── Socket server ──────────────────────────────────────────────────────────

  private async startSocketServer() {
    if (this.server) return;

    this.sessionId = this.getSessionIdentifier();
    this.socketPath = getSocketPath(this.sessionId);

    // Clean up stale socket
    if (existsSync(this.socketPath)) {
      try { unlinkSync(this.socketPath); } catch {}
    }

    this.server = createServer((socket) => {
      // Only allow one daemon connection at a time
      if (this.connection) {
        socket.end();
        return;
      }

      this.connection = new SocketConnection(socket, (msg) => this.handleDaemonMessage(msg));
      this.connected = true;
      this.hasPrefixedName = false;

      // Notify guardrails we're connected
      this.pi.events.emit("discord-relay", { connected: true });

      // Send initial status
      this.sendToClient({
        type: "status",
        streaming: !this.latestCtx?.isIdle(),
        model: this.getModelLabel(),
      });

      // Send current session name
      const name = this.pi.getSessionName();
      if (name) {
        this.sendToClient({ type: "session_name", name });
      }

      socket.on("close", () => {
        this.connection = null;
        this.connected = false;
        this.pi.events.emit("discord-relay", { connected: false });

        // Cancel all pending approvals
        for (const [id, pending] of this.pendingApprovals) {
          clearTimeout(pending.timer);
          pending.resolve({ approved: false });
        }
        this.pendingApprovals.clear();
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.socketPath!, () => resolve());
    });
  }

  private async stopSocketServer() {
    if (this.connection) {
      this.connection.close();
      this.connection = null;
      this.connected = false;
      this.pi.events.emit("discord-relay", { connected: false });
    }

    if (this.server) {
      const server = this.server;
      this.server = null;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    if (this.socketPath && existsSync(this.socketPath)) {
      try { unlinkSync(this.socketPath); } catch {}
    }
    this.socketPath = null;
  }

  // ── Message handling ───────────────────────────────────────────────────────

  private sendToClient(msg: ExtensionMessage) {
    if (!this.connection) return;
    this.connection.send(msg);
  }

  private async handleDaemonMessage(msg: DaemonMessage) {
    switch (msg.type) {
      case "message":
        await this.handlePrompt(msg.text, msg.images);
        break;
      case "abort":
        this.latestCtx?.abort();
        break;
      case "set_model": {
        const model = this.latestCtx?.modelRegistry?.find(msg.provider, msg.modelId);
        if (model) {
          await this.pi.setModel(model as any);
          this.sendToClient({
            type: "status",
            streaming: !this.latestCtx?.isIdle(),
            model: `${msg.provider}/${msg.modelId}`,
          });
        } else {
          this.sendToClient({
            type: "error",
            message: `Model not found: ${msg.provider}/${msg.modelId}`,
          });
        }
        break;
      }
      case "approval_response": {
        const pending = this.pendingApprovals.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingApprovals.delete(msg.id);
          pending.resolve({ approved: msg.approved, value: msg.value });
        }
        break;
      }
      case "ping":
        this.sendToClient({ type: "pong" });
        break;
    }
  }

  private async handlePrompt(text: string, images?: Array<{ data: string; mimeType: string }>) {
    if (!this.latestCtx) {
      this.sendToClient({ type: "error", message: "Pi session not ready" });
      return;
    }

    const isIdle = this.latestCtx.isIdle();
    const deliverAs = isIdle ? undefined : ("followUp" as const);

    if (images && images.length > 0) {
      const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
      content.push({ type: "text", text });
      for (const img of images) {
        content.push({ type: "image", data: img.data, mimeType: img.mimeType });
      }
      this.pi.sendUserMessage(content, deliverAs ? { deliverAs } : undefined);
    } else {
      this.pi.sendUserMessage(text, deliverAs ? { deliverAs } : undefined);
    }
  }

  // ── Approval requests ──────────────────────────────────────────────────────

  async requestApproval(
    method: "confirm" | "select" | "input",
    title: string,
    extra: { message?: string; options?: string[]; placeholder?: string },
    timeoutMs = 120_000,
  ): Promise<{ approved?: boolean; value?: string }> {
    const id = `approval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingApprovals.delete(id);
        resolve({ approved: false });
      }, timeoutMs);

      this.pendingApprovals.set(id, { resolve, timer });

      if (method === "confirm") {
        this.sendToClient({
          type: "approval_request",
          id,
          method: "confirm",
          title,
          message: extra.message || "",
        });
      } else if (method === "select") {
        this.sendToClient({
          type: "approval_request",
          id,
          method: "select",
          title,
          options: extra.options || [],
        });
      } else {
        this.sendToClient({
          type: "approval_request",
          id,
          method: "input",
          title,
          placeholder: extra.placeholder,
        });
      }
    });
  }

  // ── Text extraction ────────────────────────────────────────────────────────

  private extractFinalText(messages: any[]): string {
    if (!Array.isArray(messages) || messages.length === 0) return "";

    // Find last user message index to scope to current turn
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "user") {
        lastUserIdx = i;
        break;
      }
    }

    const turnMessages = lastUserIdx >= 0
      ? messages.slice(lastUserIdx + 1)
      : messages;

    const textParts: string[] = [];
    for (const msg of turnMessages) {
      if (msg?.role !== "assistant") continue;
      const content = msg.content;
      if (typeof content === "string") {
        textParts.push(content);
        continue;
      }
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (part?.type === "text" && part.text) {
          textParts.push(part.text);
        }
      }
    }

    return textParts.join("\n\n").trim();
  }

  // ── Session naming ─────────────────────────────────────────────────────────

  private maybeApplyNamePrefix() {
    if (this.hasPrefixedName) return;
    const name = this.pi.getSessionName();
    if (!name) return;
    if (name.startsWith(this.namePrefix)) {
      this.hasPrefixedName = true;
      return;
    }

    const prefixed = `${this.namePrefix}${name}`;
    this.pi.setSessionName(prefixed);
    this.hasPrefixedName = true;
    this.sendToClient({ type: "session_name", name: prefixed });
  }
}
