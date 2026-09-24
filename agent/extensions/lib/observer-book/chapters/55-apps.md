---
id: apps
part: web
title: Mobile and desktop apps
summary: Native and cross-platform application craft: platform conventions, offline-first data, lifecycle and background limits, battery and performance, permissions, packaging, updates and store review.
terms: mobile app apps ios android swift kotlin react native flutter electron tauri desktop native cross-platform offline sync push notification permission background battery app store play store packaging installer update window menu tray gtk qt
files: .swift .kt .dart .xaml .plist androidmanifest.xml electron-builder.json tauri.conf.json
tools: sandbox_run render_see desktop_session
skills: desktop-app-dev desktop-ui linux-desktop-ui-ux java-cross-platform dotnet-linux-engineering windows-on-linux-engineering
---

# Mobile and desktop apps

Applications run in environments the developer does not control: interrupted by calls, killed for memory, offline in tunnels, updated on the user's schedule, reviewed by app stores. Good apps respect platform conventions and survive these conditions gracefully.

## Follow platform conventions {#conventions}
<!-- terms: platform conventions human interface guidelines material design native feel navigation back button menus shortcuts -->

**Principle.** Match each platform's conventions—navigation patterns, gestures, menus, shortcuts, typography—so the app feels native to its users.

**Why.** Users carry expectations from every other app on their device: the Android back button, iOS swipe-back, macOS menu bar, Windows window controls, standard keyboard shortcuts. Violating them makes an app feel foreign and error-prone. Cross-platform frameworks make it tempting to ship one design everywhere; adapting key interactions per platform pays off.

**Signals.** iOS-style navigation on Android or the reverse; missing standard shortcuts on desktop; custom controls replacing familiar native ones.

**Ask.** Would a long-time user of this platform find the core interactions familiar?

**Traps.** Following conventions so strictly that the product's own identity disappears.

## Design offline-first when connectivity varies {#offline}
<!-- terms: offline offline-first sync conflict local storage cache queue retry connectivity network -->

**Principle.** Store data locally, queue writes, sync when possible and resolve conflicts deliberately, so the app stays useful without a connection.

**Why.** Mobile connectivity is intermittent. Apps that block on every network call fail in elevators, subways and planes. Offline-first designs read from local storage, show sync state honestly and handle conflicts with clear rules (last-writer-wins, merges or user resolution). The complexity is real, so decide early which features must work offline.

**Signals.** Spinners on every screen when offline; lost edits after connectivity drops; no visible sync state.

**Ask.** What can the user do in this app without a connection, and what happens to their changes?

**Traps.** Silent conflict resolution that discards user data.

## Respect the lifecycle {#lifecycle}
<!-- terms: lifecycle background foreground suspend kill restore state process death resume memory -->

**Principle.** Save state early and restore it seamlessly; assume the operating system may suspend or kill the app at any time.

**Why.** Mobile operating systems aggressively reclaim memory from background apps and restrict background work. Users expect to return to exactly where they were. Apps that lose form input or navigation state after being backgrounded feel broken. Background tasks must use sanctioned mechanisms and tolerate being deferred.

**Signals.** Lost input after switching apps; long tasks assumed to finish in the background; state held only in memory.

**Ask.** If the system kills the app right now, what does the user lose?

**Traps.** Over-persisting sensitive data to disk.

## Battery and performance are features {#efficiency}
<!-- terms: battery performance cpu wakeups polling animation memory startup time jank frame -->

**Principle.** Minimize wakeups, polling and background work; keep startup fast and animations smooth on low-end devices.

**Why.** Users uninstall apps that drain batteries or feel sluggish, and platforms penalize them. Polling, frequent location updates and unbatched network requests waste energy. Startup time shapes first impressions. Testing on older, cheaper devices reveals problems that flagship phones hide.

**Signals.** Timers polling servers; continuous location use; slow cold starts; performance tested only on high-end devices.

**Ask.** How does this feature affect battery and startup on a low-end device?

**Traps.** Premature optimization of rarely used screens.

## Ask for permissions in context {#permissions}
<!-- terms: permission permissions camera location notifications contacts microphone prompt denial just in time -->

**Principle.** Request permissions at the moment they are needed, explain why beforehand, and keep the app useful when permission is denied.

**Why.** Permission prompts at first launch, without context, get denied and are hard to re-request. Just-in-time requests with a clear explanation ("allow camera to scan receipts") get granted more often. Denial must degrade gracefully, with a path to change the decision later. Notification permissions in particular should be earned by demonstrated value.

**Signals.** Multiple permission prompts at launch; features failing silently after denial; notification prompts before any value.

**Ask.** When and why does the app ask for this permission, and what happens if the user says no?

**Traps.** Requesting broader permissions than needed.

## Packaging, updates and review are part of the product {#distribution}
<!-- terms: packaging installer signing notarization update auto-update store review release channel version -->

**Principle.** Sign and notarize builds, provide reliable updates with rollback paths, and design for store review requirements from the start.

**Why.** Unsigned desktop apps trigger scary warnings; broken updaters strand users on old versions; store rejections delay launches. Staged rollouts limit the damage of bad releases. Store guidelines (privacy labels, payment rules, permission justifications) constrain design and must be considered early.

**Signals.** Unsigned builds; no update mechanism; release plans that ignore store review timelines.

**Ask.** How does a user install, update and, if needed, roll back this app?

**Traps.** Forced updates that break users' workflows without warning.
