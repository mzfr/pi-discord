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
 * /rc start creates/reuses a Discord channel automatically.
 * Messages in that channel are relayed to pi. Responses are sent back.
 *
 * Pi slash commands work from Discord: type /new, /compact, /reload etc.
 * Guardrails approval prompts are forwarded as Discord buttons.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { resolve, relative, isAbsolute, normalize, basename, join, dirname } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  type Message,
  type Interaction,
  ChannelType,
} from "discord.js";

interface DiscordRelayConfig {
  discord_token: string;
  authorized_user_id: string;
  guild_id?: string;
  category_id?: string;
}

const CONFIG_PATH = join(homedir(), ".pi", "agent", "extensions", "discord-relay.json");

function loadConfig(): DiscordRelayConfig {
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

const MAX_MSG_LENGTH = 2000;

type MessageHandler = (channelId: string, text: string, images: Array<{ data: string; mimeType: string }>) => void | Promise<void>;
type AbortHandler = () => void;
type ModelHandler = (provider: string, modelId: string) => void | Promise<void>;
type ModelListHandler = () => Array<{ provider: string; id: string; label: string }>;
type ApprovalResponseHandler = (id: string, result: { approved?: boolean; value?: string }) => void;
type RcHandler = (action: "start" | "stop") => void | Promise<void>;
type RecapHandler = () => void | Promise<void>;
type ChannelRenameHandler = (name: string) => void | Promise<void>;

class DiscordClient {
  private client: Client;
  private config: DiscordRelayConfig;
  private typingIntervals = new Map<string, NodeJS.Timeout>();
  private pairedChannelId: string | null = null;

  onMessage: MessageHandler = () => {};
  onAbort: AbortHandler = () => {};
  onModel: ModelHandler = () => {};
  onModelList: ModelListHandler = () => [];
  onApprovalResponse: ApprovalResponseHandler = () => {};
  onRc: RcHandler = () => {};
  onRecap: RecapHandler = () => {};
  onChannelRename: ChannelRenameHandler = () => {};

  constructor(config: DiscordRelayConfig) {
    this.config = config;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });
    this.setupHandlers();
  }

  async connect() {
    await this.client.login(this.config.discord_token);
    await new Promise<void>((resolve) => {
      if (this.client.isReady()) return resolve();
      this.client.once("ready", () => resolve());
    });
    await this.registerCommands();
  }

  async disconnect() {
    for (const interval of this.typingIntervals.values()) clearInterval(interval);
    this.typingIntervals.clear();
    this.client.destroy();
  }

  get paired(): boolean { return this.pairedChannelId !== null; }
  get channelId(): string | null { return this.pairedChannelId; }

  async createAndPairChannel(name: string, existingChannelId?: string): Promise<string> {
    if (this.pairedChannelId) return this.pairedChannelId;

    let channel: any = null;
    if (existingChannelId) {
      channel = await this.client.channels.fetch(existingChannelId).catch(() => null);
      if (!channel?.isTextBased?.()) channel = null;
    }

    if (!channel) {
      const guild = await this.resolveTargetGuild();
      channel = await guild.channels.create({
        name,
        type: ChannelType.GuildText,
        parent: this.config.category_id,
        reason: "pi discord relay session channel",
      });
    }

    this.pairedChannelId = channel.id;
    await this.onRc("start");

    // Pairing must return immediately. Channel decoration is best-effort and
    // must not keep local /rc start stuck while Discord REST calls complete.
    void this.setChannelActive(true);
    void this.send(channel.id, "Connected to pi. Messages in this channel will be relayed.");
    return channel.id;
  }

  async markInactive() {
    if (!this.pairedChannelId) return;
    await this.send(this.pairedChannelId, "Pi session disconnected. Restart the same pi chat and run `/rc start` locally to reactivate this channel.");
    await this.setChannelActive(false);
  }

  async unpair() {
    await this.markInactive();
    this.pairedChannelId = null;
    await this.onRc("stop");
  }

  private async setChannelActive(active: boolean) {
    if (!this.pairedChannelId) return;
    const channel: any = await this.client.channels.fetch(this.pairedChannelId).catch(() => null);
    if (!channel) return;

    if ("permissionOverwrites" in channel) {
      await channel.permissionOverwrites.edit(this.config.authorized_user_id, { SendMessages: active ? true : false }).catch(() => {});
    }
    if ("setTopic" in channel) {
      await channel.setTopic(active ? "pi relay active" : "pi relay inactive").catch(() => {});
    }
    if ("setName" in channel) {
      const inactivePrefix = "INACTIVE-";
      if (active && channel.name.startsWith(inactivePrefix)) {
        await channel.setName(channel.name.slice(inactivePrefix.length)).catch(() => {});
      } else if (!active && !channel.name.startsWith(inactivePrefix)) {
        await channel.setName(`${inactivePrefix}${channel.name}`.slice(0, 100)).catch(() => {});
      }
    }
  }

  private async resolveTargetGuild() {
    if (this.config.guild_id) {
      const guild = await this.client.guilds.fetch(this.config.guild_id);
      if (!guild) throw new Error(`Guild not found: ${this.config.guild_id}`);
      return guild;
    }

    const guilds = await this.client.guilds.fetch();
    if (guilds.size !== 1) {
      throw new Error("Set guild_id in discord-relay.json when the bot is in multiple servers.");
    }

    return this.client.guilds.fetch(guilds.first()!.id);
  }

  // ── Outbound ───────────────────────────────────────────────────────────────

  async sendMessage(text: string) {
    if (!this.pairedChannelId) return;
    await this.sendLong(this.pairedChannelId, text);
  }

  async sendApprovalRequest(id: string, method: "confirm" | "select", title: string, extra: { message?: string; options?: string[] }) {
    if (!this.pairedChannelId) return;

    if (method === "confirm") {
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`approve_${id}`).setLabel("Approve").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`deny_${id}`).setLabel("Deny").setStyle(ButtonStyle.Danger),
      );
      await this.send(this.pairedChannelId, `**${title}**\n${extra.message || ""}`, [row]);
    } else if (method === "select" && extra.options) {
      const select = new StringSelectMenuBuilder()
        .setCustomId(`approval_select_${id}`)
        .setPlaceholder("Choose an option")
        .addOptions(extra.options.map((o) => ({ label: o, value: o })));
      await this.send(this.pairedChannelId, `**${title}**`, [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)]);
    }
  }

  async sendNotify(message: string, level: "info" | "warning" | "error") {
    if (!this.pairedChannelId) return;
    const icon = level === "error" ? "x" : level === "warning" ? "!" : "i";
    await this.send(this.pairedChannelId, `[${icon}] ${message}`);
  }

  startTyping() {
    if (!this.pairedChannelId) return;
    this.stopTyping();
    const cid = this.pairedChannelId;
    const tick = async () => {
      try {
        const ch = await this.client.channels.fetch(cid);
        if (ch?.isTextBased() && "sendTyping" in ch) await ch.sendTyping();
      } catch {}
    };
    tick();
    this.typingIntervals.set(cid, setInterval(tick, 8_000));
  }

  stopTyping() {
    for (const [, t] of this.typingIntervals) clearInterval(t);
    this.typingIntervals.clear();
  }

  // ── Event wiring ───────────────────────────────────────────────────────────

  private setupHandlers() {
    this.client.on("interactionCreate", async (interaction: Interaction) => {
      try {
        if (!this.isAuthorized(interaction.user.id)) {
          if (interaction.isRepliable()) await interaction.reply({ content: "Not authorized.", ephemeral: true });
          return;
        }
        if (interaction.isChatInputCommand()) await this.handleCommand(interaction);
        else if (interaction.isButton()) await this.handleButton(interaction);
        else if (interaction.isStringSelectMenu()) await this.handleSelect(interaction);
      } catch (err: any) {
        if (err?.code === 10062) return;
        console.error("[discord-relay] interaction error:", err);
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred)
          await interaction.reply({ content: "Something went wrong.", ephemeral: true }).catch(() => {});
      }
    });

    this.client.on("channelUpdate", async (oldChannel: any, newChannel: any) => {
      if (!this.pairedChannelId || newChannel.id !== this.pairedChannelId) return;
      if (oldChannel.name !== newChannel.name) await this.onChannelRename(newChannel.name);
    });

    this.client.on("messageCreate", async (msg: Message) => {
      if (msg.author.bot || !this.isAuthorized(msg.author.id) || msg.channelId !== this.pairedChannelId) return;
      if (!msg.content && msg.attachments.size === 0) return;

      const images: Array<{ data: string; mimeType: string }> = [];
      for (const [, att] of msg.attachments) {
        if (!att.contentType?.startsWith("image/")) continue;
        try {
          const resp = await fetch(att.url);
          const buf = await resp.arrayBuffer();
          images.push({ data: Buffer.from(buf).toString("base64"), mimeType: att.contentType });
        } catch {}
      }

      await this.onMessage(msg.channelId, msg.content || "See attached image(s)", images);
    });
  }

  private async handleCommand(i: any) {
    const name = i.commandName;
    const sub = i.options.getSubcommand(false);

    if (name === "abort") {
      await i.deferReply({ ephemeral: true });
      if (!this.pairedChannelId) { await i.editReply({ content: "No active session." }); return; }
      this.onAbort();
      await i.editReply({ content: "Aborting..." });

    } else if (name === "model") {
      await i.deferReply({ ephemeral: true });
      if (!this.pairedChannelId) { await i.editReply({ content: "No active session." }); return; }
      const models = this.onModelList();
      if (models.length === 0) { await i.editReply({ content: "No models available." }); return; }

      const options = models.slice(0, 25).map((m) => ({
        label: m.id.length > 100 ? m.id.slice(0, 97) + "..." : m.id,
        description: m.provider,
        value: m.label,
      }));

      const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder().setCustomId("model_select").setPlaceholder("Select a model").addOptions(options),
      );
      await i.editReply({ content: "Select a model:", components: [row] });
    } else if (name === "recap") {
      await i.deferReply({ ephemeral: true });
      if (!this.pairedChannelId) { await i.editReply({ content: "No active session." }); return; }
      await this.onRecap();
      await i.editReply({ content: "Recap requested." });
    }
  }

  private async handleButton(i: any) {
    const cid = i.customId as string;
    if (!cid.startsWith("approve_") && !cid.startsWith("deny_")) return;
    const approve = cid.startsWith("approve_");
    const id = cid.slice(approve ? 8 : 5);
    this.onApprovalResponse(id, { approved: approve });
    await i.update({ content: `${i.message.content}\n\n${approve ? "Approved" : "Denied"}`, components: [] });
  }

  private async handleSelect(i: any) {
    const cid = i.customId as string;

    if (cid === "model_select") {
      const val = i.values[0];
      const idx = val.indexOf("/");
      if (idx > 0) await this.onModel(val.slice(0, idx), val.slice(idx + 1));
      await i.update({ content: `Switching to **${val}**...`, components: [] });
      return;
    }

    if (cid.startsWith("approval_select_")) {
      const id = cid.slice("approval_select_".length);
      this.onApprovalResponse(id, { value: i.values[0] });
      await i.update({ content: `${i.message.content}\n\nSelected: **${i.values[0]}**`, components: [] });
    }
  }

  private async registerCommands() {
    const rest = new REST().setToken(this.config.discord_token);
    const commands = [
      new SlashCommandBuilder().setName("abort").setDescription("Abort current pi operation"),
      new SlashCommandBuilder().setName("model").setDescription("Switch model"),
      new SlashCommandBuilder().setName("recap").setDescription("Ask pi to recap the current work"),
    ];
    const body = commands.map((c) => c.toJSON());

    await rest.put(Routes.applicationCommands(this.client.application!.id), { body });
    for (const guild of this.client.guilds.cache.values()) {
      await rest.put(Routes.applicationGuildCommands(this.client.application!.id, guild.id), { body }).catch(() => {});
    }
  }

  private isAuthorized(userId: string): boolean {
    return userId === this.config.authorized_user_id;
  }

  private async send(channelId: string, content: string, components?: any[]) {
    try {
      const ch = await this.client.channels.fetch(channelId);
      if (ch?.isTextBased() && "send" in ch) await ch.send({ content, components });
    } catch (err) {
      console.error("[discord-relay] send failed:", err);
    }
  }

  private async sendLong(channelId: string, text: string) {
    if (!text) { await this.send(channelId, "_No response._"); return; }
    if (text.length <= MAX_MSG_LENGTH) { await this.send(channelId, text); return; }

    const chunks: string[] = [];
    let cur = "";
    for (const line of text.split("\n")) {
      if (cur.length + line.length + 1 > MAX_MSG_LENGTH) {
        if (cur) chunks.push(cur);
        cur = line;
      } else {
        cur += (cur ? "\n" : "") + line;
      }
    }
    if (cur) chunks.push(cur);

    for (const chunk of chunks) {
      if (chunk.length <= MAX_MSG_LENGTH) { await this.send(channelId, chunk); continue; }
      for (let i = 0; i < chunk.length; i += MAX_MSG_LENGTH) await this.send(channelId, chunk.slice(i, i + MAX_MSG_LENGTH));
    }
  }
}


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
const CHANNEL_STATE_TYPE = "discord-relay-channel";

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

  function updateStatus(ctx?: AnyCtx) {
    const ui = (ctx ?? latestCtx)?.ui;
    if (!ui) return;
    try {
      const theme = ui.theme;
      if (!discord) {
        ui.setStatus("discord-relay", undefined);
      } else if (discord.paired) {
        ui.setStatus("discord-relay", theme.fg("error", "● DISCORD"));
      } else {
        ui.setStatus("discord-relay", theme.fg("dim", "○ discord"));
      }
    } catch {
      if (!discord) {
        ui.setStatus("discord-relay", undefined);
      } else if (discord.paired) {
        ui.setStatus("discord-relay", "● DISCORD");
      } else {
        ui.setStatus("discord-relay", "○ discord");
      }
    }
  }

  function sanitizeStatusText(text: string): string {
    return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
  }

  function formatTokens(count: number): string {
    if (count < 1000) return count.toString();
    if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
    if (count < 1000000) return `${Math.round(count / 1000)}k`;
    if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
    return `${Math.round(count / 1000000)}M`;
  }

  function discordChannelName(ctx: AnyCtx): string {
    const raw = ctx.sessionManager.getSessionName() || basename(ctx.cwd || process.cwd()) || "pi-session";
    const slug = raw
      .replace(/^\[DISCORD\]\s*/i, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
    return slug ? `pi-${slug}` : "pi-session";
  }

  function sessionNameFromChannel(channelName: string): string {
    return channelName.replace(/^pi-/, "").replace(/-/g, " ").trim() || channelName;
  }

  function getStoredChannelId(ctx: AnyCtx): string | undefined {
    let channelId: string | undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === CHANNEL_STATE_TYPE) {
        channelId = (entry.data as { channelId?: string } | undefined)?.channelId;
      }
    }
    return channelId;
  }

  function storeChannelId(channelId: string) {
    pi.appendEntry(CHANNEL_STATE_TYPE, { channelId });
  }

  function loadEnabledModelLabels(): Set<string> | null {
    const settingsPath = join(homedir(), ".pi", "agent", "settings.json");
    if (!existsSync(settingsPath)) return null;
    try {
      const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as { enabledModels?: string[] };
      return Array.isArray(settings.enabledModels) ? new Set(settings.enabledModels) : null;
    } catch {
      return null;
    }
  }

  function installFooter(ctx: AnyCtx) {
    ctx.ui.setFooter((tui, theme, footerData) => {
      return {
        render(width: number): string[] {
          let totalInput = 0;
          let totalOutput = 0;
          let totalCacheRead = 0;
          let totalCacheWrite = 0;
          let totalCost = 0;

          for (const entry of ctx.sessionManager.getEntries()) {
            if (entry.type === "message" && entry.message.role === "assistant") {
              totalInput += entry.message.usage.input;
              totalOutput += entry.message.usage.output;
              totalCacheRead += entry.message.usage.cacheRead;
              totalCacheWrite += entry.message.usage.cacheWrite;
              totalCost += entry.message.usage.cost.total;
            }
          }

          const contextUsage = ctx.getContextUsage();
          const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
          const contextPercentValue = contextUsage?.percent ?? 0;
          const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";

          let pwd = ctx.cwd || process.cwd();
          const home = process.env.HOME || process.env.USERPROFILE;
          if (home && pwd.startsWith(home)) pwd = `~${pwd.slice(home.length)}`;

          const branch = footerData.getGitBranch();
          if (branch) pwd = `${pwd} (${branch})`;

          const sessionName = ctx.sessionManager.getSessionName();
          if (sessionName) pwd = `${pwd} • ${sessionName}`;

          const statsParts: string[] = [];
          if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
          if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);
          if (totalCacheRead) statsParts.push(`R${formatTokens(totalCacheRead)}`);
          if (totalCacheWrite) statsParts.push(`W${formatTokens(totalCacheWrite)}`);
          if (totalCost) statsParts.push(`$${totalCost.toFixed(3)}`);

          const contextDisplay = contextPercent === "?"
            ? `?/${formatTokens(contextWindow)}`
            : `${contextPercent}%/${formatTokens(contextWindow)}`;

          let contextPercentStr = contextDisplay;
          if (contextPercentValue > 90) contextPercentStr = theme.fg("error", contextDisplay);
          else if (contextPercentValue > 70) contextPercentStr = theme.fg("warning", contextDisplay);
          statsParts.push(contextPercentStr);

          const extensionStatuses = footerData.getExtensionStatuses();
          if (extensionStatuses.size > 0) {
            const statusLine = Array.from(extensionStatuses.entries())
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([, text]) => sanitizeStatusText(text))
              .join(" ");
            if (statusLine) statsParts.push(statusLine);
          }

          let statsLeft = statsParts.join(" ");
          let statsLeftWidth = visibleWidth(statsLeft);
          if (statsLeftWidth > width) {
            statsLeft = truncateToWidth(statsLeft, width, "...");
            statsLeftWidth = visibleWidth(statsLeft);
          }

          const modelName = ctx.model?.id || "no-model";
          const rightSide = modelName;
          const rightSideWidth = visibleWidth(rightSide);
          const minPadding = 2;
          const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;

          let statsLine: string;
          if (totalNeeded <= width) {
            const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
            statsLine = statsLeft + padding + rightSide;
          } else {
            const availableForRight = width - statsLeftWidth - minPadding;
            if (availableForRight > 0) {
              const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
              const truncatedRightWidth = visibleWidth(truncatedRight);
              const padding = " ".repeat(Math.max(0, width - statsLeftWidth - truncatedRightWidth));
              statsLine = statsLeft + padding + truncatedRight;
            } else {
              statsLine = statsLeft;
            }
          }

          const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));
          const dimStats = theme.fg("dim", statsLine);
          return [pwdLine, dimStats];
        },
        invalidate() {},
        dispose: footerData.onBranchChange(() => tui.requestRender()),
      };
    });
  }

  function getModelName(): string {
    return latestCtx?.model?.id || "unknown";
  }

  function getCwd(): string {
    return latestCtx?.cwd || process.cwd();
  }

  function buildFooter(): string {
    const thinking = pi.getThinkingLevel?.() ?? "off";
    const usage = latestCtx?.getContextUsage?.();
    const context = usage?.percent != null ? `${usage.percent.toFixed(1)}%` : "?%";
    return `\n\n-# ${getCwd()} · ${getModelName()} · thinking ${thinking} · ctx ${context}`;
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
    const enabled = loadEnabledModelLabels();
    const models = latestCtx?.modelRegistry?.getAvailable() || [];
    return models
      .map((m: any) => ({ provider: m.provider, id: m.id, label: `${m.provider}/${m.id}` }))
      .filter((m) => !enabled || enabled.has(m.label));
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
          ctx.ui.notify("Discord relay starting...", "info");
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

          discord.onRecap = async () => {
            if (!latestCtx) return;
            const deliverAs = latestCtx.isIdle() ? undefined : ("followUp" as const);
            pi.sendUserMessage("remind me what we were doing", deliverAs ? { deliverAs } : undefined);
            discord?.startTyping();
          };

          discord.onChannelRename = async (name) => {
            const sessionName = sessionNameFromChannel(name);
            pi.setSessionName(`[DISCORD] ${sessionName}`);
            hasPrefixedName = true;
          };

          discord.onRc = async (action) => {
            if (action === "start") {
              hasPrefixedName = false;
              pi.events.emit("discord-relay", { connected: true });
              wireApprovalHandler();
              updateStatus(ctx);
              ctx.ui.notify("Discord channel paired.", "info");
            } else {
              pi.events.emit("discord-relay", { connected: false });
              updateStatus(ctx);
              ctx.ui.notify("Discord channel unpaired.", "info");
            }
          };

          await discord.connect();
          const channelId = await discord.createAndPairChannel(discordChannelName(ctx), getStoredChannelId(ctx));
          storeChannelId(channelId);
          updateStatus(ctx);
          ctx.ui.notify(`Discord relay started and paired with Discord channel ${channelId}.`, "info");
          void discord.sendMessage(`Relay connected.${buildFooter()}`);
        } catch (err) {
          ctx.ui.notify(`Failed: ${err instanceof Error ? err.message : err}`, "error");
          discord = null;
          updateStatus(ctx);
        }

      } else if (sub === "stop") {
        if (!discord) { ctx.ui.notify("Discord relay not running.", "warning"); return; }
        const current = discord;
        discord = null;
        pi.events.emit("discord-relay", { connected: false });
        updateStatus(ctx);
        ctx.ui.notify("Discord relay stopping...", "info");

        try {
          await Promise.race([
            current.unpair(),
            new Promise((resolve) => setTimeout(resolve, 2_000)),
          ]);
        } finally {
          await current.disconnect().catch(() => {});
        }

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

  pi.on("session_start", async (_event, ctx) => {
    captureCtx(ctx);
    hasPrefixedName = false;
    installFooter(ctx);
    updateStatus(ctx);
  });

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

  pi.on("session_shutdown", () => {
    if (!discord) return;

    const current = discord;
    discord = null;
    pi.events.emit("discord-relay", { connected: false });
    updateStatus();

    // Do not block pi reload/shutdown on Discord REST calls. Discord cleanup is
    // best-effort; awaiting it here can hang /reload if Discord is slow.
    void (async () => {
      try {
        await Promise.race([
          current.markInactive(),
          new Promise((resolve) => setTimeout(resolve, 2_000)),
        ]);
      } finally {
        await current.disconnect().catch(() => {});
      }
    })();
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
