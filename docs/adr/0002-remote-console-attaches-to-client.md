# 0002: Remote console attaches to the Client

The Remote console reaches the running Client through an owner-only Unix
socket because the Client owns the duplex audio device, mute state, and both
activity measurements. SSH supplies remote access; AgentVoice opens no new
network listener, and the local protocol never carries audio.

Partly superseded by 0003: a Remote console may now attach from another
machine over an opt-in tailnet listener. Everything above still holds for the
same-machine path, and the protocol still never carries audio.
