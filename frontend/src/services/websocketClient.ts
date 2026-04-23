import type { InboundChatPayload, OutboundChatPayload } from "../types/chat";

type Listener = (payload: InboundChatPayload) => void;

export class ChatWebSocketClient {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private readonly url: string;
  private hasConnected = false;
  private connectPromise: Promise<void> | null = null;

  constructor(url: string) {
    this.url = url;
  }

  connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
      this.connectPromise = new Promise((resolve, reject) => {
        const socket = this.ws;
        if (!socket) {
          reject(new Error("WebSocket not initialized"));
          return;
        }

        socket.addEventListener("open", () => {
          this.connectPromise = null;
          resolve();
        }, { once: true });
        socket.addEventListener("error", () => {
          this.connectPromise = null;
          reject(new Error("WebSocket connection failed"));
        }, { once: true });
      });
      return this.connectPromise;
    }

    this.connectPromise = new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.hasConnected = false;

      this.ws.onopen = () => {
        this.hasConnected = true;
        this.connectPromise = null;
        resolve();
      };
      this.ws.onerror = () => {
        this.connectPromise = null;
        reject(new Error("WebSocket connection failed"));
      };
      this.ws.onclose = () => {
        // Only surface closure after at least one successful connection.
        if (!this.hasConnected) {
          return;
        }
        this.listeners.forEach((listener) =>
          listener({
            type: "error",
            message: "Connection closed. Please send again.",
          }),
        );
      };
      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as InboundChatPayload;
          this.listeners.forEach((listener) => listener(data));
        } catch {
          this.listeners.forEach((listener) =>
            listener({
              type: "error",
              message: "Received malformed response from server",
            }),
          );
        }
      };
    });

    return this.connectPromise;
  }

  disconnect(): void {
    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.close();
      }
      this.ws = null;
    }
  }

  send(payload: OutboundChatPayload): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not connected");
    }
    this.ws.send(JSON.stringify(payload));
  }

  isOpen(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  onMessage(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
