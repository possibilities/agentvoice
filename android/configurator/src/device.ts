import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { promisify } from "node:util";
import {
  integer,
  type Phone,
  type PhoneState,
  parseProfile,
  parseState,
  record,
} from "./protocol.ts";
import { ReconnectingPhone } from "./reconnecting-phone.ts";

const execute = promisify(execFile);
const activity = "com.arthack.agentvoice.dev/com.arthack.agentvoice.PersonaPreviewActivity";

async function adb(device: string, args: string[], signal?: AbortSignal): Promise<string> {
  try {
    return (
      await execute("adb", ["-s", device, ...args], { timeout: 12000, maxBuffer: 65536, signal })
    ).stdout.trim();
  } catch {
    // Activity arguments include this preview's admission token.
    throw Error(
      "ADB failed. Check the selected phone is connected and USB debugging is authorized.",
    );
  }
}

type Reply = { state: PhoneState; profile?: string };
type Pending = {
  resolve: (reply: Reply) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class PhoneConnection implements Phone {
  state!: PhoneState;
  connected = true;
  disconnectReason: string | undefined;
  private sequence = 0;
  private pending = new Map<number, Pending>();
  private buffer = Buffer.alloc(0);

  constructor(
    private socket: Socket,
    token: string,
  ) {
    socket.setNoDelay(true);
    socket.on("data", (chunk: Buffer) => this.receive(chunk));
    socket.on("error", () => this.close("The ADB preview connection failed."));
    socket.on("close", () => this.close("The phone closed its preview connection."));
    socket.write(`${JSON.stringify({ token })}\n`);
  }

  request(command: Record<string, unknown>): Promise<Reply> {
    if (!this.connected)
      return Promise.reject(Error("Phone disconnected. Waiting for the preview to return."));
    if (this.pending.size >= 8) return Promise.reject(Error("Phone is busy. Try again."));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close("The phone preview stopped responding."), 3500);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(`${JSON.stringify({ ...command, id })}\n`);
    });
  }

  private receive(chunk: Buffer) {
    try {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (true) {
        const end = this.buffer.indexOf(10);
        if (end === -1) {
          if (this.buffer.length >= 16384) throw Error("Oversized frame");
          return;
        }
        if (end >= 16384) throw Error("Oversized frame");
        const message = record(JSON.parse(this.buffer.subarray(0, end).toString("utf8")));
        this.buffer = this.buffer.subarray(end + 1);
        const id = integer(message["id"], 1);
        const pending = this.pending.get(id);
        if (!pending) throw Error("Unknown response");
        const error = message["error"];
        if (typeof error === "string") {
          clearTimeout(pending.timer);
          this.pending.delete(id);
          pending.reject(
            Error("Phone rejected the change or could not save. Refresh and try again."),
          );
          continue;
        }
        const state = parseState(message["state"]);
        const profile = message["profile"];
        if (profile !== undefined) {
          if (typeof profile !== "string") throw Error("Invalid profile");
          parseProfile(profile);
        }
        this.state = state;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.resolve({ state, ...(typeof profile === "string" ? { profile } : {}) });
      }
    } catch {
      this.close("The phone sent an invalid preview response.");
    }
  }

  close(reason = "Preview connection closed.") {
    if (!this.connected) return;
    this.connected = false;
    this.disconnectReason = reason;
    this.socket.destroy();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(Error("Phone disconnected. Waiting for the preview to return."));
    }
    this.pending.clear();
  }
}

export async function connectPhone(device: string) {
  if ((await adb(device, ["get-state"])) !== "device")
    throw Error("The selected phone is unavailable.");
  const name = `agentvoice-halo-${randomBytes(16).toString("hex")}`;
  const token = randomBytes(32).toString("hex");
  const label = await adb(device, ["shell", "getprop", "ro.product.model"]);
  const launch = await adb(device, [
    "shell",
    "am",
    "start",
    "-W",
    "-f",
    "0x24000000",
    "-n",
    activity,
    "--es",
    "previewSocket",
    name,
    "--es",
    "previewToken",
    token,
  ]);
  if (/Error|Exception/.test(launch))
    throw Error("Install the current Android debug APK before opening the configurator.");
  let phone: ReconnectingPhone | undefined;
  let closed = false;
  const ownedForward = (line: string) => {
    const [serial, local, remote] = line.trim().split(/\s+/);
    return serial === device && remote === `localabstract:${name}` && /^tcp:\d+$/.test(local ?? "")
      ? local
      : undefined;
  };
  async function close() {
    if (closed) return;
    closed = true;
    await phone?.close();
    const forwards = await adb(device, ["forward", "--list"]);
    for (const line of forwards.split("\n")) {
      const local = ownedForward(line);
      if (local) await adb(device, ["forward", "--remove", local]);
    }
  }

  async function dial(signal?: AbortSignal): Promise<PhoneConnection> {
    if ((await adb(device, ["get-state"], signal)) !== "device") throw Error("Phone unavailable");
    const forwards = await adb(device, ["forward", "--list"], signal);
    const existing = forwards
      .split("\n")
      .map(ownedForward)
      .find((local) => local !== undefined);
    // USB reconnection can discard the forward. Allocate a new port without replacing another mapping.
    const port =
      existing?.slice(4) ??
      (await adb(device, ["forward", "--no-rebind", "tcp:0", `localabstract:${name}`], signal));
    if (!/^\d+$/.test(port)) throw Error("ADB did not allocate a preview port.");
    signal?.throwIfAborted();
    const socket = createConnection({ host: "127.0.0.1", port: Number(port) });
    const abort = () => socket.destroy(Error("Preview connection cancelled"));
    signal?.addEventListener("abort", abort, { once: true });
    let candidate: PhoneConnection | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        socket.setTimeout(3500, () => socket.destroy(Error("Phone preview did not answer.")));
        socket.once("error", reject);
        socket.once("connect", () => {
          socket.setTimeout(0);
          resolve();
        });
      });
      candidate = new PhoneConnection(socket, token);
      await candidate.request({ method: "get" });
      signal?.throwIfAborted();
      return candidate;
    } catch (error) {
      candidate?.close();
      socket.destroy();
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  try {
    phone = new ReconnectingPhone(await dial(), dial);
    return { phone, label, close };
  } catch (error) {
    await close();
    throw error;
  }
}
