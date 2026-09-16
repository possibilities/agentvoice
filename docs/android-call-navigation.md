# Android call navigation

The connection screen owns pairing and explicit call actions. The Persona screen
owns the conversation controls. Navigation does not own the call transport.

An unpaired launch opens the QR camera. After verified enrollment and durable
storage, the app returns to Connections. **Connect** explicitly selects that server
and requests microphone permission separately. Pairing alone never changes the
selected server or starts a call.
A pending pairing request opens the connection screen with **Finish pairing**;
it never automatically replays enrollment. Canceling an enrollment returns there
and preserves the exact pending request.
A cold launch with an explicitly selected saved server opens the Persona and makes
one automatic call attempt to that server. Saved but unselected profiles open
Connections; migration preserves the old saved server as selected. Failure requires an explicit retry; returning to the foreground or
recreating the Activity does not retry a failed attempt. A running call is reused.

Preparation and the first connection attempt use an illuminated, stationary
Persona and neutral lit controls. The controls remain unavailable until their
real connection and acknowledgement gates permit interaction. Preparing saved
access is distinct from an active connection attempt, and permission/takeover
surfaces retain their actual actions. A failure or later loss of a previously
live connection uses the grey disconnected treatment. Recreating the Activity
does not turn that loss into a fresh initial attempt. See [ADR 0086](adr/0086-illuminated-android-connection-preparation.md).

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

The Persona keeps the same immersive viewport while connecting, connected, or
disconnected. Transport failure must not reveal system bars and squeeze the
trace corridor between the Persona and controls. Back restores system bars on
the connection screen; a swipe can still reveal transient bars. Keeping the
screen awake remains limited to a running call on the Persona screen.

The immersive Persona scene reserves cutouts, waterfall edges, a desktop caption
bar and the keyboard, but not status/navigation bars. When Android reveals those
bars during the overview transition, they overlay the scene without changing
Persona, the control deck or their trace corridor before the task snapshot.
Studio and connections retain their normal safe-drawing insets.

## Saved servers

Connections lists **Server 1**, **Server 2**, and so on, with each server’s host and
port. Names are assigned from list order; forgetting a row closes the numbering
gap. Naming and editing are deferred. **Add server** scans another one-use QR while
retaining existing credentials. One unfinished enrollment can be retried through
**Finish pairing**; it never replaces an existing profile.

**Connect** selects that server and ends any current phone connection before
starting the new one. Its server may then ask **Move voice to this phone?** if a
different client owns voice there. Cancel leaves that destination owner untouched;
it does not reconnect the server just left. Back returns to Connections while a
running call stays active, and **Return to call** enters that exact call.

The row’s options offer **Forget server** with confirmation. Forgetting an active
server first disconnects the call. It removes local saved access, not the server’s
device record; pairing again requires a new code. Unavailable or failed access is
retained until explicitly forgotten. Migration and storage follow
[ADR 0081](adr/0081-saved-android-server-profiles.md).

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

The ongoing notification uses custom expanded controls for microphone Mute/Unmute
and Hang Up inside Android's standard notification frame. Each button owns its
background and text colors to avoid Samsung CallStyle's white-on-white action.
Collapsed and heads-up views show the connection phase; expand for controls.
Actions refer to the exact call incarnation, so an old action cannot affect a
successor. Microphone state follows the existing server acknowledgement protocol.
Audio-meter updates do not rebuild the notification. Tapping it returns to the
existing call and cannot start a new one from a stale notification.

This is the microphone service's foreground notification, not a second notification
or a hidden CallStyle notification. It is updated and removed by the same call
lifecycle. Communication audio mode, audio focus, routing and foreground microphone
capture are independent of its visual style and remain unchanged. The app does not
register calls with Telecom. Unlike CallStyle, this notification does not claim
special call ranking or non-dismissible treatment; swiping it away is not Hang Up.
Custom controls are PendingIntent-backed views, not standard notification action
metadata for companion devices. See [ADR 0061](adr/0061-custom-android-call-notification.md).

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
