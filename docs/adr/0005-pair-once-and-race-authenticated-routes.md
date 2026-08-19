# 0005: Pair once and race authenticated routes

Superseding 0003's opt-in token-only WebSocket, the Server always exposes WSS
and normal Android Remote consoles pair once with two-sided numeric comparison,
pin the Server certificate, and prove an individual Android-Keystore key on
every attachment. Bonjour supplies nearby LAN routes and pairing presence;
remembered Tailscale names and addresses supply away-from-LAN routes, all raced
under the same certificate pin, while manual host/token attachment remains only
as an unpinned diagnostic path. Opening the pairing window publishes a distinct
Bonjour instance name as well as a pairing TXT hint, because DNS-SD browsers may
cache TXT changes without reporting the existing instance as newly available.
While unpaired, the Remote console also probes discovered Servers at a bounded
interval; the Server refuses those requests outside a locally opened window, so
the cache hint is an optimization rather than an authorization boundary. A
window owns at most one pairing transcript: if that phone disconnects or fails,
the window closes instead of replacing a code already displayed to either human.

Amended after live device verification: Bun's WebSocket client cannot honor
the certificate pin everywhere — on desktop Bun a pinned dial to any DNS-name
URL fails its TLS handshake (the URL hostname is verified, `serverName`
ignored), and on the Android runtime every `tls.ca` shape fails. Route
candidates therefore resolve to bare IP addresses before the race, and when
no candidate accepts the pin the race reruns without certificate verification
while authentication moves in-protocol: the hello carries a `serverChallenge`
the Server must sign with its identity key (`auth-proof`), verified against
the pinned certificate before the device trusts a single frame. TLS still
blinds passive observers on that path, and the Tailscale routes stay
machine-authenticated by WireGuard regardless. Restoring a true channel pin
via a hand-rolled WebSocket over `node:tls` (the `ws-frame` codec already
exists) is the intended follow-up.
