/**
 * Simple JSON-lines socket connection wrapper.
 * Handles framing, parsing, and send/receive over a net.Socket.
 */

import type { Socket } from "node:net";

export class SocketConnection {
  private socket: Socket;
  private buffer = "";
  private onMessage: (msg: any) => void;

  constructor(socket: Socket, onMessage: (msg: any) => void) {
    this.socket = socket;
    this.onMessage = onMessage;

    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.handleData(chunk));
    socket.on("error", () => {}); // Errors handled via close
  }

  private handleData(chunk: string) {
    this.buffer += chunk;
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        this.onMessage(msg);
      } catch {
        // Ignore malformed lines
      }
    }
  }

  send(msg: unknown) {
    if (this.socket.writable) {
      this.socket.write(JSON.stringify(msg) + "\n");
    }
  }

  close() {
    this.socket.end();
  }

  get alive(): boolean {
    return this.socket.writable;
  }
}
