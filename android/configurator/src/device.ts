import { createConnection, type Socket } from "node:net";
import {
  type Adb,
  parseStudioBinding,
  requireRunningStudio,
  runAdb,
  studioPackage,
} from "./discovery.ts";
import {
  integer,
  type Phone,
  type PhoneState,
  parseProfile,
  parseState,
  record,
} from "./protocol.ts";
import { ReconnectingPhone } from "./reconnecting-phone.ts";

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
          if (this.buffer.length >= 65536) throw Error("Oversized frame");
          return;
        }
        if (end >= 65536) throw Error("Oversized frame");
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

export async function connectPhone(device: string, runner: Adb = runAdb) {
  const adb = (serial: string, args: string[], signal?: AbortSignal) =>
    runner(["-s", serial, ...args], signal);
  const admission = AbortSignal.timeout(30000);
  await requireRunningStudio(device, runner, admission);
  const { name, token } = parseStudioBinding(
    await adb(
      device,
      ["shell", "run-as", studioPackage, "cat", "files/persona-studio-binding.json"],
      admission,
    ),
  );
  const label = await adb(device, ["shell", "getprop", "ro.product.model"], admission);
  const allocated = new Set<string>();
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
      if (local && allocated.has(local)) {
        await adb(device, ["forward", "--remove", local]);
        allocated.delete(local);
      }
    }
  }

  async function dial(parentSignal?: AbortSignal): Promise<PhoneConnection> {
    const signal = AbortSignal.any([
      ...(parentSignal ? [parentSignal] : []),
      AbortSignal.timeout(20000),
    ]);
    if ((await adb(device, ["get-state"], signal)) !== "device") throw Error("Phone unavailable");
    const forwards = await adb(device, ["forward", "--list"], signal);
    const matches = forwards
      .split("\n")
      .map(ownedForward)
      .filter((local): local is string => local !== undefined);
    if (matches.some((local) => !allocated.has(local)))
      throw Error(
        "This Studio device is linked to another browser host. Stop that host before linking here.",
      );
    const existing = matches.find((local) => allocated.has(local));
    let port = existing?.slice(4);
    if (!port) {
      await requireRunningStudio(device, runner, signal);
      port = await adb(
        device,
        ["forward", "--no-rebind", "tcp:0", `localabstract:${name}`],
        signal,
      );
      if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
        throw Error("ADB did not allocate a preview port.");
      allocated.add(`tcp:${port}`);
      // A simultaneous local host can create a forward between our check and allocation.
      const now = (await adb(device, ["forward", "--list"], signal)).split("\n").map(ownedForward);
      if (now.some((local) => local !== undefined && !allocated.has(local)))
        throw Error(
          "This Studio device was linked elsewhere. Stop the other host before retrying.",
        );
    }
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
    phone = new ReconnectingPhone(await dial(admission), dial);
    return { phone, label, close };
  } catch (error) {
    await close();
    throw error;
  }
}
