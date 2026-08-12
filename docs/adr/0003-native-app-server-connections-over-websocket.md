# 0003: Preserve native App-server connections through the gateway

AgentVoice supervises one App-server on an owner-only Unix listener and gives
its own runtime plus every authenticated `/app-server` peer a distinct native
connection. Gateway frames pass without remapping or method policy, while
AgentVoice's owning connection is observable through an additive frame envelope;
this preserves present and future connection-scoped semantics and lets App-server
release a peer's subscriptions when that peer disconnects.
