# 0002: Remote console attaches to the Client

The Remote console reaches the running Client through an owner-only Unix
socket because the Client owns the duplex audio device, mute state, and both
activity measurements. SSH supplies remote access; AgentVoice opens no new
network listener, and the local protocol never carries audio.
