# 0104: Attribute local-network privacy to the service runtime

Accepted September 20, 2026. Extends the installer-owned privacy identity in
[0027](0027-service-microphone-identity.md) and the client-owned media boundary in
[0033](0033-client-owned-native-media.md).

## Decision

The canonical generated Info.plist for the private signed service runtime includes
`NSLocalNetworkUsageDescription`. The legacy user LaunchAgent declares
`AssociatedBundleIdentifiers` with the same stable `io.arthack.agentvoice` bundle
identifier so macOS can attribute local-network operations by the agent and its
children to the responsible bundle.

Preserve the existing copied Bun executable, Bun entitlements, explicit microphone
entitlement, ad-hoc signing model, designated requirement, runtime receipt, and
transactional installer ownership. macOS does not require the multicast entitlement,
and this unsandboxed runtime does not gain a network-client entitlement. The change
does not add or widen listeners, origins, firewall rules, Bonjour declarations, or
LAN server exposure.

## Consent and activation

A full install must publish the replacement runtime and restart the LaunchAgent
before the new metadata is active. The first qualifying local-network operation on
macOS 15 or later may prompt and may fail while the prompt is pending. The operator
owns the per-user decision and can change it in System Settings → Privacy & Security
→ Local Network.

The plist metadata supplies the explanation and responsible-code association. It
does not grant access, change the toggle, bypass a denial, or modify TCC. Apple's
[local-network privacy technote](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy)
recommends an Apple-issued signing identity for reliable tracking; this change
deliberately retains AgentVoice's existing ad-hoc identity rather than changing its
distribution or microphone identity.
