# 0061: Own Android call notification control contrast

Accepted September 14, 2026 by the operator.

## Decision

Replace native `Notification.CallStyle` with `DecoratedCustomViewStyle` and
app-owned expanded Hang Up and Mute/Unmute buttons. Android retains the outer
notification frame; the app specifies both the text and background colors of
each control. Compact and heads-up content shows the connection phase, and the
expanded content provides two 48 dp controls. The system header retains elapsed
call time. Content uses Android's notification text appearances on the system
surface, without a second inset background; controls own paired fill/text colors.

The operator and agent observed white Unmute text on an almost-white button on
Samsung Galaxy S22, Android 16/API 36, One UI 8. AgentVoice supplied a plain title
without color overrides. AOSP computes contrast for CallStyle actions, but no
public report established a firmware fix for this exact Samsung rendering case.
The operator chose app-owned controls over palette/span workarounds.

## Boundaries and consequences

The custom notification is the existing microphone service's foreground
notification, with the same channel, ID, publication/removal lifecycle, return
intent and call-incarnation-fenced actions. There is no hidden CallStyle
notification. Service lifetime, wake lock, communication audio mode, audio focus,
device routing, WebRTC, permissions and saved credentials are unchanged.

`CATEGORY_CALL` remains a category hint; it does not register a Telecom call or
restore CallStyle-specific ranking and non-dismissible treatment. Notification
dismissal does not disconnect. The app has no Telecom integration; stronger
coordination with cellular/other calling apps is a separate future decision.
Custom view buttons do not publish the standard action metadata used by companion
notification surfaces. Android controls outer-frame and lock-screen presentation.

## Studio comparison

The original Android CallStyle is retained as a saved Studio choice alongside the
custom renderer. An explicit synthetic notification rehearsal uses the selected
shared renderer with private, incarnation-fenced controls and no media. Android
requires CallStyle foreground ownership, so Studio uses an isolated, non-sticky
short foreground service with a two-minute limit; it never opens the call service.
Only explicit design promotion changes the production renderer; existing profiles
and production continue to select custom. Studio preview visibility is transient.

## Evidence

- [Android call notification guidance](https://developer.android.com/develop/ui/views/notifications/call-style)
- [Custom notification constraints](https://developer.android.com/develop/ui/views/notifications/custom-notification)
- [AOSP Android 16 notification rendering](https://github.com/aosp-mirror/platform_frameworks_base/blob/android16-release/core/java/android/app/Notification.java)
- [Microphone foreground services](https://developer.android.com/develop/background-work/services/fgs/service-types#microphone)

Device rendering and action checks belong in [Android verification](../../android/VERIFICATION.md).
