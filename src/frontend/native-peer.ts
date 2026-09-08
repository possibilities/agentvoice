/** Native client WebRTC endpoint. Session policy belongs to the server. */
import { MediaStreamTrack, RTCPeerConnection, RTCRtpCodecParameters, RtpBuilder } from "werift";
import { SAMPLE_RATE } from "../console/dsp.ts";

export interface MediaPeer {
  offer(): Promise<string>;
  answer(sdp: string): Promise<void>;
  send(frame: Buffer): void;
  close(): Promise<void>;
}
export interface PeerEvents {
  connected(): void;
  failed(): void;
  track(track: MediaStreamTrack): void;
}

export function nativePeer(events: PeerEvents): MediaPeer {
  const pc = new RTCPeerConnection({
    codecs: {
      audio: [
        new RTCRtpCodecParameters({
          mimeType: "audio/opus",
          clockRate: SAMPLE_RATE,
          channels: 2,
        }),
      ],
    },
  });
  const track = new MediaStreamTrack({ kind: "audio" });
  const builder = new RtpBuilder({ between: 20, clockRate: SAMPLE_RATE });
  let closed = false;
  pc.addTransceiver(track, { direction: "sendrecv" });
  pc.createDataChannel("oai-events");
  pc.onTrack.subscribe((remote) => {
    if (!closed && remote.kind === "audio") events.track(remote);
  });
  pc.connectionStateChange.subscribe((state) => {
    if (closed) return;
    if (state === "connected") events.connected();
    else if (state === "failed" || state === "closed") events.failed();
  });
  return {
    async offer() {
      await pc.setLocalDescription(await pc.createOffer());
      const sdp = pc.localDescription?.sdp;
      if (!sdp) throw new Error("No local media description");
      return sdp;
    },
    async answer(sdp) {
      await pc.setRemoteDescription({ type: "answer", sdp });
    },
    send(frame) {
      if (!closed) track.writeRtp(builder.create(frame));
    },
    async close() {
      if (closed) return;
      closed = true;
      await pc.close();
    },
  };
}
