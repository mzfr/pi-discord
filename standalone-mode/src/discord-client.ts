/**
 * Discord client wrapper.
 * Handles bot connection, slash commands, interactions, and message relay.
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
  type Message,
  type Interaction,
} from "discord.js";
import type { DiscordRelayConfig } from "./config.js";

const MAX_MSG_LENGTH = 2000;

export type MessageHandler = (channelId: string, text: string, images: Array<{ data: string; mimeType: string }>) => void | Promise<void>;
export type AbortHandler = () => void;
export type ModelHandler = (provider: string, modelId: string) => void | Promise<void>;
export type ModelListHandler = () => Array<{ provider: string; id: string; label: string }>;
export type ApprovalResponseHandler = (id: string, result: { approved?: boolean; value?: string }) => void;
export type RcHandler = (action: "start" | "stop") => void | Promise<void>;

export class DiscordClient {
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
      } catch (err) {
        console.error("[discord-relay] interaction error:", err);
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred)
          await interaction.reply({ content: "Something went wrong.", ephemeral: true }).catch(() => {});
      }
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

    if (name === "rc" && sub === "start") {
      if (this.pairedChannelId) {
        await i.reply({ content: `Already paired with <#${this.pairedChannelId}>. Use \`/rc stop\` first.`, ephemeral: true });
        return;
      }
      this.pairedChannelId = i.channelId;
      await this.onRc("start");
      await i.reply("Connected to pi. Messages in this channel will be relayed.");

    } else if (name === "rc" && sub === "stop") {
      if (!this.pairedChannelId) { await i.reply({ content: "No active session.", ephemeral: true }); return; }
      this.pairedChannelId = null;
      await this.onRc("stop");
      await i.reply("Disconnected. Pi session is still running locally.");

    } else if (name === "abort") {
      if (!this.pairedChannelId) { await i.reply({ content: "No active session.", ephemeral: true }); return; }
      this.onAbort();
      await i.reply({ content: "Aborting...", ephemeral: true });

    } else if (name === "model") {
      if (!this.pairedChannelId) { await i.reply({ content: "No active session.", ephemeral: true }); return; }
      const models = this.onModelList();
      if (models.length === 0) { await i.reply({ content: "No models available.", ephemeral: true }); return; }

      const options = models.slice(0, 25).map((m) => ({
        label: m.id.length > 100 ? m.id.slice(0, 97) + "..." : m.id,
        description: m.provider,
        value: m.label,
      }));

      const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder().setCustomId("model_select").setPlaceholder("Select a model").addOptions(options),
      );
      await i.reply({ content: "Select a model:", components: [row], ephemeral: true });
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
      new SlashCommandBuilder().setName("rc").setDescription("Remote control pi session")
        .addSubcommand((s) => s.setName("start").setDescription("Pair this channel with pi"))
        .addSubcommand((s) => s.setName("stop").setDescription("Unpair this channel")),
      new SlashCommandBuilder().setName("abort").setDescription("Abort current pi operation"),
      new SlashCommandBuilder().setName("model").setDescription("Switch model"),
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
