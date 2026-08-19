/** Deliberate, bounded, two-sided pairing with a human-compared short code. */
import { randomBytes as secureRandomBytes } from "node:crypto";
import {
  CONTROL_PROTOCOL_VERSION,
  type PairBeginCommand,
  type PairDeviceConfirmCommand,
  type PairingLocalConfirmCommand,
  type PairingStateFrame,
  type ServerFrame,
} from "../core/control-protocol.ts";
import {
  deviceIdFromPublicKey,
  pairingCode,
  pairingProofPayload,
  validateDevicePublicKey,
  verifyDeviceSignature,
} from "../core/pairing.ts";
import { containsAsciiControl, containsAsciiControlOrSpace } from "../core/safe-text.ts";
import type { PairedDeviceStore } from "./paired-devices.ts";
import type { ServerIdentity } from "./server-identity.ts";

const DEFAULT_WINDOW_MS = 120_000;

interface LocalPairingPeer {
  id: number;
  send(frame: ServerFrame): void;
}

interface NetworkPairingPeer extends LocalPairingPeer {
  close(): void;
}

interface PairingWindow {
  owner: LocalPairingPeer;
  expiresAt: number;
  session: PairingSession | null;
}

interface PairingSession {
  peer: NetworkPairingPeer;
  begin: PairBeginCommand;
  sessionId: string;
  serverNonce: string;
  code: string;
  localConfirmed: boolean;
  deviceConfirmed: boolean;
}

export interface PairingCoordinatorOptions {
  identity: ServerIdentity;
  devices: PairedDeviceStore;
  port: number;
  endpoints(): string[];
  now?: () => number;
  randomBytes?: (size: number) => Uint8Array;
  windowMs?: number;
  onWindowChange?(open: boolean): void;
}

export class PairingCoordinator {
  private readonly now: () => number;
  private readonly randomBytes: (size: number) => Uint8Array;
  private readonly windowMs: number;
  private window: PairingWindow | null = null;

  constructor(private readonly options: PairingCoordinatorOptions) {
    this.now = options.now ?? Date.now;
    this.randomBytes = options.randomBytes ?? secureRandomBytes;
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    if (
      !Number.isSafeInteger(this.windowMs) ||
      this.windowMs < 10_000 ||
      this.windowMs > 10 * 60_000
    ) {
      throw new Error("pairing window must last from 10 seconds through 10 minutes");
    }
  }

  isOpen(): boolean {
    this.tick();
    return this.window !== null;
  }

  open(owner: LocalPairingPeer): void {
    this.tick();
    if (this.window) {
      if (this.window.owner.id === owner.id) owner.send(this.currentState(this.window));
      else
        owner.send({
          type: "pairing-state",
          status: "failed",
          message: "another local pairing window is open",
        });
      return;
    }
    this.window = { owner, expiresAt: this.now() + this.windowMs, session: null };
    this.options.onWindowChange?.(true);
    owner.send(this.currentState(this.window));
  }

  begin(peer: NetworkPairingPeer, command: PairBeginCommand): boolean {
    this.tick();
    const window = this.window;
    if (!window) {
      this.rejectPeer(peer, "pairing is not open");
      return false;
    }
    if (window.session) {
      this.rejectPeer(peer, "another phone is already pairing");
      return false;
    }
    let deviceName: string;
    try {
      if (command.protocol !== CONTROL_PROTOCOL_VERSION)
        throw new Error("control protocol does not match");
      deviceName = validateDeviceName(command.deviceName);
      validateDevicePublicKey(command.publicKey);
      if (deviceIdFromPublicKey(command.publicKey) !== command.deviceId) {
        throw new Error("device id does not match its public-key fingerprint");
      }
      validateNonce(command.clientNonce);
    } catch (error) {
      this.rejectPeer(peer, error instanceof Error ? error.message : String(error));
      return false;
    }
    const normalizedBegin = { ...command, deviceName };
    const sessionId = this.randomValue(16);
    const serverNonce = this.randomValue(24);
    const code = pairingCode({
      serverId: this.options.identity.serverId,
      deviceId: command.deviceId,
      clientNonce: command.clientNonce,
      serverNonce,
    });
    const session: PairingSession = {
      peer,
      begin: normalizedBegin,
      sessionId,
      serverNonce,
      code,
      localConfirmed: false,
      deviceConfirmed: false,
    };
    window.session = session;
    const endpoints = validatedEndpoints(this.options.endpoints());
    peer.send({
      type: "pair-challenge",
      sessionId,
      serverId: this.options.identity.serverId,
      serverName: this.options.identity.serverName,
      certificate: this.options.identity.certificate,
      deviceId: command.deviceId,
      clientNonce: command.clientNonce,
      serverNonce,
      endpoints,
      port: this.options.port,
    });
    window.owner.send(this.currentState(window));
    return true;
  }

  confirmLocal(ownerId: number, command: PairingLocalConfirmCommand): void {
    this.tick();
    const window = this.window;
    const session = window?.session;
    if (
      !window ||
      window.owner.id !== ownerId ||
      !session ||
      session.sessionId !== command.sessionId
    )
      return;
    session.localConfirmed = true;
    this.completeIfReady(window, session);
  }

  confirmDevice(peerId: number, command: PairDeviceConfirmCommand): void {
    this.tick();
    const window = this.window;
    const session = window?.session;
    if (
      !window ||
      !session ||
      session.peer.id !== peerId ||
      session.sessionId !== command.sessionId
    )
      return;
    const valid = verifyDeviceSignature(
      session.begin.publicKey,
      pairingProofPayload({
        sessionId: session.sessionId,
        serverId: this.options.identity.serverId,
        deviceId: session.begin.deviceId,
        clientNonce: session.begin.clientNonce,
        serverNonce: session.serverNonce,
      }),
      command.signature,
    );
    if (!valid) {
      this.failSession(window, session, "device confirmation signature was rejected");
      return;
    }
    session.deviceConfirmed = true;
    this.completeIfReady(window, session);
  }

  cancel(ownerId: number): void {
    const window = this.window;
    if (!window || window.owner.id !== ownerId) return;
    this.finishWindow("pairing cancelled");
  }

  peerClosed(peerId: number): void {
    const window = this.window;
    if (!window) return;
    if (window.owner.id === peerId) {
      this.finishWindow("local pairing console disconnected");
      return;
    }
    const session = window.session;
    if (!session || session.peer.id !== peerId) return;
    this.finishWindow("phone disconnected during pairing");
  }

  tick(): void {
    const window = this.window;
    if (!window || this.now() <= window.expiresAt) return;
    this.finishWindow("pairing window expired");
  }

  private completeIfReady(window: PairingWindow, session: PairingSession): void {
    if (!session.localConfirmed || !session.deviceConfirmed) return;
    try {
      this.options.devices.pair({
        id: session.begin.deviceId,
        name: session.begin.deviceName,
        publicKey: session.begin.publicKey,
        pairedAt: new Date(this.now()).toISOString(),
      });
      session.peer.send({
        type: "pair-complete",
        serverId: this.options.identity.serverId,
        serverName: this.options.identity.serverName,
        certificate: this.options.identity.certificate,
        deviceId: session.begin.deviceId,
        endpoints: validatedEndpoints(this.options.endpoints()),
        port: this.options.port,
      });
      window.owner.send({
        type: "pairing-state",
        status: "complete",
        deviceName: session.begin.deviceName,
      });
      this.window = null;
      this.options.onWindowChange?.(false);
    } catch (error) {
      this.failSession(window, session, error instanceof Error ? error.message : String(error));
    }
  }

  private failSession(window: PairingWindow, session: PairingSession, message: string): void {
    if (window.session !== session) return;
    this.finishWindow(message);
  }

  private rejectPeer(peer: NetworkPairingPeer, message: string): void {
    peer.send({ type: "pairing-state", status: "failed", message });
    peer.close();
  }

  private finishWindow(message: string): void {
    const window = this.window;
    if (!window) return;
    this.window = null;
    window.owner.send({ type: "pairing-state", status: "cancelled", message });
    if (window.session) {
      window.session.peer.send({ type: "pairing-state", status: "failed", message });
      window.session.peer.close();
    }
    this.options.onWindowChange?.(false);
  }

  private currentState(window: PairingWindow): PairingStateFrame {
    const session = window.session;
    return session
      ? {
          type: "pairing-state",
          status: "awaiting-confirmation",
          expiresAt: window.expiresAt,
          sessionId: session.sessionId,
          code: session.code,
          deviceName: session.begin.deviceName,
        }
      : { type: "pairing-state", status: "open", expiresAt: window.expiresAt };
  }

  private randomValue(size: number): string {
    const bytes = this.randomBytes(size);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== size) {
      throw new Error("pairing random source returned the wrong byte count");
    }
    return Buffer.from(bytes).toString("base64url");
  }
}

function validateDeviceName(value: string): string {
  const name = value.trim();
  if (name.length === 0 || name.length > 96 || containsAsciiControl(name)) {
    throw new Error("device name is invalid");
  }
  return name;
}

function validateNonce(value: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1)
    throw new Error("client nonce is invalid");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length < 16 || bytes.length > 64 || bytes.toString("base64url") !== value) {
    throw new Error("client nonce is invalid");
  }
}

function validatedEndpoints(values: string[]): string[] {
  const endpoints: string[] = [];
  for (const value of values) {
    const endpoint = value.trim().replace(/\.$/, "");
    if (
      endpoint.length === 0 ||
      endpoint.length > 253 ||
      containsAsciiControlOrSpace(endpoint) ||
      endpoint.includes("/") ||
      endpoint.includes("\\") ||
      endpoints.includes(endpoint)
    ) {
      continue;
    }
    endpoints.push(endpoint);
    if (endpoints.length === 16) break;
  }
  return endpoints;
}
