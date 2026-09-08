export const browserMediaPage = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AgentVoice</title>
<style>
  :root { color-scheme: dark; font: 18px system-ui, sans-serif; }
  body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: Canvas; color: CanvasText; }
  main { width: min(28rem, calc(100% - 2rem)); display: grid; gap: 0.75rem; padding: 1rem 0; }
  h1 { margin: 0; font-size: 1.5rem; }
  button, select { min-height: 3.5rem; font: inherit; }
  label { display: grid; gap: 0.4rem; }
  #status { min-height: 3.6em; margin: 0; }
  #hold { touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; }
</style>
<main>
  <h1>AgentVoice</h1>
  <label>Server<select id="server"><option value="local" selected>Phone (Termux)</option><option value="remote" disabled>Desktop (Tailscale)</option></select></label>
  <p id="status">Ready. Microphone access begins only when you tap Start.</p>
  <button id="start" type="button">Start voice</button>
  <button id="mute" type="button" disabled>Mute microphone</button>
  <button id="speaker" type="button" disabled>Mute speaker</button>
  <button id="hold" type="button" disabled>Hold to talk</button>
  <audio id="remote" autoplay></audio>
</main>
<script src="app.js"></script>
</html>`;

export const browserMediaScript = `(() => {
  "use strict";
  const start = document.querySelector("#start");
  const mute = document.querySelector("#mute");
  const speaker = document.querySelector("#speaker");
  const hold = document.querySelector("#hold");
  const status = document.querySelector("#status");
  const remote = document.querySelector("#remote");
  const server = document.querySelector("#server");
  let socket;
  let peer;
  let stream;
  let sessionId;
  let startRequested = false;
  let negotiating = false;
  let muted = false;
  let speakerMuted = true;
  let holding = false;
  let heldPointer;
  let connected = false;
  let attempt = 0;

  const show = (message) => { status.textContent = message; };
  const send = (message) => {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };
  const waitForIce = (pc) => new Promise((resolve, reject) => {
    if (pc.iceGatheringState === "complete") return resolve();
    const timer = setTimeout(() => {
      pc.removeEventListener("icegatheringstatechange", changed);
      reject(new Error("ICE gathering timed out"));
    }, 15000);
    const changed = () => {
      if (pc.iceGatheringState !== "complete") return;
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", changed);
      resolve();
    };
    pc.addEventListener("icegatheringstatechange", changed);
  });
  const stopPeer = () => {
    if (stream) for (const track of stream.getAudioTracks()) track.enabled = false;
    if (peer) peer.close();
    if (remote.srcObject) {
      for (const track of remote.srcObject.getTracks()) track.stop();
      remote.srcObject = null;
    }
    peer = undefined;
    negotiating = false;
    holding = false;
    heldPointer = undefined;
    connected = false;
    mute.disabled = true;
    speaker.disabled = true;
    hold.disabled = true;
    hold.textContent = "Hold to talk";
  };
  const stopMedia = () => {
    stopPeer();
    if (stream) for (const track of stream.getTracks()) track.stop();
    stream = undefined;
  };
  const negotiate = async () => {
    if (!startRequested || !sessionId || negotiating || !stream) return;
    negotiating = true;
    const peerSessionId = sessionId;
    let nextPeer;
    try {
      const previousPeer = peer;
      nextPeer = new RTCPeerConnection();
      peer = nextPeer;
      previousPeer?.close();
      nextPeer.createDataChannel("oai-events");
      for (const track of stream.getAudioTracks()) nextPeer.addTrack(track, stream);
      nextPeer.addEventListener("track", (event) => {
        if (peer !== nextPeer || sessionId !== peerSessionId) return;
        remote.srcObject = event.streams[0] || new MediaStream([event.track]);
        void remote.play().catch(() => show("Tap play to allow response audio."));
      });
      nextPeer.addEventListener("connectionstatechange", () => {
        if (peer !== nextPeer || sessionId !== peerSessionId) return;
        const state = nextPeer.connectionState;
        connected = state === "connected";
        hold.disabled = !connected || !muted;
        if (!connected) releaseHold();
        if (state === "connected") send({ type: "connected", sessionId: peerSessionId });
        if (state === "failed") send({ type: "failed", sessionId: peerSessionId, detail: "WebRTC connection failed" });
        show("Voice connection: " + state);
      });
      const offer = await nextPeer.createOffer();
      await nextPeer.setLocalDescription(offer);
      await waitForIce(nextPeer);
      if (peer !== nextPeer || sessionId !== peerSessionId) {
        nextPeer.close();
        return;
      }
      send({ type: "offer", sessionId: peerSessionId, sdp: nextPeer.localDescription.sdp });
      mute.disabled = false;
      speaker.disabled = false;
      show("Connecting voice…");
    } catch (error) {
      if (peer !== nextPeer || sessionId !== peerSessionId) { nextPeer?.close(); return; }
      const detail = error instanceof Error ? error.message : "Unable to negotiate voice";
      send({ type: "failed", sessionId: peerSessionId, detail: detail.slice(0, 256) });
      show(detail);
      if (peer === nextPeer) {
        peer = undefined;
        negotiating = false;
      }
      nextPeer?.close();
    }
  };

  const connect = () => {
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    const activeSocket = new WebSocket(scheme + "//" + location.host + location.pathname + "ws?server=" + server.value);
    socket = activeSocket;
    activeSocket.addEventListener("message", async (event) => {
    if (socket !== activeSocket) return;
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === "prepare" && typeof message.sessionId === "string") {
      if (sessionId && sessionId !== message.sessionId) {
        releaseHold();
        stopPeer();
      }
      sessionId = message.sessionId;
      show(startRequested ? "Preparing voice…" : "Voice service ready. Tap Start.");
      await negotiate();
    } else if (message.type === "answer" && message.sessionId === sessionId && peer) {
      const answerPeer = peer;
      const answerSession = sessionId;
      try {
        await answerPeer.setRemoteDescription({ type: "answer", sdp: message.sdp });
      } catch (error) {
        if (peer !== answerPeer || sessionId !== answerSession) return;
        const detail = error instanceof Error ? error.message : "Unable to apply voice answer";
        send({ type: "failed", sessionId, detail: detail.slice(0, 256) });
        show(detail);
      }
    } else if (message.type === "state" && message.sessionId === sessionId) {
      muted = message.mic.muted;
      speakerMuted = message.speaker.muted;
      for (const track of stream ? stream.getAudioTracks() : []) track.enabled = !message.mic.effectiveMuted && (!muted || holding);
      remote.muted = message.speaker.effectiveMuted;
      mute.textContent = muted ? "Unmute microphone" : "Mute microphone";
      speaker.textContent = speakerMuted ? "Unmute speaker" : "Mute speaker";
      hold.disabled = !muted || !connected;
      if (!muted) releaseHold();
    } else if (message.type === "close" && message.sessionId === sessionId) {
      sessionId = undefined;
      stopPeer();
      show(message.reason || "Waiting for voice service…");
    }
    });
    activeSocket.addEventListener("close", () => {
      if (socket !== activeSocket) return;
      socket = undefined;
      stopMedia();
      show("Call ended. Choose a server and tap Start voice to connect again.");
      startRequested = false;
      sessionId = undefined;
      start.disabled = false;
    });
  };

  start.addEventListener("click", async () => {
    if (start.disabled || socket) return;
    const currentAttempt = ++attempt;
    start.disabled = true;
    try {
      const capture = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      if (currentAttempt !== attempt) { for (const track of capture.getTracks()) track.stop(); return; }
      stream = capture;
      for (const track of stream.getAudioTracks()) track.enabled = false;
      remote.muted = true;
      startRequested = true;
      show("Waiting for voice service…");
      connect();
    } catch (error) {
      if (currentAttempt !== attempt) return;
      show(error instanceof Error ? error.message : "Unable to start microphone");
      start.disabled = false;
    }
  });

  server.addEventListener("change", () => {
    ++attempt;
    releaseHold();
    const previous = socket;
    socket = undefined;
    previous?.close();
    stopMedia();
    sessionId = undefined;
    startRequested = false;
    start.disabled = false;
    show("Server selected. Tap Start voice to begin a new call.");
  });

  mute.addEventListener("click", () => {
    if (!sessionId) return;
    send({ type: "mute", sessionId, target: "mic", muted: !muted });
  });
  speaker.addEventListener("click", () => {
    if (!sessionId) return;
    send({ type: "mute", sessionId, target: "speaker", muted: !speakerMuted });
  });

  const beginHold = () => {
    if (!sessionId || hold.disabled || holding) return false;
    holding = true;
    hold.textContent = "Release to mute";
    send({ type: "hold", sessionId });
    return true;
  };
  hold.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.isPrimary === false) return;
    event.preventDefault();
    if (!beginHold()) return;
    heldPointer = event.pointerId;
    hold.setPointerCapture(event.pointerId);
  });
  const releaseHold = () => {
    if (!holding) return;
    holding = false;
    heldPointer = undefined;
    hold.textContent = "Hold to talk";
    if (muted && stream) for (const track of stream.getAudioTracks()) track.enabled = false;
    if (sessionId) send({ type: "release", sessionId });
  };
  const releasePointer = (event) => { if (event.pointerId === heldPointer) releaseHold(); };
  hold.addEventListener("pointerup", releasePointer);
  hold.addEventListener("pointercancel", releasePointer);
  hold.addEventListener("lostpointercapture", releasePointer);
  hold.addEventListener("keydown", (event) => {
    if (event.code !== "Space" && event.code !== "Enter") return;
    event.preventDefault();
    if (!event.repeat) beginHold();
  });
  hold.addEventListener("keyup", (event) => {
    if (event.code === "Space" || event.code === "Enter") { event.preventDefault(); releaseHold(); }
  });
  hold.addEventListener("contextmenu", (event) => event.preventDefault());
  hold.addEventListener("blur", releaseHold);
  addEventListener("blur", releaseHold);
  document.addEventListener("visibilitychange", () => { if (document.hidden) releaseHold(); });

  addEventListener("pagehide", () => {
    ++attempt;
    if (socket) socket.close();
    stopMedia();
  });
})();`;
