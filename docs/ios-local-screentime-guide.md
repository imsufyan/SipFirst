# SipFirst iOS Local-Only Guide

This project is implemented to stay fully on-device for iOS.

## Important iOS constraint

Apple does not provide a public API to enumerate all installed apps for third-party apps.  
You must let the parent choose apps using `FamilyActivityPicker`, then manage only those selected apps.

## Step-by-step setup

1. Run iOS pods and open workspace: `cd ios && pod install`, then `open SipFirst.xcworkspace`.
2. In Xcode app target, add capabilities: `Family Controls` and `App Groups` with `group.com.plentycompany.sipfirst`.
3. Create extension targets: Shield Action Extension and Device Activity Monitor Extension.
4. Add the same capabilities to both extensions: `Family Controls` and `App Groups` with `group.com.plentycompany.sipfirst`.
5. Wire deep link: URL scheme `sipfirst`; extension writes token to App Group and opens `sipfirst://challenge?...`.
6. Implement picker-backed token storage: present `FamilyActivityPicker` from native UI, then save selected tokens in App Group.
7. Apply shields with `ManagedSettingsStore` using selected tokens.
8. Run challenge flow on device using VisionCamera and local ML/liquid detection pass/fail.
9. For temporary unlock, remove shield for selected token only and relock after parent-selected duration.
10. Enforce relock in both extension and app foreground checks when unlock expires.
