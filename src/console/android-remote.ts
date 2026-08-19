/** Android entry: generic discovery, one-time pairing, pinned route racing, then the shared Remote console. */

import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { appendFileSync } from "node:fs";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  BoxRenderable,
  type CliRenderer,
  createCliRenderer,
  type ParsedKey,
  TextRenderable,
} from "@opentui/core";
import type { DroidedHostClient } from "droidedtui/protocol";
import {
  CONTROL_PROTOCOL_VERSION,
  encodeControlFrame,
  type PairChallengeFrame,
  type PairCompleteFrame,
  parseServerFrame,
  type ServerFrame,
} from "../core/control-protocol.ts";
import {
  deviceIdFromPublicKey,
  pairingCode,
  pairingProofPayload,
  serverIdFromCertificate,
  serverProofPayload,
  verifyServerSignature,
} from "../core/pairing.ts";
import { containsAsciiControl, containsAsciiControlOrSpace } from "../core/safe-text.ts";
import { remoteProfileFilePath, stateDirectory } from "../paths.ts";
import { AUDIO_CONTROL_KITTY_KEYBOARD } from "./audio-control.ts";
import { type ConsoleTargetResolver, type NetworkTarget, runConsoleHost } from "./host.ts";
import {
  loadRemoteProfile,
  type RemoteProfile,
  saveRemoteProfile,
  validateRemoteProfile,
} from "./remote-profile.ts";
import { VOICE_TONES } from "./theme.ts";

const IDENTITY_ALIAS = "agentvoice-remote";
const SERVICE_TYPE = "_agentvoice._tcp";
const PAIRING_TIMEOUT_MS = 125_000;
const PAIRING_PROBE_INTERVAL_MS = 3_000;
const ROUTE_PROBE_TIMEOUT_MS = 2_000;

export interface DiscoveredService {
  name: string;
  host: string;
  port: number;
  serverId: string;
  pairing: boolean;
  tailscaleDnsName?: string;
}

interface AndroidHostInfo {
  deviceName: string;
}

interface AndroidIdentity {
  publicKey: string;
  deviceId: string;
}

export async function runAndroidRemote(): Promise<void> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    targetFps: 30,
    screenMode: "alternate-screen",
    useKittyKeyboard: AUDIO_CONTROL_KITTY_KEYBOARD,
    backgroundColor: VOICE_TONES.bg,
  });
  // Imported lazily: the protocol ships from the optional sibling checkout,
  // present where the APK is packaged and absent in CI.
  const { DroidedHostClient } = await import("droidedtui/protocol");
  const host = new DroidedHostClient(renderer);
  const discovery = new AndroidDiscovery(host);
  let screen: PairingScreen | null = null;
  let rendererHandedOff = false;
  try {
    const [info, identity] = await Promise.all([readHostInfo(host), readIdentity(host)]);
    await discovery.start();
    const profilePath = remoteProfileFilePath(process.env, homedir());
    let profile = loadRemoteProfile(profilePath);
    if (!profile) {
      screen = new PairingScreen(renderer);
      profile = await pairNearbyServer(host, discovery, screen, info, identity);
      saveRemoteProfile(profilePath, profile);
      screen.destroy();
      screen = null;
    }
    const debugPath = join(stateDirectory(process.env, homedir()), "console-debug.log");
    const debug = (line: string): void => {
      try {
        appendFileSync(debugPath, `${new Date().toISOString()} ${line}\n`);
      } catch {
        // Debug logging must never break the Remote console.
      }
    };
    const resolver = new AndroidRouteResolver(host, discovery, profilePath, profile, debug);
    rendererHandedOff = true;
    // Always-on debug: the Android host has no flag surface, and connection
    // failures are otherwise invisible (nothing reaches logcat).
    await runConsoleHost(resolver, { debug: true, tui: { createRenderer: async () => renderer } });
  } finally {
    screen?.destroy();
    discovery.close();
    host.close();
    if (!rendererHandedOff) renderer.destroy();
  }
}

export function parseDiscoveredService(value: unknown): DiscoveredService | null {
  const service = record(value);
  const attributes = record(service?.["attributes"]);
  if (
    !service ||
    !attributes ||
    attributes["v"] !== "1" ||
    attributes["tls"] !== "1" ||
    !boundedDisplayText(service["name"], 128) ||
    !boundedNetworkString(service["host"], 253) ||
    !Number.isSafeInteger(service["port"]) ||
    (service["port"] as number) < 1 ||
    (service["port"] as number) > 65535 ||
    !boundedNetworkString(attributes["id"], 128)
  ) {
    return null;
  }
  const tail = attributes["tail"];
  return {
    name: service["name"],
    host: service["host"],
    port: service["port"] as number,
    serverId: attributes["id"],
    pairing: attributes["pairing"] === "1",
    ...(boundedNetworkString(tail, 253) ? { tailscaleDnsName: tail } : {}),
  };
}

export function selectPairingCandidate(
  services: DiscoveredService[],
  previousName: string | null,
): DiscoveredService | null {
  const advertised = services.find((service) => service.pairing);
  if (advertised) return advertised;
  if (services.length === 0) return null;
  const previousIndex = previousName
    ? services.findIndex((service) => service.name === previousName)
    : -1;
  return services[(previousIndex + 1) % services.length] ?? null;
}

export function validatePairChallenge(
  challenge: PairChallengeFrame,
  expected: { deviceId: string; clientNonce: string },
): string {
  if (serverIdFromCertificate(challenge.certificate) !== challenge.serverId) {
    throw new Error("pairing Server certificate fingerprint does not match its identity");
  }
  if (challenge.deviceId !== expected.deviceId || challenge.clientNonce !== expected.clientNonce) {
    throw new Error("pairing challenge does not match this device request");
  }
  return pairingCode(challenge);
}

export function profileFromPairComplete(
  complete: PairCompleteFrame,
  challenge: PairChallengeFrame,
): RemoteProfile {
  if (
    complete.serverId !== challenge.serverId ||
    complete.serverName !== challenge.serverName ||
    complete.certificate !== challenge.certificate ||
    complete.deviceId !== challenge.deviceId ||
    complete.port !== challenge.port
  ) {
    throw new Error("completed pairing profile does not match the confirmed challenge");
  }
  return validateRemoteProfile({
    version: 1,
    serverId: complete.serverId,
    serverName: complete.serverName,
    certificate: complete.certificate,
    deviceId: complete.deviceId,
    endpoints: complete.endpoints,
    port: complete.port,
  });
}

async function readHostInfo(host: DroidedHostClient): Promise<AndroidHostInfo> {
  const info = record(await host.request("host.info"));
  if (info?.["platform"] !== "android" || !boundedText(info["deviceName"], 96)) {
    throw new Error("DroidedTUI Android host did not return valid identity information");
  }
  return { deviceName: info["deviceName"] };
}

async function readIdentity(host: DroidedHostClient): Promise<AndroidIdentity> {
  const result = record(await host.request("identity.get-or-create", { alias: IDENTITY_ALIAS }));
  if (result?.["algorithm"] !== "ES256" || !boundedText(result["publicKey"], 1024)) {
    throw new Error("Android Keystore did not return a P-256 identity");
  }
  return { publicKey: result["publicKey"], deviceId: deviceIdFromPublicKey(result["publicKey"]) };
}

async function signWithIdentity(host: DroidedHostClient, payload: Uint8Array): Promise<string> {
  const result = record(
    await host.request("identity.sign", {
      alias: IDENTITY_ALIAS,
      payload: Buffer.from(payload).toString("base64url"),
    }),
  );
  if (result?.["algorithm"] !== "ES256" || !boundedText(result["signature"], 512)) {
    throw new Error("Android Keystore did not return a P-256 signature");
  }
  return result["signature"];
}

async function pairNearbyServer(
  host: DroidedHostClient,
  discovery: AndroidDiscovery,
  screen: PairingScreen,
  info: AndroidHostInfo,
  identity: AndroidIdentity,
): Promise<RemoteProfile> {
  screen.show(
    "PAIR AGENTVOICE",
    "Run `agentvoice server pair` on the Mac, then keep this screen open.",
  );
  let previousName: string | null = null;
  for (;;) {
    let service = selectPairingCandidate(discovery.snapshot(), previousName);
    if (!service) {
      await discovery.next(() => true);
      service = selectPairingCandidate(discovery.snapshot(), previousName);
      if (!service) continue;
    }
    if (service.pairing) {
      screen.show("PAIR AGENTVOICE", `Found ${service.name}. Establishing a private comparison…`);
    }
    try {
      return await pairService(host, screen, info, identity, service);
    } catch (error) {
      previousName = service.name;
      if (service.pairing) {
        screen.show(
          "PAIRING DID NOT COMPLETE",
          `${error instanceof Error ? error.message : String(error)}\n\nThe app will keep looking for an open pairing window.`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, PAIRING_PROBE_INTERVAL_MS));
    }
  }
}

async function pairService(
  host: DroidedHostClient,
  screen: PairingScreen,
  info: AndroidHostInfo,
  identity: AndroidIdentity,
  service: DiscoveredService,
): Promise<RemoteProfile> {
  const socket = new WebSocket(`wss://${formatHost(service.host)}:${service.port}`, {
    tls: { rejectUnauthorized: false },
  });
  const frames = new WebSocketFrames(socket);
  const clientNonce = randomBytes(24).toString("base64url");
  try {
    await frames.open();
    socket.send(
      encodeControlFrame({
        type: "pair-begin",
        protocol: CONTROL_PROTOCOL_VERSION,
        deviceId: identity.deviceId,
        deviceName: info.deviceName,
        publicKey: identity.publicKey,
        clientNonce,
      }),
    );
    const first = await frames.next(PAIRING_TIMEOUT_MS);
    if (first.type === "pairing-state" && first.status === "failed")
      throw new Error(first.message ?? "pairing refused");
    if (first.type !== "pair-challenge") throw new Error("Server did not begin pairing");
    const challenge = first;
    const code = validatePairChallenge(challenge, { deviceId: identity.deviceId, clientNonce });
    const confirmed = await screen.confirm(
      code,
      `Compare this code with the Mac. Tap anywhere only when both show the same digits.`,
    );
    if (!confirmed) throw new Error("pairing cancelled on the phone");
    const signature = await signWithIdentity(host, pairingProofPayload(challenge));
    socket.send(
      encodeControlFrame({
        type: "pair-device-confirm",
        sessionId: challenge.sessionId,
        signature,
      }),
    );
    for (;;) {
      const frame = await frames.next(PAIRING_TIMEOUT_MS);
      if (frame.type === "pair-complete") return profileFromPairComplete(frame, challenge);
      if (
        frame.type === "pairing-state" &&
        (frame.status === "failed" || frame.status === "cancelled")
      ) {
        throw new Error(frame.message ?? `pairing ${frame.status}`);
      }
    }
  } finally {
    frames.close();
  }
}

class AndroidDiscovery {
  private readonly services = new Map<string, DiscoveredService>();
  private readonly waiters = new Set<(service: DiscoveredService) => void>();
  private readonly unsubscribeService: () => void;
  private readonly unsubscribeLost: () => void;
  private started = false;

  constructor(private readonly host: DroidedHostClient) {
    this.unsubscribeService = host.subscribe("discovery.service", (data) => {
      const service = parseDiscoveredService(data);
      if (!service) return;
      this.services.set(service.name, service);
      for (const waiter of [...this.waiters]) waiter(service);
    });
    this.unsubscribeLost = host.subscribe("discovery.lost", (data) => {
      const lost = record(data);
      if (lost && typeof lost["name"] === "string") this.services.delete(lost["name"]);
    });
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.host.request("discovery.start", { serviceType: SERVICE_TYPE });
    this.started = true;
  }

  snapshot(): DiscoveredService[] {
    return [...this.services.values()];
  }

  next(
    predicate: (service: DiscoveredService) => boolean,
    timeoutMs?: number,
  ): Promise<DiscoveredService> {
    const current = this.snapshot().find(predicate);
    if (current) return Promise.resolve(current);
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const waiter = (service: DiscoveredService): void => {
        if (!predicate(service)) return;
        this.waiters.delete(waiter);
        if (timer) clearTimeout(timer);
        resolve(service);
      };
      this.waiters.add(waiter);
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new Error("no matching AgentVoice service was discovered"));
        }, timeoutMs);
      }
    });
  }

  close(): void {
    this.unsubscribeService();
    this.unsubscribeLost();
    this.waiters.clear();
    if (this.started) void this.host.request("discovery.stop").catch(() => {});
    this.started = false;
  }
}

class AndroidRouteResolver implements ConsoleTargetResolver {
  private profile: RemoteProfile;

  constructor(
    private readonly host: DroidedHostClient,
    private readonly discovery: AndroidDiscovery,
    private readonly profilePath: string,
    profile: RemoteProfile,
    private readonly debug?: (line: string) => void,
  ) {
    this.profile = profile;
  }

  async resolve(): Promise<NetworkTarget> {
    let services = this.matchingServices();
    if (this.profile.endpoints.length === 0 && services.length === 0) {
      await this.discovery.next((service) => service.serverId === this.profile.serverId, 5_000);
      services = this.matchingServices();
    }
    this.captureTailscaleNames(services);
    const candidates = [
      ...this.profile.endpoints,
      ...services.map((service) => service.host),
    ].filter((candidate, index, all) => all.indexOf(candidate) === index);
    if (candidates.length === 0) throw new Error("no route to the paired Server is known yet");
    const routes = await expandRouteCandidates(candidates);
    if (routes.length === 0) {
      throw new Error("no route to the paired Server resolves on this network yet");
    }
    const route = await racePinnedRoutes(routes, this.profile, this.debug);
    return {
      host: route.host,
      port: this.profile.port,
      secure: true,
      ...(route.pinned
        ? { tls: { ca: this.profile.certificate, serverName: this.profile.serverName } }
        : {}),
      device: {
        id: this.profile.deviceId,
        sign: (payload) => signWithIdentity(this.host, payload),
        verifyServer: (challenge, signature) =>
          verifyServerSignature(
            this.profile.certificate,
            serverProofPayload({
              challenge,
              serverId: this.profile.serverId,
              deviceId: this.profile.deviceId,
            }),
            signature,
          ),
      },
    };
  }

  async close(): Promise<void> {
    await this.host.request("discovery.stop").catch(() => {});
  }

  private matchingServices(): DiscoveredService[] {
    return this.discovery
      .snapshot()
      .filter((service) => service.serverId === this.profile.serverId);
  }

  private captureTailscaleNames(services: DiscoveredService[]): void {
    const discovered = services
      .map((service) => service.tailscaleDnsName)
      .filter((value): value is string => typeof value === "string");
    const endpoints = [...discovered, ...this.profile.endpoints].filter(
      (candidate, index, all) => all.indexOf(candidate) === index,
    );
    if (endpoints.length === this.profile.endpoints.length) return;
    this.profile = { ...this.profile, endpoints };
    saveRemoteProfile(this.profilePath, this.profile);
  }
}

export type AddressLookup = (name: string) => Promise<string[]>;

const systemLookup: AddressLookup = async (name) =>
  (await lookup(name, { all: true, verbatim: true })).map((entry) => entry.address);

/**
 * Bun's WebSocket verifies the URL hostname and honors `tls.serverName` only
 * for bare-IP URLs, so a pinned dial to a DNS name always fails its TLS
 * handshake (the identity certificate's one SAN is the fixed server name).
 * Every candidate therefore resolves to addresses before the race; a name
 * that does not resolve on this network is dropped rather than dialed.
 */
export async function expandRouteCandidates(
  candidates: string[],
  lookupAddresses: AddressLookup = systemLookup,
): Promise<string[]> {
  const expanded = await Promise.all(
    candidates.map(async (candidate) => {
      if (isIP(candidate) !== 0) return [candidate];
      try {
        return (await lookupAddresses(candidate)).filter((address) => isIP(address) !== 0);
      } catch {
        return [];
      }
    }),
  );
  const routes: string[] = [];
  for (const address of expanded.flat()) {
    if (!routes.includes(address)) routes.push(address);
  }
  return routes;
}

export interface RacedRoute {
  host: string;
  /** False when this runtime's TLS stack could not pin the certificate and
   *  the connection will rely on the in-protocol server proof instead. */
  pinned: boolean;
}

/**
 * Pinned TLS is raced first — it authenticates the whole channel. Some
 * runtimes (Bun 1.4-canary on Android, verified live) fail the handshake for
 * every `tls.ca` shape, so when no candidate accepts the pin the race runs
 * again without certificate verification; the mandatory `auth-proof` exchange
 * then authenticates the Server in-protocol, and TLS still blinds passive
 * observers. On the tailnet routes WireGuard authenticates the machines
 * regardless.
 */
async function racePinnedRoutes(
  candidates: string[],
  profile: RemoteProfile,
  debug?: (line: string) => void,
): Promise<RacedRoute> {
  try {
    return { host: await raceRoutes(candidates, profile, true, debug), pinned: true };
  } catch (error) {
    debug?.(
      `${error instanceof Error ? error.message : String(error)}; retrying with unverified TLS — the Server must prove itself in-protocol`,
    );
    return { host: await raceRoutes(candidates, profile, false, debug), pinned: false };
  }
}

async function raceRoutes(
  candidates: string[],
  profile: RemoteProfile,
  pinned: boolean,
  debug?: (line: string) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const sockets = new Set<WebSocket>();
    let failures = 0;
    let settled = false;
    const finish = (host: string): void => {
      if (settled) return;
      settled = true;
      for (const socket of sockets) socket.close();
      resolve(host);
    };
    const fail = (): void => {
      failures += 1;
      if (!settled && failures === candidates.length) {
        settled = true;
        reject(
          new Error(
            pinned
              ? `no paired Server route accepted its pinned certificate (tried ${candidates.join(", ")})`
              : `no paired Server route is reachable (tried ${candidates.join(", ")})`,
          ),
        );
      }
    };
    for (const host of candidates) {
      const socket = new WebSocket(`wss://${formatHost(host)}:${profile.port}`, {
        tls: pinned
          ? { ca: profile.certificate, serverName: profile.serverName }
          : { rejectUnauthorized: false },
      });
      sockets.add(socket);
      let finished = false;
      const timer = setTimeout(() => {
        if (finished || settled) return;
        finished = true;
        socket.close();
        fail();
      }, ROUTE_PROBE_TIMEOUT_MS);
      socket.addEventListener(
        "open",
        () => {
          debug?.(`route ${host}: open`);
          if (finished || settled) return;
          finished = true;
          clearTimeout(timer);
          finish(host);
        },
        { once: true },
      );
      const onFailure = (event: Event): void => {
        debug?.(
          `route ${host}: ${event.type} ${(event as { message?: string }).message ?? ""} code=${(event as { code?: number }).code ?? ""}`,
        );
        if (finished || settled) return;
        finished = true;
        clearTimeout(timer);
        fail();
      };
      socket.addEventListener("error", onFailure, { once: true });
      socket.addEventListener("close", onFailure, { once: true });
    }
  });
}

export interface WebSocketFrameClock {
  schedule(callback: () => void, timeoutMs: number): ReturnType<typeof setTimeout>;
  cancel(timer: ReturnType<typeof setTimeout>): void;
}

const DEFAULT_WEBSOCKET_FRAME_CLOCK: WebSocketFrameClock = {
  schedule: setTimeout,
  cancel: clearTimeout,
};

export class WebSocketFrames {
  private readonly queued: ServerFrame[] = [];
  private readonly waiters: Array<{
    resolve(frame: ServerFrame): void;
    reject(error: Error): void;
  }> = [];
  private closed = false;

  constructor(
    private readonly socket: WebSocket,
    private readonly clock: WebSocketFrameClock = DEFAULT_WEBSOCKET_FRAME_CLOCK,
  ) {
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      const frame = parseServerFrame(event.data);
      if (!frame || frame.type === "auth-challenge") return;
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(frame);
      else this.queued.push(frame);
    });
    const close = (): void => {
      if (this.closed) return;
      this.closed = true;
      for (const waiter of this.waiters.splice(0))
        waiter.reject(new Error("pairing connection closed"));
    };
    socket.addEventListener("error", close);
    socket.addEventListener("close", close);
  }

  open(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.closed) return Promise.reject(new Error("pairing connection is closed"));
    return new Promise((resolve, reject) => {
      this.socket.addEventListener("open", () => resolve(), { once: true });
      this.socket.addEventListener(
        "error",
        () => reject(new Error("could not reach pairing Server")),
        { once: true },
      );
    });
  }

  next(timeoutMs: number): Promise<ServerFrame> {
    const queued = this.queued.shift();
    if (queued) return Promise.resolve(queued);
    if (this.closed) return Promise.reject(new Error("pairing connection is closed"));
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const clearDeadline = (): void => {
        if (!timer) return;
        this.clock.cancel(timer);
        timer = null;
      };
      const waiter = {
        resolve: (frame: ServerFrame): void => {
          clearDeadline();
          resolve(frame);
        },
        reject: (error: Error): void => {
          clearDeadline();
          reject(error);
        },
      };
      timer = this.clock.schedule(() => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        waiter.reject(new Error("pairing response timed out"));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  close(): void {
    this.socket.close();
  }
}

class PairingScreen {
  private readonly root: BoxRenderable;
  private readonly title: TextRenderable;
  private readonly code: TextRenderable;
  private readonly detail: TextRenderable;
  private confirmation: ((confirmed: boolean) => void) | null = null;
  private destroyed = false;

  constructor(private readonly renderer: CliRenderer) {
    this.root = new BoxRenderable(renderer, {
      id: "android-pairing",
      width: "100%",
      height: "100%",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: VOICE_TONES.bg,
      onMouseDown: (event) => {
        event.stopPropagation();
        event.preventDefault();
        this.resolveConfirmation(true);
      },
    });
    this.title = new TextRenderable(renderer, {
      id: "android-pairing-title",
      content: "PAIR AGENTVOICE",
      fg: VOICE_TONES.accent,
      selectable: false,
      wrapMode: "none",
    });
    this.code = new TextRenderable(renderer, {
      id: "android-pairing-code",
      content: "",
      fg: VOICE_TONES.text,
      selectable: false,
      wrapMode: "none",
      marginTop: 2,
      marginBottom: 2,
    });
    this.detail = new TextRenderable(renderer, {
      id: "android-pairing-detail",
      content: "",
      fg: VOICE_TONES.dim,
      selectable: false,
      width: "80%",
    });
    this.root.add(this.title);
    this.root.add(this.code);
    this.root.add(this.detail);
    renderer.root.add(this.root);
    renderer.keyInput.on("keypress", this.onKey);
    renderer.requestRender();
  }

  show(title: string, detail: string): void {
    this.resolveConfirmation(false);
    this.title.content = title;
    this.code.content = "";
    this.detail.content = detail;
    this.renderer.requestRender();
  }

  confirm(code: string, detail: string): Promise<boolean> {
    this.title.content = "VERIFY BOTH SCREENS";
    this.code.content = code;
    this.detail.content = detail;
    this.renderer.requestRender();
    return new Promise((resolve) => {
      this.confirmation = resolve;
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.resolveConfirmation(false);
    this.renderer.keyInput.off("keypress", this.onKey);
    this.renderer.root.remove(this.root);
    this.renderer.requestRender();
  }

  private readonly onKey = (key: ParsedKey): void => {
    if (key.eventType !== "press") return;
    if (key.name === "enter" || key.name === "space") this.resolveConfirmation(true);
    else if (key.name === "q" || (key.ctrl && key.name === "c")) this.resolveConfirmation(false);
  };

  private resolveConfirmation(confirmed: boolean): void {
    const resolve = this.confirmation;
    if (!resolve) return;
    this.confirmation = null;
    resolve(confirmed);
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function boundedNetworkString(value: unknown, maximum: number): value is string {
  return (
    boundedText(value, maximum) &&
    !containsAsciiControlOrSpace(value) &&
    !value.includes("/") &&
    !value.includes("\\")
  );
}

function boundedDisplayText(value: unknown, maximum: number): value is string {
  return boundedText(value, maximum) && !containsAsciiControl(value);
}

function formatHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}
