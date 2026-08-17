# 0003: The Remote console crosses machines over a tailnet WebSocket

Superseding 0002's "opens no new network listener", a Remote console may now
run on another machine, reaching the Console through an opt-in WebSocket bound
to a Tailscale address and admitted by a pre-shared token. QUIC has no Bun
runtime and a werift data channel would cost an SDP signaling rendezvous to
buy unreliable-datagram semantics that a ~2 KB/s control stream does not need
— and on a tailnet, WireGuard already supplies the NAT traversal and
encryption that would otherwise justify WebRTC here. The unix socket stays
first-class: it needs no configuration, and it remains the single-Console
lock, which a bind that fails whenever the tailnet is down could not be.
