import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DiscordRelay } from "./relay.js";

export default function registerDiscordRelay(pi: ExtensionAPI) {
  const relay = new DiscordRelay(pi);
  relay.register();
}
