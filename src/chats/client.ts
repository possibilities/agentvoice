export interface GatewayFrameHandlers {
  onFrame(params: Record<string, unknown>): void;
  onNotification?(method: string, params: Record<string, unknown>): void;
  onClosed?(reason: string): void;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: ChatsConnectionError): void;
  method: string;
  timer: ReturnType<typeof setTimeout>;
}

export interface ChatsConnectionOptions extends GatewayFrameHandlers {
  url: string;
  token: string;
  version: string;
}

export class ChatsConnectionError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class ChatsConnection {
  private readonly options: ChatsConnectionOptions;
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private closedNotified = false;

  constructor(options: ChatsConnectionOptions) {
    this.options = options;
  }

  async connect(): Promise<void> {
    const url = new URL(this.options.url);
    if (url.protocol !== "ws:" && url.protocol !== "wss:") {
      throw new ChatsConnectionError(`unsupported chats URL protocol ${url.protocol}`);
    }
    if (!url.searchParams.has("token")) url.searchParams.set("token", this.options.token);
    if (!url.searchParams.has("observe")) url.searchParams.set("observe", "agentvoice");
    const ws = new WebSocket(url);
    this.ws = ws;
    this.closedNotified = false;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        ws.close();
        reject(new ChatsConnectionError(`timed out connecting to ${this.options.url}`));
      }, 5_000);
      ws.onmessage = (event) => this.handle(String(event.data));
      ws.onopen = () => {
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new ChatsConnectionError(`unable to connect to ${this.options.url}`));
      };
      ws.onclose = (event) => {
        // An explicit close may be followed immediately by a reconnect; the
        // old socket's delayed close event must not tear down the successor.
        if (this.ws !== ws) return;
        this.ws = null;
        const reason = `connection closed (${event.code}${event.reason ? `: ${event.reason}` : ""})`;
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new ChatsConnectionError(reason));
        }
        this.closePending(reason);
      };
    });
    try {
      await this.request("initialize", {
        clientInfo: {
          name: "agentvoice_chats",
          title: "AgentVoice Chats",
          version: this.options.version,
        },
        capabilities: { experimentalApi: true },
      });
      this.notify("initialized", {});
    } catch (error) {
      this.close();
      throw error;
    }
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs = 15_000): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new ChatsConnectionError("app-server gateway is not connected"));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ChatsConnectionError(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        method,
        timer,
      });
      const frame = { jsonrpc: "2.0", id, method, params };
      ws.send(JSON.stringify(frame));
      this.recordLocal("toAppServer", "client", frame);
    });
  }

  notify(method: string, params: unknown): void {
    const ws = this.ws;
    if (ws?.readyState === WebSocket.OPEN) {
      const frame = { jsonrpc: "2.0", method, params };
      ws.send(JSON.stringify(frame));
      this.recordLocal("toAppServer", "client", frame);
    }
  }

  close(): void {
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState <= WebSocket.OPEN) ws.close(1000, "chats closed");
    this.closePending("connection closed");
  }

  private handle(text: string): void {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return;
    }
    if (!isRecord(value)) return;
    const id = value["id"];
    const method = value["method"];
    if (method === "agentvoice/frame") {
      const params = isRecord(value["params"]) ? value["params"] : {};
      this.options.onFrame(params);
      return;
    }
    this.recordLocal(
      "fromAppServer",
      typeof id === "number" && method === undefined && this.pending.has(id)
        ? "client"
        : "appServer",
      value,
    );
    if (typeof id === "number" && value["method"] === undefined) {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      const error = value["error"];
      if (isRecord(error)) {
        pending.reject(
          new ChatsConnectionError(
            `${pending.method}: ${typeof error["message"] === "string" ? error["message"] : "unknown error"}`,
          ),
        );
      } else {
        pending.resolve(value["result"]);
      }
      return;
    }
    if (typeof method !== "string") return;
    const params = isRecord(value["params"]) ? value["params"] : {};
    this.options.onNotification?.(method, params);
  }

  private recordLocal(
    direction: "toAppServer" | "fromAppServer",
    owner: "client" | "appServer",
    payload: Record<string, unknown>,
  ): void {
    this.options.onFrame({ direction, owner, payload });
  }

  private closePending(reason: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new ChatsConnectionError(`${pending.method}: ${reason}`));
    }
    this.pending.clear();
    if (!this.closedNotified) {
      this.closedNotified = true;
      this.options.onClosed?.(reason);
    }
  }
}
