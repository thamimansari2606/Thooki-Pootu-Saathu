// Browser WebSocket client. Named events, request/ack correlation, automatic reconnection with
// backoff, and a persistent guest identity token in localStorage.
type Handler = (data: any) => void;

export type ConnState = "connecting" | "open" | "reconnecting" | "closed";

const TOKEN_KEY = "tps.token";

export class GameClient {
  private url: string;
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<Handler>>();
  private pending = new Map<string, { resolve: (d: any) => void; reject: (e: Error) => void; timer: number }>();
  private seq = 0;
  private attempts = 0;
  private closedByUser = false;
  private stateListeners = new Set<(s: ConnState) => void>();
  private state: ConnState = "closed";
  private helloPayload: { name: string; avatar: string } | null = null;
  readonly onSession?: (s: { publicId: string; token: string; roomCode: string | null }) => void;

  constructor(url: string) {
    this.url = url;
  }

  static loadToken(): string | null {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  }

  static saveToken(token: string): void {
    try {
      localStorage.setItem(TOKEN_KEY, token);
    } catch {
      // Storage may be unavailable (private mode); the session still works for this page.
    }
  }

  get connState(): ConnState {
    return this.state;
  }

  onState(fn: (s: ConnState) => void): () => void {
    this.stateListeners.add(fn);
    fn(this.state);
    return () => this.stateListeners.delete(fn);
  }

  on(event: string, fn: Handler): () => void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(fn);
    return () => this.handlers.get(event)?.delete(fn);
  }

  private setState(s: ConnState) {
    this.state = s;
    for (const fn of this.stateListeners) fn(s);
  }

  connect(identity: { name: string; avatar: string }): void {
    this.helloPayload = identity;
    this.closedByUser = false;
    this.open();
  }

  private open() {
    this.setState(this.attempts === 0 ? "connecting" : "reconnecting");
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.attempts = 0;
      this.setState("open");
      const token = GameClient.loadToken();
      this.rawSend("hello", { ...this.helloPayload, token: token ?? undefined }, "hello");
    };
    ws.onmessage = (ev) => {
      let msg: { event: string; data: any; reqId?: string };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.event === "ack" || msg.event === "error") {
        this.settle(msg);
        if (msg.reqId === "hello" && msg.event === "ack" && msg.data?.token) {
          GameClient.saveToken(msg.data.token);
          this.handlers.get("session")?.forEach((fn) => fn(msg.data));
        }
        return;
      }
      this.handlers.get(msg.event)?.forEach((fn) => fn(msg.data));
    };
    ws.onclose = () => {
      this.failPending("DISCONNECTED");
      if (this.closedByUser) {
        this.setState("closed");
        return;
      }
      this.attempts++;
      this.setState("reconnecting");
      const delay = Math.min(8000, 300 * 2 ** Math.min(this.attempts, 5));
      setTimeout(() => {
        if (!this.closedByUser) this.open();
      }, delay);
    };
  }

  private settle(msg: { event: string; data: any; reqId?: string }) {
    if (!msg.reqId) return;
    const p = this.pending.get(msg.reqId);
    if (!p) return;
    this.pending.delete(msg.reqId);
    clearTimeout(p.timer);
    if (msg.event === "ack") p.resolve(msg.data);
    else p.reject(new Error(msg.data?.code ?? "ERROR"));
  }

  private failPending(code: string) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(code));
      this.pending.delete(id);
    }
  }

  private rawSend(event: string, data: unknown, reqId: string) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ event, data, reqId }));
    }
  }

  /** Sends a request and resolves with the server's ack payload, or rejects with its error code. */
  request<T = any>(event: string, data: unknown = {}, timeoutMs = 8000): Promise<T> {
    const reqId = `q${++this.seq}`;
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error("TIMEOUT"));
      }, timeoutMs);
      this.pending.set(reqId, { resolve, reject, timer });
      this.rawSend(event, data, reqId);
    });
  }

  /** Fire-and-forget intent (used for 20 Hz movement input). */
  fire(event: string, data: unknown): void {
    this.rawSend(event, data, "");
  }

  close(): void {
    this.closedByUser = true;
    this.ws?.close();
  }
}
