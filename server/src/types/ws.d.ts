// Minimal typings for the subset of `ws` used by the server (the @types/ws package is not installed here).
declare module "ws" {
  import type { Server as HttpServer, IncomingMessage } from "node:http";
  import type { EventEmitter } from "node:events";
  export type RawData = Buffer | ArrayBuffer | Buffer[];
  export class WebSocket extends EventEmitter {
    constructor(address: string);
    static readonly CONNECTING: 0;
    static readonly OPEN: 1;
    static readonly CLOSING: 2;
    static readonly CLOSED: 3;
    readonly readyState: number;
    send(data: string | Buffer): void;
    close(code?: number, reason?: string): void;
    terminate(): void;
    on(event: "message", listener: (data: RawData) => void): this;
    on(event: "close", listener: () => void): this;
    on(event: "error", listener: (err: Error) => void): this;
    on(event: string, listener: (...args: any[]) => void): this;
  }
  export interface ServerOptions {
    server?: HttpServer;
    path?: string;
    maxPayload?: number;
    verifyClient?: (info: { origin: string; req: IncomingMessage }, done: (ok: boolean, code?: number, message?: string) => void) => void;
  }
  export class WebSocketServer extends EventEmitter {
    readonly clients: Set<WebSocket>;
    constructor(options: ServerOptions);
    on(event: "connection", listener: (socket: WebSocket, req: IncomingMessage) => void): this;
    on(event: string, listener: (...args: any[]) => void): this;
    close(cb?: (err?: Error) => void): void;
  }
}
