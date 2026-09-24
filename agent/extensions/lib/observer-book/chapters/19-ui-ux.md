---
id: ui-ux
part: design
title: UI and UX craft
summary: Interfaces people can use: hierarchy and primary actions, all states, fast feedback, forms, navigation and information scent, cognitive load, affordances, and verifying the rendered result.
terms: ui ux user interface experience usability layout screen page view component button buttons form forms modal dialog navigation nav menu sidebar header footer card cards dashboard settings onboarding flow state empty loading error toast tooltip click interaction interactive responsive mobile desktop
files: .css .scss .sass .less .tsx .jsx .vue .svelte .html .astro
tools: browser_session render_see design_audit
skills: ui-ux-principles frontend-design product-ui-verification ui-antipattern-review accessible-interaction-design
---

# UI and UX craft

Interfaces succeed when users can tell what to do, do it without friction, and understand what happened. The craft combines perception (what draws the eye), cognition (how much must be remembered) and feedback (what the system tells the user), and it is only verified by looking at the rendered result.

## Verify what renders, not what was written {#verify-rendered}
<!-- terms: screenshot render rendered visual look looks broken layout overflow viewport check see browser | watch: edits-without(browser_session render_see design_audit web_probe) -->

**Principle.** A UI change is unverified until its rendered result has been looked at, at realistic sizes, in its important states.

**Why.** CSS is non-local: an element's appearance depends on the cascade, inherited styles, container sizes, fonts loading late, and real content lengths. A diff shows intent, not what the browser computes. Agents are especially prone to "type-checks green, pixels broken" work because they do not see by default. Rendering at a narrow mobile width and a common desktop width, plus empty, loading and error states, catches most layout defects in minutes.

**Signals.** Several edits to style or component files with no screenshot, render or browser check; claims that a layout is fixed with no image; only one viewport examined.

**Ask.** Has this been rendered at a narrow and a wide viewport, including empty and error states?

**Traps.** Screenshotting a stale build or wrong route; judging from a component story that lacks real content.

## One primary action per view {#hierarchy}
<!-- terms: hierarchy primary secondary action cta button emphasis focus prominent visual weight -->

**Principle.** Every screen should make its most important action unmistakable; everything else is visually subordinate.

**Why.** When several buttons carry equal weight, users hesitate or pick wrong. Visual hierarchy—size, weight, color, position and whitespace—communicates priority before reading begins. A single filled primary button, with secondary actions as outlines or links, lets users act in a glance. Hierarchy also applies to content: headings, key numbers and status must dominate supporting detail.

**Signals.** Multiple filled buttons side by side; destructive and safe actions styled alike; key information buried in uniform text.

**Ask.** What is the one thing a user should do on this screen, and is it the most visually prominent element?

**Traps.** Making everything bold (so nothing is); hiding necessary secondary actions entirely.

## Design every state, not just the happy one {#states}
<!-- terms: empty loading error skeleton spinner partial disabled success state states offline -->

**Principle.** Each view needs designed empty, loading, error, partial and success states; missing states are where interfaces look broken.

**Why.** Happy-path mockups hide most of what users actually see: first-run empty lists, slow networks, failed requests, permission errors, half-loaded data. Undesigned states produce blank screens, layout jumps and cryptic errors. Good states teach (empty states suggest the first action), reassure (skeletons that match final layout), and recover (errors with a retry and a plain explanation).

**Signals.** Components that render nothing while loading; errors shown as raw messages or console only; empty lists with no guidance.

**Ask.** What does this view show when there is no data, while loading, and when the request fails?

**Traps.** Spinners for sub-100ms operations causing flicker; error messages that blame the user.

## Feedback within 100 milliseconds {#feedback}
<!-- terms: feedback response latency optimistic update pending progress click acknowledgement instant -->

**Principle.** Acknowledge every user action immediately—pressed states, optimistic updates, progress indicators—even when the work takes longer.

**Why.** Around 100 ms feels instant; beyond about a second, users lose the sense of direct manipulation; beyond ten seconds, attention wanders. Immediate acknowledgment prevents double submissions and confusion. Optimistic UI updates make interactions feel instant for likely-to-succeed actions, but must roll back visibly on failure. Long operations need progress and the ability to continue or cancel.

**Signals.** Buttons that do nothing visible until the server responds; double-submit bugs; long waits with no progress.

**Ask.** What does the user see in the first 100 ms after this action, and if it fails?

**Traps.** Optimistic updates for irreversible actions like payments.

## Forms are conversations {#forms}
<!-- terms: form forms input field label validation error message required placeholder submit autocomplete -->

**Principle.** Label every field visibly, validate at the right moment, keep the user's input on errors, and say exactly how to fix each problem next to the field.

**Why.** Forms are where users give up. Placeholder-only labels vanish while typing; validating every keystroke punishes users mid-entry; clearing the form on server error destroys work; generic errors ("invalid input") force guessing. Good forms group related fields, use the right input types and autocomplete attributes, show constraints before submission, and focus the first error.

**Signals.** Placeholders used as labels; errors displayed only at the top; inputs cleared after failed submission; wrong input types on mobile.

**Ask.** If a user makes a mistake in this form, do they keep their input and learn exactly what to fix?

**Traps.** Excessive required fields; clever custom controls that break autofill and accessibility.

## Reduce cognitive load {#cognitive-load}
<!-- terms: cognitive load hick fitts recognition recall progressive disclosure choices options complexity simple -->

**Principle.** Show fewer choices at once, let users recognize rather than recall, and disclose complexity progressively.

**Why.** Hick's law: decision time grows with the number of options. Fitts's law: targets that are small or far are slower to hit. Working memory holds only a few items. Interfaces that present every option, require remembering values across screens, or use unlabeled icons overload users. Progressive disclosure keeps common tasks simple and advanced ones available.

**Signals.** Settings pages with dozens of equal-weight options; icon-only controls without labels; flows requiring users to remember data from a previous step.

**Ask.** Which choices on this screen could be deferred, defaulted or hidden until needed?

**Traps.** Hiding frequently used functions behind menus to look minimal.

## Navigation follows information scent {#navigation}
<!-- terms: navigation nav menu information architecture labels scent findability breadcrumbs search sitemap -->

**Principle.** Users navigate by predicting where things are from labels; use their vocabulary, keep locations consistent, and always show where they are.

**Why.** Information scent is the cue that a link leads toward the goal. Internal jargon, clever labels and inconsistent placement break it, causing pogo-sticking between pages. Consistent global navigation, current-location indicators, breadcrumbs for deep hierarchies and good search let users orient and recover.

**Signals.** Menu labels using internal terms; the same function located differently across pages; no indication of the current section.

**Ask.** Would a first-time user predict from the labels where to find the main tasks?

**Traps.** Mega-menus that expose every page; reorganizing navigation that users have already learned.

## Affordances: interactive things must look interactive {#affordance}
<!-- terms: affordance signifier clickable link button hover cursor underline tap target disabled -->

**Principle.** Interactive elements need visible signifiers—shape, color, underline, cursor, focus ring—and non-interactive elements must not imitate them.

**Why.** Flat design often removes the cues that tell users what can be clicked, leading to missed functionality or clicks on decorative elements. Links should look like links; buttons like buttons; disabled controls should explain why they are disabled. Touch interfaces lack hover, so hover-only signifiers fail there.

**Signals.** Clickable cards or text with no visual cue; decorative elements styled like buttons; actions revealed only on hover.

**Ask.** Can a user tell, without hovering, which elements on this screen are interactive?

**Traps.** Underlining everything; disabled buttons with no explanation.
