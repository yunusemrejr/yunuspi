---
id: accessibility
part: design
title: Accessibility
summary: Interfaces for everyone: keyboard operation and focus, native semantics before ARIA, names and labels, dynamic content and dialogs, media and motion, zoom and reflow, and testing with real assistive flows.
terms: accessibility accessible a11y wcag aria screen reader keyboard focus tab tabindex label labels alt text semantic semantics heading landmark role modal dialog live region contrast reduced motion zoom reflow voiceover nvda
files: .html .tsx .jsx .vue .svelte .astro .css
tools: design_audit browser_session render_see
skills: accessible-interaction-design ui-ux-principles product-ui-verification
---

# Accessibility

Accessibility is usability for the full range of people and situations: blind users with screen readers, keyboard-only users, people with tremors, low vision, color blindness, cognitive load, temporary injuries, bright sunlight and slow devices. Most accessibility failures are ordinary engineering mistakes that native HTML would have avoided.

## Everything works with the keyboard {#keyboard}
<!-- terms: keyboard tab order focus visible focus ring tabindex shortcut trap escape enter space -->

**Principle.** Every interactive element must be reachable and operable by keyboard, in a logical order, with a clearly visible focus indicator.

**Why.** Keyboard access underlies screen readers, switch devices and power users. Custom controls built from divs are unreachable; removed outlines make focus invisible; positive tabindex values scramble order. A quick Tab-through of every new screen catches most issues: can you reach everything, see where you are, activate with Enter or Space, and escape overlays?

**Signals.** Clickable divs or spans; outline: none without a replacement; custom widgets without key handlers; overlays that trap or lose focus.

**Ask.** Can the main task on this screen be completed with Tab, Enter, Space and Escape alone, with focus always visible?

**Traps.** Adding tabindex to non-interactive text; focus styles invisible against some backgrounds.

## Native semantics before ARIA {#semantics}
<!-- terms: semantic html button link nav main header heading landmark role aria native element div -->

**Principle.** Use native elements (button, a, label, nav, main, headings, lists, tables) for their purpose; add ARIA only when no native element fits—and then implement the full pattern.

**Why.** Native elements come with keyboard behavior, focus, roles and states for free. ARIA only changes what assistive technology announces; it adds no behavior, so role="button" on a div still needs keyboard handling and focusability. Incorrect ARIA is worse than none. Heading levels and landmarks let screen-reader users navigate by structure.

**Signals.** Divs with click handlers; role attributes on native elements that already have the role; heading levels chosen for size, skipping levels.

**Ask.** Is there a native element that already provides this behavior and semantics?

**Traps.** ARIA attributes copied from examples without the corresponding state updates.

## Every control has an accessible name {#names}
<!-- terms: label labels accessible name aria-label alt text icon button placeholder aria-labelledby -->

**Principle.** Inputs have associated labels, icon-only buttons have names describing their action, and informative images have alt text; decorative images have empty alt.

**Why.** Screen readers announce names; without them users hear "button, button, edit text". Placeholders disappear and are not reliable labels. Alt text should convey the image's purpose in context, not describe pixels ("Chart showing sales doubled in Q3" rather than "chart"). Names should match visible labels so voice-control users can speak what they see.

**Signals.** Icon buttons without aria-label; inputs labelled only by placeholder; images without alt or with file names as alt.

**Ask.** What would a screen reader announce for each control and image here?

**Traps.** Verbose alt text on decorative images; aria-label contradicting visible text.

## Manage focus when content changes {#dynamic}
<!-- terms: focus management modal dialog live region announce route change toast dynamic content spa -->

**Principle.** Move focus deliberately when content changes—into opened dialogs, back to the trigger when closed, to new page headings on route change—and announce important async updates.

**Why.** Single-page apps change content without the page loads assistive technology expects. Opening a modal without moving focus leaves screen-reader users on the page behind it; closing it without restoring focus strands them at the top. Status changes (saved, error, results loaded) need live regions to be announced. Native dialog elements handle much of this.

**Signals.** Custom modals without focus trapping or restoration; toasts with no live region; route changes that keep focus on the old link.

**Ask.** Where does focus go when this dialog opens, closes, or the view changes, and are status updates announced?

**Traps.** Announcing too much, interrupting users constantly.

## Respect motion, media and time {#media-motion}
<!-- terms: reduced motion prefers-reduced-motion captions transcript autoplay flashing seizure timeout time limit -->

**Principle.** Honor prefers-reduced-motion, caption video, provide transcripts for audio, avoid flashing content, and let users extend time limits.

**Why.** Large motion can trigger vestibular disorders; flashing more than three times per second can trigger seizures; autoplaying media disorients screen-reader users; captions serve deaf users and anyone watching without sound. Time limits (session timeouts, auto-advancing carousels) exclude users who read or type slowly.

**Signals.** Animations with no reduced-motion alternative; videos without captions; autoplaying carousels; short timeouts without warning.

**Ask.** What happens for a user who prefers reduced motion or cannot hear this media?

**Traps.** Disabling all feedback under reduced motion instead of reducing movement.

## Zoom, reflow and target size {#zoom-targets}
<!-- terms: zoom 200% 400% reflow responsive text resize touch target size 44px 24px pointer spacing -->

**Principle.** Layouts must reflow at 400% zoom without horizontal scrolling, text must resize, and touch targets need enough size and spacing.

**Why.** Low-vision users zoom heavily; fixed heights clip text and fixed widths force two-dimensional scrolling. Small, crowded targets cause mis-taps for everyone and are unusable with tremors. WCAG's minimum target size is 24×24 CSS pixels; around 44 pixels is comfortable for touch.

**Signals.** Fixed-height containers with text; horizontal scrolling at narrow widths; tiny icon buttons packed together.

**Ask.** Does this layout survive 400% zoom, and are touch targets large and separated enough?

**Traps.** Disabling zoom in the viewport meta tag.

## Test with assistive technology, not only linters {#testing}
<!-- terms: test testing axe lighthouse screen reader voiceover nvda automated manual audit -->

**Principle.** Automated checkers find perhaps a third of issues; complete the picture with keyboard walkthroughs and a screen-reader pass on key flows.

**Why.** Tools catch missing alt text, contrast failures and invalid ARIA, but not whether focus order makes sense, whether announcements are understandable, or whether a custom widget is operable. A short manual pass with a screen reader on the main flow reveals problems automated tools cannot see.

**Signals.** Accessibility claimed from an automated score alone; custom widgets never tried with a screen reader.

**Ask.** Beyond automated checks, has the main flow been completed with keyboard only and with a screen reader?

**Traps.** Treating a perfect automated score as accessibility compliance.
