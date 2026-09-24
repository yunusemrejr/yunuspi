---
id: legal
part: business
title: Licensing, privacy and compliance
summary: Staying on the right side of rights and rules: open-source licenses and attribution, copyright and assets, personal data and consent, cookies and tracking, accessibility and consumer-protection obligations, and knowing when to ask a lawyer.
terms: license licenses licensing mit apache gpl agpl copyleft attribution copyright trademark third party notices privacy gdpr ccpa personal data pii consent cookie cookies tracking tos eula privacy policy compliance legal accessibility law ada wcag data retention
files: license license.md third_party_notices.md privacy.md
tools: package_probe web_asset_check
skills: web-security data-lineage-validation
---

# Licensing, privacy and compliance

Engineering decisions carry legal consequences: which code may be copied, which fonts and images may ship, what data may be collected and kept. An agent cannot give legal advice, but it can recognize when a choice has legal weight, avoid the common violations and flag the rest for the user.

## Know the license before you copy {#oss-licenses}
<!-- terms: license mit apache bsd gpl agpl lgpl copyleft permissive compatible attribution notice copy vendor -->

**Principle.** Check the license of any code, library or snippet before using it; honor attribution requirements and watch for copyleft obligations.

**Why.** Permissive licenses (MIT, BSD, Apache-2.0) allow broad use with attribution and notice preservation; Apache-2.0 adds patent terms. Copyleft licenses (GPL, AGPL) can require releasing derivative source; AGPL extends this to network use. Code copied from the web without a license is not free to use. Vendored code must keep its license files and third-party notices.

**Signals.** Code copied from repositories or answers without license checks; vendored libraries without their license files; GPL code in proprietary products.

**Ask.** What license covers this code or dependency, and are its obligations met?

**Traps.** Assuming "public on GitHub" means "free to use".

## Assets have owners too {#assets-rights}
<!-- terms: copyright image images photo fonts font license stock icons illustrations music trademark logo rights -->

**Principle.** Use images, fonts, icons, music and logos only with a license that covers the intended use; prefer clearly licensed or original assets.

**Why.** Images found in search results, commercial fonts, and music tracks are copyrighted; using them in products or videos can bring takedowns and claims. Font licenses often restrict web embedding or app bundling. Trademarks (other companies' logos, names) require care in marketing. Open licenses (for example CC-BY, OFL) permit use with conditions such as attribution.

**Signals.** Assets pulled from search results or other websites; commercial fonts self-hosted without checking the license; other companies' logos used as endorsements.

**Ask.** Where did this asset come from, and does its license allow this use?

**Traps.** Assuming attribution alone makes any use legal.

## Personal data needs a purpose, consent and limits {#privacy}
<!-- terms: personal data pii gdpr ccpa consent lawful basis purpose minimization retention deletion access request privacy policy -->

**Principle.** Collect only personal data with a clear purpose and legal basis, minimize it, protect it, keep it no longer than needed, and support access and deletion.

**Why.** Privacy laws such as GDPR and CCPA grant people rights over their data and impose obligations on those who collect it. Engineering choices determine compliance: which fields are stored, where logs go, how long backups keep data, whether deletion propagates. Collecting less is the simplest protection. Privacy policies must describe actual practice.

**Signals.** New fields collecting personal data without purpose; personal data in logs or analytics; no deletion path.

**Ask.** Why is this personal data collected, how long is it kept, and how would it be deleted on request?

**Traps.** Treating anonymization as trivial when re-identification is easy.

## Tracking and cookies require consent in many places {#tracking}
<!-- terms: cookie cookies consent banner tracking analytics pixel third party marketing opt-in opt-out do not track -->

**Principle.** Load non-essential cookies, analytics and marketing pixels only according to applicable consent rules, and make refusal as easy as acceptance.

**Why.** In many jurisdictions, non-essential tracking requires prior consent. Consent banners that pre-check boxes or hide the reject option are increasingly penalized. Third-party scripts can collect data beyond what the site intends. Privacy-friendly analytics and server-side aggregation reduce the need for consent and the risk.

**Signals.** Tracking scripts loaded before consent; banners without a reject option; many third-party pixels added casually.

**Ask.** Which scripts on this page track users, and do they load only with valid consent where required?

**Traps.** Consent banners that are decorative while tracking loads regardless.

## Accessibility and consumer rules are obligations {#obligations}
<!-- terms: accessibility law ada eaa section 508 consumer protection subscription cancellation pricing disclosure dark patterns -->

**Principle.** Treat accessibility, clear pricing, honest claims and easy cancellation as legal obligations in many markets, not optional polish.

**Why.** Accessibility laws (such as the ADA in the US and the European Accessibility Act) apply to many digital products. Consumer-protection rules target hidden fees, deceptive urgency, fake reviews and subscriptions that are hard to cancel. Designing these correctly from the start is far cheaper than retrofitting after a complaint.

**Signals.** Cancellation flows harder than sign-up; prices shown without mandatory fees; unverified marketing claims.

**Ask.** Would this flow or claim hold up if a regulator or a disabled user examined it?

**Traps.** Assuming small companies are exempt everywhere.

## Know when to escalate to a professional {#escalate}
<!-- terms: legal advice lawyer counsel compliance risk escalate contract terms liability -->

**Principle.** Flag legal questions with real stakes—contracts, license conflicts, regulated data, health or financial rules—for the user to take to qualified counsel, instead of improvising an answer.

**Why.** General knowledge helps recognize risks but cannot resolve jurisdiction-specific questions. Confident but wrong legal guidance can cause serious harm. The helpful move is to explain the issue, the options and the uncertainty, and recommend professional review for decisions with legal weight.

**Signals.** Definitive legal conclusions offered in regulated areas; contractual or licensing decisions made without flagging risk.

**Ask.** Does this decision carry legal risk that the user should confirm with a professional?

**Traps.** Refusing to discuss legal topics at all when general information would help.
