# Android call navigation

The connection screen owns pairing and explicit call actions. The Persona screen
owns the conversation controls. Navigation does not own the call transport.

An unpaired launch opens the QR camera. After verified enrollment and durable
storage, the app enters the call, requesting microphone permission separately.
A pending pairing request opens the connection screen with **Finish pairing**;
it never automatically replays enrollment. Canceling an enrollment returns there
and preserves the exact pending request.
A cold launch with saved access opens the Persona and makes one automatic call
attempt. Failure requires an explicit retry; returning to the foreground or
recreating the Activity does not retry a failed attempt. A running call is reused.

Android Back from the Persona releases any held push-to-talk gesture and returns
to the connection screen. The call continues. Return to call opens the same
Persona without reconnecting. Disconnect and the ongoing notification's Hang up
action explicitly end the call. Backgrounding, locking, and leaving the task
do not intentionally stop it. Process termination, permission loss, transport
failure and the existing audio-focus/device-loss guards can still end it; the
service never recreates audio automatically after a process restart.

The Persona has no permanent navigation button. The first three call visits show
“Back returns to connections. Your call stays active.” Long-pressing the Persona
area replays the hint. Its region follows orientation and handedness and excludes
the control deck. An accessibility long-click action exposes the same hint.

## Ownership

`CallService` is private and bound locally by `MainActivity`. It owns `CallOwner`
and one `CallController`; binding/rebinding does not create another call. The
Activity requests the microphone foreground service only while resumed with
permission. Credentials enter through the local binder, never an Intent.
The service uses `START_NOT_STICKY`, and an empty service start cannot initiate
media or inference. A partial wake lock spans only the owned call, beginning
after foreground notification publication and ending on terminal cleanup. It
keeps normal screen-off heartbeats running, including when channels are muted;
it does not override deep Doze or manufacturer battery restrictions. Studio
removes this permission as well as the service.

The ongoing native call notification offers microphone Mute/Unmute and Hang up.
Actions refer to the exact call incarnation, so an old action cannot affect a
successor. Microphone state follows the existing server acknowledgement protocol.
Audio-meter updates do not rebuild the notification. Tapping it returns to the
existing call and cannot start a new one from a stale notification.

Notification permission is requested once on Android 13 and newer. Denial does
not silently retry the permission prompt or prevent an otherwise permitted call;
Android controls visibility of its foreground-service disclosure.

## Studio

Connection-screen and navigation rehearsals use the shared renderer with
synthetic state. The `root-*` scenes are transient and never enter the design
profile or working draft. They make no enrollment, network, microphone or service
request. Studio removes the production call service and its permissions from
its manifest. Existing layout and appearance choices stay intact.

Authentication is a separate interface: call navigation does not interpret QR
secrets or alter the network protocol. See the Android README for the currently
supported enrollment format and storage contract.
