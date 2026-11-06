/**
 * The hibernatable WebSocket surface of an actor. `new WebSocketPair()` returns two linked
 * sockets. The actor accepts the server end. The core HTTP server attaches the client end of a
 * 101 response to a real Bun `ServerWebSocket` (see `attachClient`).
 */

type Data = string | ArrayBuffer | ArrayBufferView;

export class PairSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = PairSocket.OPEN;
  peer!: PairSocket;
  #sink: ((data: string | ArrayBuffer) => void) | null = null;
  #onClose: ((code: number, reason: string) => void) | null = null;
  /** Data and a close that arrive before a sink is attached. They are delivered on attach. */
  #pending: (string | ArrayBuffer)[] = [];
  #pendingClose: { code: number; reason: string } | null = null;
  #attachment: unknown = null;
  #listeners = new Map<string, Set<(event: unknown) => void>>();

  accept(): void {}

  send(data: Data): void {
    if (this.readyState !== PairSocket.OPEN) throw new Error("WebSocket is not open");
    const payload =
      typeof data === "string"
        ? data
        : data instanceof ArrayBuffer
          ? data
          : (data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
    this.peer.receive(payload);
  }

  /** Receives what the peer sends. The client end forwards it to the real socket. */
  set sink(fn: ((data: string | ArrayBuffer) => void) | null) {
    this.#sink = fn;
    if (!fn) return;
    for (const data of this.#pending.splice(0)) fn(data);
  }

  set onClose(fn: ((code: number, reason: string) => void) | null) {
    this.#onClose = fn;
    if (fn && this.#pendingClose) {
      const { code, reason } = this.#pendingClose;
      this.#pendingClose = null;
      fn(code, reason);
    }
  }

  receive(data: string | ArrayBuffer): void {
    const listeners = this.#listeners.get("message");
    if (this.#sink) this.#sink(data);
    else if (!listeners?.size) this.#pending.push(data);
    for (const fn of listeners ?? []) fn({ data });
  }

  /** Closes this end. Only the peer hears about it, as with a real socket. */
  close(code = 1000, reason = ""): void {
    if (this.readyState === PairSocket.CLOSED) return;
    this.readyState = PairSocket.CLOSED;
    this.peer.closedByPeer(code, reason);
  }

  closedByPeer(code: number, reason: string): void {
    if (this.readyState === PairSocket.CLOSED) return;
    this.readyState = PairSocket.CLOSED;
    if (this.#onClose) this.#onClose(code, reason);
    else this.#pendingClose = { code, reason };
    for (const fn of this.#listeners.get("close") ?? []) fn({ code, reason, wasClean: true });
  }

  addEventListener(type: string, fn: (event: unknown) => void): void {
    const set = this.#listeners.get(type) ?? new Set();
    this.#listeners.set(type, set);
    set.add(fn);
  }

  removeEventListener(type: string, fn: (event: unknown) => void): void {
    this.#listeners.get(type)?.delete(fn);
  }

  serializeAttachment(value: unknown): void {
    this.#attachment = structuredClone(value);
  }

  deserializeAttachment(): unknown {
    return structuredClone(this.#attachment);
  }
}

export class WebSocketPair {
  0: PairSocket;
  1: PairSocket;
  constructor() {
    const client = new PairSocket();
    const server = new PairSocket();
    client.peer = server;
    server.peer = client;
    this[0] = client;
    this[1] = server;
  }
}

export class WebSocketRequestResponsePair {
  constructor(
    readonly request: string,
    readonly response: string,
  ) {}
}

const NativeResponse = globalThis.Response;

/** A Response that also carries a 101 upgrade and its client socket, as Workers allow. */
class UpgradeResponse extends NativeResponse {
  readonly webSocket: PairSocket | null;

  constructor(
    body?: ConstructorParameters<typeof NativeResponse>[0],
    init?: ResponseInit & { webSocket?: PairSocket | null },
  ) {
    const upgrade = init?.status === 101;
    super(upgrade ? null : body, upgrade ? { ...init, status: 200 } : init);
    this.webSocket = init?.webSocket ?? null;
    // The platform Response refuses status 101, so the upgrade status is set on the instance.
    if (upgrade) Object.defineProperty(this, "status", { value: 101 });
  }
}

/** Installs the Workers WebSocket globals once per process. */
export function installWebSocketGlobals(): void {
  const g = globalThis as Record<string, unknown>;
  g.WebSocketPair = WebSocketPair;
  g.WebSocketRequestResponsePair = WebSocketRequestResponsePair;
  g.Response = UpgradeResponse;
}

/** Bun ServerWebSocket data for a bridged connection. */
export type BridgeData = { client: PairSocket };

/** Connects the client end of a pair to a real socket. Call from Bun's `open` handler. */
export function attachClient(
  client: PairSocket,
  real: { send(d: string | ArrayBuffer): unknown; close(code?: number, reason?: string): void },
): void {
  client.sink = (data) => {
    real.send(data);
  };
  client.onClose = (code, reason) => {
    try {
      real.close(code, reason);
    } catch {
      // Already closed.
    }
  };
}
