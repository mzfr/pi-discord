/**
 * Pi Discord Relay — Standalone Extension
 *
 * Bridges a live pi session to Discord. No separate daemon process needed.
 *
 * Usage:
 *   /rc start   — connect to Discord (run inside pi)
 *   /rc stop    — disconnect from Discord
 *   /rc status  — show connection status
 *
 * Once connected, pair a Discord channel with /rc start in Discord.
 * Messages in that channel are relayed to pi. Responses are sent back.
 *
 * Pi slash commands work from Discord: type /new, /compact, /reload etc.
 * Guardrails approval prompts are forwarded as Discord buttons.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { resolve, relative, isAbsolute, normalize } from "node:path";
import { homedir } from "node:os";
import { DiscordClient } from "./discord-client.js";
import { loadConfig } from "./config.js";

type AnyCtx = ExtensionContext | ExtensionCommandContext;

// Dangerous command patterns (mirrored from guardrails.ts)
const DANGEROUS_COMMANDS = [
  { pattern: /\brm\b/i, description: "rm (file deletion)", warning: "This command will delete files." },
  { pattern: /\bsudo\b/i, description: "sudo (superuser)", warning: "This command runs with superuser privileges." },
  { pattern: /\bdd\s+.*\bif=/i, description: "dd (disk write)", warning: "This command writes directly to disk." },
  { pattern: /\bmkfs\./i, description: "mkfs (format)", warning: "This command formats a filesystem." },
  { pattern: /\bchmod\s+.*((-r\s+.*777)|(777\s+.*-r)|(--recursive\s+.*777)|(777\s+.*--recursive))/i, description: "chmod -R 777", warning: "Insecure recursive permissions." },
  { pattern: /\bchown\s+(-[a-zA-Z]*R|(?:--recursive))/i, description: "chown -R", warning: "Recursive ownership change." },
];

const PROTECTED_MD_NAMES = ["plan.md", "spec.md", "vision.md", "readme.md"];
const APPROVAL_TIMEOUT_MS = 120_000;

export default function registerDiscordRelay(pi: ExtensionAPI) {
  let discord: DiscordClient | null = null;
  let latestCtx: AnyCtx | null = null;
  let latestCommandCtx: ExtensionCommandContext | null = null;
  let hasPrefixedName = false;

  const pendingApprovals = new Map<string, {
    resolve: (result: { approved?: boolean; value?: string }) => void;
    timer: NodeJS.Timeout;
  }>();

  // ── Helpers ────────────────────────────────────────────────────────────────

  function captureCtx(ctx: AnyCtx) {
    latestCtx = ctx;
    if (typeof (ctx as ExtensionCommandContext).waitForIdle === "function") {
      latestCommandCtx = ctx as ExtensionCommandContext;
    }
  }

  function getModelName(): string {
    return latestCtx?.model?.id || "unknown";
  }

  function getCwd(): string {
    return latestCtx?.cwd || process.cwd();
  }

  function buildFooter(): string {
    return `\n\n-# ${getCwd()} · ${getModelName()}`;
  }

  function extractFinalText(messages: any[]): string {
    if (!Array.isArray(messages) || messages.length === 0) return "";

    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "user") { lastUserIdx = i; break; }
    }

    const turn = lastUserIdx >= 0 ? messages.slice(lastUserIdx + 1) : messages;
    const parts: string[] = [];

    for (const msg of turn) {
      if (msg?.role !== "assistant") continue;
      if (typeof msg.content === "string") { parts.push(msg.content); continue; }
      if (!Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (block?.type === "text" && block.text) parts.push(block.text);
      }
    }

    return parts.join("\n\n").trim();
  }

  function maybeApplyNamePrefix() {
    if (!discord?.paired || hasPrefixedName) return;
    const name = pi.getSessionName();
    if (!name) return;
    if (name.startsWith("[DISCORD] ")) { hasPrefixedName = true; return; }
    pi.setSessionName(`[DISCORD] ${name}`);
    hasPrefixedName = true;
  }

  function getAvailableModels(): Array<{ provider: string; id: string; label: string }> {
    const models = latestCtx?.modelRegistry?.getAvailable() || [];
    return models.map((m: any) => ({
      provider: m.provider,
      id: m.id,
      label: `${m.provider}/${m.id}`,
    }));
  }

  // ── Built-in command pass-through ──────────────────────────────────────────

  async function handleBuiltinCommand(text: string): Promise<boolean> {
    const cmd = text.trim().split(/\s+/)[0]?.toLowerCase();

    switch (cmd) {
      case "/new":
        if (!latestCommandCtx) { await discord?.sendNotify("No command context.", "error"); return true; }
        await latestCommandCtx.newSession();
        await discord?.sendMessage(`New session started.${buildFooter()}`);
        return true;

      case "/compact":
        latestCtx?.compact();
        await discord?.sendMessage("Compaction started.");
        return true;

      case "/abort":
        latestCtx?.abort();
        await discord?.sendMessage("Aborted.");
        return true;

      case "/reload":
        if (!latestCommandCtx) { await discord?.sendNotify("No command context.", "error"); return true; }
        await latestCommandCtx.reload();
        await discord?.sendMessage(`Reloaded.${buildFooter()}`);
        return true;

      default:
        return false;
    }
  }

  // ── Approval request helpers ───────────────────────────────────────────────

  function wireApprovalHandler() {
    if (!discord) return;
    discord.onApprovalResponse = (id, result) => {
      const pending = pendingApprovals.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingApprovals.delete(id);
      pending.resolve(result);
    };
  }

  function requestApproval(
    method: "confirm" | "select",
    title: string,
    extra: { message?: string; options?: string[] },
  ): Promise<{ approved?: boolean; value?: string }> {
    if (!discord?.paired) return Promise.resolve({ approved: false });

    const id = `a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    return new Promise((res) => {
      const timer = setTimeout(() => {
        pendingApprovals.delete(id);
        res({ approved: false });
        discord?.sendNotify("Approval timed out, denied.", "warning");
      }, APPROVAL_TIMEOUT_MS);

      pendingApprovals.set(id, { resolve: res, timer });
      discord!.sendApprovalRequest(id, method, title, extra);
    });
  }

  function isPathInside(child: string, parent: string): boolean {
    const rel = relative(parent, child);
    return !rel.startsWith("..") && !isAbsolute(rel);
  }

  function resolvePath(input: string, cwd: string): string {
    return resolve(cwd, input.startsWith("@") ? input.slice(1) : input);
  }

  function isProtectedMarkdown(path: string): boolean {
    const base = (path.split("/").pop() || "").toLowerCase();
    return PROTECTED_MD_NAMES.includes(base);
  }

  // ── /rc command ────────────────────────────────────────────────────────────

  pi.registerCommand("rc", {
    description: "Discord relay: /rc start | /rc stop | /rc status",
    handler: async (args, ctx) => {
      captureCtx(ctx);
      const sub = args.trim().toLowerCase();

      if (sub === "start") {
        if (discord) { ctx.ui.notify("Discord relay already running.", "warning"); return; }

        try {
          const config = loadConfig();
          discord = new DiscordClient(config);

          discord.onMessage = async (_channelId, text, images) => {
            if (!latestCtx) return;
            const idle = latestCtx.isIdle();
            const deliverAs = idle ? undefined : ("followUp" as const);

            if (text.startsWith("/") && images.length === 0) {
              if (await handleBuiltinCommand(text)) return;
              pi.sendUserMessage(text, deliverAs ? { deliverAs } : undefined);
              discord?.startTyping();
              return;
            }

            if (images.length > 0) {
              const content: any[] = [{ type: "text", text }];
              for (const img of images) content.push({ type: "image", data: img.data, mimeType: img.mimeType });
              pi.sendUserMessage(content, deliverAs ? { deliverAs } : undefined);
            } else {
              pi.sendUserMessage(text, deliverAs ? { deliverAs } : undefined);
            }
            discord?.startTyping();
          };

          discord.onAbort = () => latestCtx?.abort();

          discord.onModel = async (provider, modelId) => {
            const model = latestCtx?.modelRegistry?.find(provider, modelId);
            if (model) {
              await pi.setModel(model as any);
              await discord?.sendMessage(`Model switched to **${model.id}**`);
            } else {
              await discord?.sendNotify(`Model not found: ${provider}/${modelId}`, "error");
            }
          };

          discord.onModelList = () => getAvailableModels();

          discord.onRc = async (action) => {
            if (action === "start") {
              hasPrefixedName = false;
              pi.events.emit("discord-relay", { connected: true });
              wireApprovalHandler();
              ctx.ui.notify("Discord channel paired.", "info");
            } else {
              pi.events.emit("discord-relay", { connected: false });
              ctx.ui.notify("Discord channel unpaired.", "info");
            }
          };

          await discord.connect();
          ctx.ui.notify("Discord relay started. Use /rc start in Discord to pair a channel.", "info");
        } catch (err) {
          ctx.ui.notify(`Failed: ${err instanceof Error ? err.message : err}`, "error");
          discord = null;
        }

      } else if (sub === "stop") {
        if (!discord) { ctx.ui.notify("Discord relay not running.", "warning"); return; }
        await discord.disconnect();
        discord = null;
        pi.events.emit("discord-relay", { connected: false });
        ctx.ui.notify("Discord relay stopped.", "info");

      } else if (sub === "status") {
        if (!discord) { ctx.ui.notify("Discord relay: stopped", "info"); return; }
        const pair = discord.paired ? `paired with channel ${discord.channelId}` : "not paired";
        ctx.ui.notify(`Discord relay: running, ${pair}`, "info");

      } else {
        ctx.ui.notify("Usage: /rc start | /rc stop | /rc status", "warning");
      }
    },
  });

  // ── Pi event hooks ─────────────────────────────────────────────────────────

  pi.on("session_start", async (_e, ctx) => captureCtx(ctx));
  pi.on("session_switch", async (_e, ctx) => { captureCtx(ctx); hasPrefixedName = false; });

  pi.on("agent_start", async (_e, ctx) => {
    captureCtx(ctx);
    if (discord?.paired) discord.startTyping();
  });

  pi.on("agent_end", async (event, ctx) => {
    captureCtx(ctx);
    if (!discord?.paired) return;
    discord.stopTyping();
    const text = extractFinalText(event.messages);
    await discord.sendMessage(text + buildFooter());
    maybeApplyNamePrefix();
  });

  pi.on("model_select", async (_e, ctx) => {
    captureCtx(ctx);
    if (discord?.paired) await discord.sendMessage(`Model: **${getModelName()}**`);
  });

  pi.on("session_shutdown", async () => {
    if (!discord) return;
    pi.events.emit("discord-relay", { connected: false });
    await discord.disconnect();
    discord = null;
  });

  // ── Guardrails forwarding ──────────────────────────────────────────────────

  pi.on("tool_call", async (event, ctx) => {
    captureCtx(ctx);
    if (!discord?.paired) return undefined;

    if (isToolCallEventType("shell", event) || isToolCallEventType("bash", event)) {
      const command = String(event.input.command || "");
      for (const d of DANGEROUS_COMMANDS) {
        if (!d.pattern.test(command)) continue;
        const r = await requestApproval("confirm", `Dangerous: ${d.description}`, {
          message: `\`${command}\`\n\n${d.warning}`,
        });
        if (!r.approved) return { block: true, reason: `Denied: ${d.description}` };
        return undefined;
      }
      return undefined;
    }

    if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
      const target = resolvePath(event.input.path, ctx.cwd);

      if (!isPathInside(target, ctx.cwd) && normalize(target).toLowerCase() !== normalize(ctx.cwd).toLowerCase()) {
        const r = await requestApproval("select", `Write outside CWD: ${event.input.path}`, { options: ["Yes (once)", "No"] });
        if (r.value === "No" || (!r.value && !r.approved)) return { block: true, reason: "Denied write outside CWD" };
        return undefined;
      }

      if (isProtectedMarkdown(target)) {
        const r = await requestApproval("select", `Edit protected file: ${event.input.path}`, { options: ["Yes (once)", "No"] });
        if (r.value === "No" || (!r.value && !r.approved)) return { block: true, reason: "Denied write to protected file" };
        return undefined;
      }

      return undefined;
    }

    return undefined;
  });
}
