/**
 * The Server: the coordination runtime run headless under launchd, serving
 * the control listeners that Consoles and Remote consoles attach to. It owns
 * the attachment to the resident, the persisted orchestrator agent, workers,
 * and rotation — and it originates no inference of its own: it lets work that
 * was already set in motion complete, and stops the voice session the moment
 * its media peer disappears.
 */

import { createPrivateKey, sign } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ServerConfig } from "../core/config.ts";
import type { WatchedConfigSource } from "../core/config-watch.ts";
import {
  CONTROL_PROTOCOL_VERSION,
  type ControlState,
  type ControlUnmuteInput,
  type VoiceStateBody,
} from "../core/control-protocol.ts";
import { serverProofPayload } from "../core/pairing.ts";
import { VoiceRuntime } from "../core/runtime.ts";
import {
  controlSocketPath,
  pairedDevicesFilePath,
  serverDirectory,
  stateDirectory,
} from "../paths.ts";
import { type ControlPeerHandle, ControlServer } from "./control.ts";
import { BonjourAdvertiser, defaultBonjourName, discoverTailscaleEndpoints } from "./discovery.ts";
import { PairedDeviceStore } from "./paired-devices.ts";
import { PairingCoordinator } from "./pairing-coordinator.ts";
import { ensureServerIdentity, type ServerIdentity } from "./server-identity.ts";

export class ServerError extends Error {}

export interface ServerOptions {
  debug: boolean;
  configSource?: WatchedConfigSource;
}

const UNMUTE_INPUTS = ["pointer", "key", "space"] as const satisfies readonly ControlUnmuteInput[];
const AUDIO_TARGETS = ["mic", "speaker"] as const;

function remoteUnmuteSource(peerId: number, input: ControlUnmuteInput): string {
  return `remote:${peerId}:${input}`;
}

export async function runServer(
  config: ServerConfig,
  version: string,
  options: ServerOptions,
): Promise<void> {
  // launchd routes stdout to the server log; every line carries its moment.
  const log = (line: string): void => {
    console.log(`${new Date().toISOString()} ${line}`);
  };
  let debugLog: ((line: string) => void) | undefined;
  if (options.debug) {
    const stateDir = stateDirectory(process.env, homedir());
    mkdirSync(stateDir, { recursive: true });
    const path = join(stateDir, "server-debug.log");
    debugLog = (line: string) => {
      try {
        appendFileSync(path, `${new Date().toISOString()} ${line}\n`);
      } catch {
        // Debug logging must never break the Server.
      }
    };
    debugLog("server start");
  }

  let sequence = 0;
  let voiceState: VoiceStateBody | null = null;
  let runtime: VoiceRuntime | null = null;
  let shuttingDown = false;
  let identity: ServerIdentity | null = null;
  let pairing: PairingCoordinator | null = null;
  let advertiser: BonjourAdvertiser | null = null;
  let tailscaleEndpoints: string[] = [];
  const home = homedir();

  const state = (): ControlState => ({
    type: "state",
    protocol: CONTROL_PROTOCOL_VERSION,
    sequence: sequence++,
    voice: voiceState,
  });

  // Binding first makes the control socket the single-Server lock before any
  // shared state is touched.
  const control = new ControlServer({
    socketPath: controlSocketPath(process.env, home),
    prepareNetwork: () => {
      identity = ensureServerIdentity(serverDirectory(process.env, home));
      const devices = PairedDeviceStore.open(pairedDevicesFilePath(process.env, home));
      tailscaleEndpoints = discoverTailscaleEndpoints();
      pairing = new PairingCoordinator({
        identity,
        devices,
        port: config.remote.port,
        endpoints: () => tailscaleEndpoints,
        onWindowChange: (open) => advertiser?.update(open),
      });
      return {
        network: {
          host: config.remote.listen ?? "0.0.0.0",
          port: config.remote.port,
          devices,
          tls: { key: identity.privateKey, cert: identity.certificate },
          ...(config.remote.token === null ? {} : { token: config.remote.token }),
        },
        pairing,
      };
    },
    state,
    serverProof: (challenge, deviceId) => {
      if (!identity) return null;
      try {
        return sign(
          "sha256",
          serverProofPayload({ challenge, serverId: identity.serverId, deviceId }),
          createPrivateKey(identity.privateKey),
        ).toString("base64url");
      } catch {
        return null;
      }
    },
    onCommand: (command, peer) => {
      switch (command.type) {
        case "set-muted":
          control.sendToVoicePeer({
            type: "route-set-muted",
            target: command.target,
            muted: command.muted,
          });
          return;
        case "hold-unmuted":
          control.sendToVoicePeer({
            type: "route-hold",
            target: command.target,
            source: remoteUnmuteSource(peer.id, command.input),
          });
          return;
        case "release-unmuted":
          control.sendToVoicePeer({
            type: "route-release",
            target: command.target,
            source: remoteUnmuteSource(peer.id, command.input),
            commit: command.commit,
          });
          return;
        case "redial":
          if (!control.sendToVoicePeer({ type: "route-redial" })) {
            debugLog?.("redial requested with no voice peer");
          }
          return;
        case "fresh":
          void runtime?.fresh();
          return;
        case "offer":
          runtime?.offer(command.sdp);
          return;
        case "voice-state":
          voiceState = command.voice;
          control.publish();
          return;
        default:
          return;
      }
    },
    onPeerClose: (peer: ControlPeerHandle) => {
      // Blind release: MuteGate ignores a source it never held.
      for (const target of AUDIO_TARGETS) {
        for (const input of UNMUTE_INPUTS) {
          control.sendToVoicePeer({
            type: "route-release",
            target,
            source: remoteUnmuteSource(peer.id, input),
            commit: false,
          });
        }
      }
    },
    onVoicePeerAttached: () => {
      // The incumbent's published state is stale the moment it is superseded.
      voiceState = null;
      control.publish();
      const info = runtime?.currentReady;
      if (info) control.sendToVoicePeer({ type: "session-ready", info });
      log("voice peer attached");
    },
    ...(debugLog ? { debug: debugLog } : {}),
    onVoicePeerGone: () => {
      voiceState = null;
      // A session nobody can hear or mute must not outlive its media peer.
      runtime?.voiceGone();
      control.publish();
      if (!shuttingDown) log("voice peer detached; voice session stopped");
    },
  });

  try {
    await control.start();
  } catch (error) {
    throw new ServerError(
      `could not open the control listeners: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const networkAddress = control.networkAddress();
  const activeIdentity = identity as ServerIdentity | null;
  const activePairing = pairing as PairingCoordinator | null;
  if (networkAddress && activeIdentity && activePairing) {
    const tailscaleDnsName = tailscaleEndpoints.find((endpoint) => isIP(endpoint) === 0);
    advertiser = new BonjourAdvertiser({
      name: defaultBonjourName(),
      port: config.remote.port,
      serverId: activeIdentity.serverId,
      ...(tailscaleDnsName ? { tailscaleDnsName } : {}),
    });
    advertiser.update(activePairing.isOpen());
    log(`paired network peers may attach securely at wss://${networkAddress}`);
    if (tailscaleEndpoints.length > 0) log(`Tailscale routes: ${tailscaleEndpoints.join(", ")}`);
  }

  try {
    runtime = await VoiceRuntime.start(
      config,
      version,
      {
        onReady: (info) => {
          control.sendToVoicePeer({ type: "session-ready", info });
        },
        onAnswer: (sdp) => {
          control.sendToVoicePeer({ type: "session-answer", sdp });
        },
        onClosed: (reason) => {
          control.sendToVoicePeer({
            type: "session-closed",
            ...(reason === undefined ? {} : { reason }),
          });
        },
        onRedial: (reason) => {
          control.sendToVoicePeer({ type: "session-redial", reason });
        },
        onError: (message, fatal) => {
          if (!control.sendToVoicePeer({ type: "session-error", message, fatal })) {
            log(`voice error with no voice peer: ${message}`);
          }
        },
        onWorker: (worker) => {
          const seconds =
            worker.finishedAt === undefined
              ? ""
              : ` (${Math.max(0, Math.round((worker.finishedAt - worker.startedAt) / 1000))}s)`;
          log(`worker ${worker.id} · ${worker.title} — ${worker.status}${seconds}`);
        },
        onStatus: (line) => log(line),
        ...(debugLog ? { debug: debugLog } : {}),
      },
      options.configSource ? { configSource: options.configSource } : {},
    );
  } catch (error) {
    advertiser?.close();
    advertiser = null;
    await control.close().catch(() => {});
    throw new ServerError(error instanceof Error ? error.message : String(error));
  }

  log("serving");
  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      log("shutting down");
      void (async () => {
        advertiser?.close();
        advertiser = null;
        await control.close().catch(() => {});
        await runtime?.shutdown().catch(() => {});
        resolve();
      })();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}
