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

Amended after live device verification: Bun's native WebSocket client cannot
honor the custom CA on Android, while its verified `Bun.connect` TLS stream
does. Paired attachments and route probes therefore speak RFC 6455 over that
stream using the existing bounded frame codec; they never retry without the
certificate pin. The hello also carries a `serverChallenge` the Server signs
with its identity key (`auth-proof`), verified before the device trusts any
state, as defense in depth alongside TLS and the device's reciprocal proof.
