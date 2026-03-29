/**
 * Discord bot — slash commands and message handling.
 */

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
  type ChatInputCommandInteraction,
  type ButtonInteraction,
  type StringSelectMenuInteraction,
  type Message,
  type Interaction,
} from "discord.js";
import type { DaemonConfig, ExtensionMessage } from "../shared/protocol.js";
import { SessionManager } from "./session-manager.js";

const MAX_DISCORD_LENGTH = 2000;

export class DiscordBot {
  private client: Client;
  private config: DaemonConfig;
  private sessions: SessionManager;
  private messageQueues = new Map<string, string[]>(); // channelId -> queued messages
  private typingIntervals = new Map<string, NodeJS.Timeout>(); // channelId -> typing loop

  constructor(config: DaemonConfig, sessions: SessionManager) {
    this.config = config;
    this.sessions = sessions;

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });

    this.setupEventHandlers();
    this.setupSessionListeners();
  }

  async start() {
    await this.client.login(this.config.discord_token);
    console.log(`[daemon] Discord bot connected`);

    // Reconnect persisted sessions
    await this.sessions.reconnectFromState();
    const reconnected = this.sessions.getAllSessions();
    if (reconnected.length > 0) {
      console.log(`[daemon] Reconnected ${reconnected.length} session(s)`);
    }
  }

  async stop() {
    this.client.destroy();
  }

  // ── Command registration ───────────────────────────────────────────────────

  private async registerCommands() {
    const rest = new REST().setToken(this.config.discord_token);

    const rcCommand = new SlashCommandBuilder()
      .setName("rc")
      .setDescription("Remote control pi sessions")
      .addSubcommand((sub) =>
        sub.setName("start").setDescription("Start or connect to a pi session")
      )
      .addSubcommand((sub) =>
        sub.setName("stop").setDescription("Disconnect from current pi session")
      )
      .addSubcommand((sub) =>
        sub.setName("list").setDescription("List running pi sessions")
      );

    const abortCommand = new SlashCommandBuilder()
      .setName("abort")
      .setDescription("Abort current pi operation");

    const modelCommand = new SlashCommandBuilder()
      .setName("model")
      .setDescription("Switch model")
      .addStringOption((opt) =>
        opt.setName("model").setDescription("provider/model-id").setRequired(true)
      );

    const commands = [rcCommand, abortCommand, modelCommand];

    try {
      await rest.put(Routes.applicationCommands(this.client.application?.id || ""), {
        body: commands.map((c) => c.toJSON()),
      });
    } catch {
      // Commands will be registered on ready
    }
  }

  // ── Event handlers ─────────────────────────────────────────────────────────

  private setupEventHandlers() {
    this.client.on("ready", async () => {
      console.log(`[daemon] Logged in as ${this.client.user?.tag}`);
      await this.registerCommands();
    });

    this.client.on("interactionCreate", async (interaction: Interaction) => {
      if (!this.isAuthorized(interaction.user.id)) return;

      if (interaction.isChatInputCommand()) {
        await this.handleSlashCommand(interaction);
      } else if (interaction.isButton()) {
        await this.handleButton(interaction);
      } else if (interaction.isStringSelectMenu()) {
        await this.handleSelectMenu(interaction);
      }
    });

    this.client.on("messageCreate", async (message: Message) => {
      if (message.author.bot) return;
      if (!this.isAuthorized(message.author.id)) return;

      const channelId = message.channelId;
      const session = this.sessions.getSession(channelId);
      if (!session) return; // No session paired, ignore

      await this.relayMessage(channelId, message);
    });
  }

  private setupSessionListeners() {
    this.sessions.on("extension_message", (channelId: string, msg: ExtensionMessage) => {
      this.handleExtensionMessage(channelId, msg).catch((err) => {
        console.error(`[daemon] Error handling extension message for ${channelId}:`, err);
      });
    });

    this.sessions.on("session_disconnected", (channelId: string, projectName: string) => {
      this.sendToChannel(channelId, `❌ Session "${projectName}" disconnected. Pi may have crashed. Use \`/rc start\` to reconnect.`);
    });

    this.sessions.on("reconnect_failed", (pairing: any) => {
      if (pairing.channelId) {
        this.sendToChannel(pairing.channelId, `⚠️ Could not reconnect to session "${pairing.projectName}".`);
      }
    });
  }

  // ── Slash commands ─────────────────────────────────────────────────────────

  private async handleSlashCommand(interaction: ChatInputCommandInteraction) {
    const name = interaction.commandName;
    const sub = interaction.options.getSubcommand(false);

    if (name === "rc" && sub === "start") {
      await this.handleRcStart(interaction);
    } else if (name === "rc" && sub === "stop") {
      await this.handleRcStop(interaction);
    } else if (name === "rc" && sub === "list") {
      await this.handleRcList(interaction);
    } else if (name === "abort") {
      await this.handleAbort(interaction);
    } else if (name === "model") {
      await this.handleModel(interaction);
    }
  }

  private async handleRcStart(interaction: ChatInputCommandInteraction) {
    const channelId = interaction.channelId;

    // Check if already paired
    const existing = this.sessions.getSession(channelId);
    if (existing) {
      await interaction.reply({
        content: `Already connected to **${existing.projectName}**. Use \`/rc stop\` first.`,
        ephemeral: true,
      });
      return;
    }

    // Show project picker
    const projects = this.config.projects;
    if (projects.length === 0) {
      await interaction.reply({
        content: "No projects configured. Add projects to `~/.pi/discord/config.json`.",
        ephemeral: true,
      });
      return;
    }

    const select = new StringSelectMenuBuilder()
      .setCustomId("rc_start_project")
      .setPlaceholder("Select a project")
      .addOptions(
        projects.map((p) => ({
          label: p.name,
          description: p.path,
          value: p.name,
        }))
      );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
    await interaction.reply({
      content: "Select a project to start:",
      components: [row],
      ephemeral: true,
    });
  }

  private async handleRcStop(interaction: ChatInputCommandInteraction) {
    const channelId = interaction.channelId;
    const projectName = await this.sessions.stopSession(channelId);

    if (projectName) {
      await interaction.reply(`Disconnected from **${projectName}**. Pi session is still running in tmux.`);
    } else {
      await interaction.reply({ content: "No active session in this channel.", ephemeral: true });
    }
  }

  private async handleRcList(interaction: ChatInputCommandInteraction) {
    const running = this.sessions.getRunningProjects();

    if (running.length === 0) {
      await interaction.reply({ content: "No pi sessions running.", ephemeral: true });
      return;
    }

    const lines = running.map((r) => {
      const status = r.paired ? `paired with <#${r.channelId}>` : "not paired";
      return `**${r.name}** — ${status}`;
    });

    await interaction.reply({
      content: `**Running sessions:**\n${lines.join("\n")}`,
      ephemeral: true,
    });
  }

  private async handleAbort(interaction: ChatInputCommandInteraction) {
    const channelId = interaction.channelId;
    const sent = this.sessions.sendToSession(channelId, { type: "abort" });

    if (sent) {
      await interaction.reply({ content: "Aborting...", ephemeral: true });
    } else {
      await interaction.reply({ content: "No active session in this channel.", ephemeral: true });
    }
  }

  private async handleModel(interaction: ChatInputCommandInteraction) {
    const channelId = interaction.channelId;
    const modelStr = interaction.options.getString("model", true);
    const slashIdx = modelStr.indexOf("/");

    if (slashIdx <= 0) {
      await interaction.reply({
        content: "Format: `provider/model-id` (e.g., `anthropic/claude-sonnet-4-6`)",
        ephemeral: true,
      });
      return;
    }

    const provider = modelStr.slice(0, slashIdx);
    const modelId = modelStr.slice(slashIdx + 1);
    const sent = this.sessions.sendToSession(channelId, {
      type: "set_model",
      provider,
      modelId,
    });

    if (sent) {
      await interaction.reply({ content: `Switching to **${modelStr}**...`, ephemeral: true });
    } else {
      await interaction.reply({ content: "No active session in this channel.", ephemeral: true });
    }
  }

  // ── Select menu handler ─────────────────────────────────────────────────────

  private async handleSelectMenu(interaction: StringSelectMenuInteraction) {
    // Approval select menus
    if (interaction.customId.startsWith("approval_select_")) {
      const approvalId = interaction.customId.slice("approval_select_".length);
      const value = interaction.values[0];
      const channelId = interaction.channelId;

      this.sessions.sendToSession(channelId, {
        type: "approval_response",
        id: approvalId,
        value,
      });

      await interaction.update({
        content: `${interaction.message.content}\n\n✅ Selected: **${value}**`,
        components: [],
      });
      return;
    }

    if (interaction.customId !== "rc_start_project") return;

    const projectName = interaction.values[0];
    const project = this.config.projects.find((p) => p.name === projectName);
    if (!project) {
      await interaction.update({ content: `Project "${projectName}" not found.`, components: [] });
      return;
    }

    await interaction.update({ content: `Starting **${projectName}**...`, components: [] });

    try {
      await this.sessions.startSession(project, interaction.channelId);
      await this.sendToChannel(
        interaction.channelId,
        `✅ Connected to **${projectName}** (\`${project.path}\`). Messages in this channel will be relayed to pi.`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.sendToChannel(interaction.channelId, `❌ Failed to start: ${msg}`);
    }
  }

  // ── Button handler (approval responses) ────────────────────────────────────

  private async handleButton(interaction: ButtonInteraction) {
    const customId = interaction.customId;

    // Approval buttons: approve_<id> or deny_<id>
    if (customId.startsWith("approve_") || customId.startsWith("deny_")) {
      const parts = customId.split("_");
      const action = parts[0]; // "approve" or "deny"
      const approvalId = parts.slice(1).join("_");
      const channelId = interaction.channelId;

      this.sessions.sendToSession(channelId, {
        type: "approval_response",
        id: approvalId,
        approved: action === "approve",
      });

      const label = action === "approve" ? "✅ Approved" : "❌ Denied";
      await interaction.update({ content: `${interaction.message.content}\n\n${label}`, components: [] });
    }
  }

  // ── Message relay ──────────────────────────────────────────────────────────

  private async relayMessage(channelId: string, message: Message) {
    const text = message.content;
    if (!text && message.attachments.size === 0) return;

    // Handle file attachments
    const images: Array<{ data: string; mimeType: string }> = [];
    for (const [, attachment] of message.attachments) {
      if (attachment.contentType?.startsWith("image/")) {
        try {
          const response = await fetch(attachment.url);
          const buffer = await response.arrayBuffer();
          const base64 = Buffer.from(buffer).toString("base64");
          images.push({ data: base64, mimeType: attachment.contentType });
        } catch {
          // Skip failed downloads
        }
      }
    }

    const sent = this.sessions.sendToSession(channelId, {
      type: "message",
      text: text || "See attached image(s)",
      images: images.length > 0 ? images : undefined,
    });

    if (sent) {
      this.startTyping(channelId);
    }
  }

  // ── Extension message handling ─────────────────────────────────────────────

  private async handleExtensionMessage(channelId: string, msg: ExtensionMessage) {
    switch (msg.type) {
      case "response":
        await this.handleResponse(channelId, msg);
        break;
      case "approval_request":
        await this.handleApprovalRequest(channelId, msg);
        break;
      case "notify":
        await this.handleNotify(channelId, msg);
        break;
      case "error":
        await this.sendToChannel(channelId, `❌ ${msg.message}`);
        break;
      case "session_name":
        // Could update channel topic, for now just log
        console.log(`[daemon] Session name for ${channelId}: ${msg.name}`);
        break;
      case "status":
        if (msg.streaming) {
          this.startTyping(channelId);
        } else {
          this.stopTyping(channelId);
        }
        break;
    }
  }

  private async handleResponse(channelId: string, msg: Extract<ExtensionMessage, { type: "response" }>) {
    this.stopTyping(channelId);
    let text = msg.text;

    // Add cost footer if available
    if (msg.usage && msg.usage.cost > 0) {
      const formatTokens = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
      const footer = `\n\n-# tokens: ${formatTokens(msg.usage.input)} in / ${formatTokens(msg.usage.output)} out | cost: $${msg.usage.cost.toFixed(4)}`;
      text += footer;
    }

    await this.sendLongMessage(channelId, text);
  }

  private async handleApprovalRequest(channelId: string, msg: Extract<ExtensionMessage, { type: "approval_request" }>) {
    if (msg.method === "confirm") {
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`approve_${msg.id}`)
          .setLabel("Approve")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`deny_${msg.id}`)
          .setLabel("Deny")
          .setStyle(ButtonStyle.Danger),
      );

      await this.sendToChannel(
        channelId,
        `⚠️ **${msg.title}**\n${msg.message}`,
        [row],
      );
    } else if (msg.method === "select") {
      const select = new StringSelectMenuBuilder()
        .setCustomId(`approval_select_${msg.id}`)
        .setPlaceholder("Choose an option")
        .addOptions(
          msg.options.map((opt) => ({ label: opt, value: opt }))
        );

      const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
      await this.sendToChannel(channelId, `⚠️ **${msg.title}**`, [row]);
    }
  }

  private async handleNotify(channelId: string, msg: Extract<ExtensionMessage, { type: "notify" }>) {
    const emoji = msg.level === "error" ? "❌" : msg.level === "warning" ? "⚠️" : "ℹ️";
    await this.sendToChannel(channelId, `${emoji} ${msg.message}`);
  }

  // ── Utilities ──────────────────────────────────────────────────────────────

  private isAuthorized(userId: string): boolean {
    return userId === this.config.authorized_user_id;
  }

  private startTyping(channelId: string) {
    this.stopTyping(channelId);
    const doType = async () => {
      try {
        const channel = await this.client.channels.fetch(channelId);
        if (channel?.isTextBased() && "sendTyping" in channel) {
          await channel.sendTyping();
        }
      } catch {}
    };
    doType();
    this.typingIntervals.set(channelId, setInterval(doType, 8_000));
  }

  private stopTyping(channelId: string) {
    const interval = this.typingIntervals.get(channelId);
    if (interval) {
      clearInterval(interval);
      this.typingIntervals.delete(channelId);
    }
  }

  private async sendToChannel(channelId: string, content: string, components?: any[]) {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel?.isTextBased() && "send" in channel) {
        await channel.send({ content, components });
      }
    } catch (err) {
      console.error(`[daemon] Failed to send to ${channelId}:`, err);
    }
  }

  private async sendLongMessage(channelId: string, text: string) {
    if (!text) {
      await this.sendToChannel(channelId, "_No response text._");
      return;
    }

    // Split on Discord's 2000 char limit
    if (text.length <= MAX_DISCORD_LENGTH) {
      await this.sendToChannel(channelId, text);
      return;
    }

    // Split at line boundaries
    const chunks: string[] = [];
    let current = "";
    for (const line of text.split("\n")) {
      if (current.length + line.length + 1 > MAX_DISCORD_LENGTH) {
        if (current) chunks.push(current);
        current = line;
      } else {
        current += (current ? "\n" : "") + line;
      }
    }
    if (current) chunks.push(current);

    // If a single line exceeds the limit, force-split
    const finalChunks: string[] = [];
    for (const chunk of chunks) {
      if (chunk.length <= MAX_DISCORD_LENGTH) {
        finalChunks.push(chunk);
      } else {
        for (let i = 0; i < chunk.length; i += MAX_DISCORD_LENGTH) {
          finalChunks.push(chunk.slice(i, i + MAX_DISCORD_LENGTH));
        }
      }
    }

    for (const chunk of finalChunks) {
      await this.sendToChannel(channelId, chunk);
    }
  }
}
