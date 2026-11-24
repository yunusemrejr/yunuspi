---
name: copywriting
description: Write and fix the words people read - UI labels, buttons, headings, slogans, slide and document text, product copy, emails, error and empty states - in English, Turkish or any other language. Tone taken from the subject, the audience and the medium; natural wording a person in that field would use; established terms kept in the form the field knows (Turkish technical copy keeps framework, fork, DataOps, Historian, payload); nothing from the prompt or the process leaking into the deliverable. Use whenever a deliverable contains text a person reads, when text is translated or localized, and when existing text sounds stiff, translated, generic or machine-written. Not for code comments, commit messages or log lines.
---

# Copywriting

The words are part of the product. A reader decides in one line whether a person who knows the field wrote this.

## 1. Read the situation before writing a word

Answer these from the workspace, not from the prompt alone:

- **Medium.** A deck, a document, a web page, a set of UI labels, an email, a video caption. Each has its own length and rhythm.
- **Reader.** Who reads it, what they already know, what they are about to decide or do.
- **Field.** Software, industrial automation, e-commerce, food, finance. Every field has words it uses and words that mark an outsider.
- **Language.** The language of the source and the audience. Mixed material stays consistent within one deliverable.
- **Existing voice.** Read three pieces of the project's own text (a page, a slide, a product description) and continue that voice. Where the existing text is weak, fix it rather than imitate it.

Then fix the terms: one word per concept for the whole deliverable. Write the short list down when the piece is longer than a page (product names, feature names, units, the form of address).

## 2. What good copy does

- Says the thing. A heading names the content; a button names its action with a verb ("Save changes", "Teklif iste"); an error says what happened and what to do next.
- Uses the specific over the general: the number, the product, the step, the name. "Reads 4,000 tags a second" over "high performance".
- Fits the medium. Slides carry phrases, documents carry sentences, labels carry one to three words, slogans carry one concrete claim.
- Sounds like speech from someone in the field. Read it aloud: if nobody at that company would say it across a table, rewrite it.
- Leaves out what the layout already shows. No subtitle that repeats its heading, no helper text for the obvious.

## 3. Machine-written tone to remove

Search the finished text for these and rewrite each one found, in new and in existing material:

- Openers and closers that say nothing: "In today's fast-paced world", "Whether you are X or Y", "Let's dive in", a closing recap of what was just said.
- Hype and filler words: seamless, robust, powerful, cutting-edge, unlock, elevate, leverage, empower, revolutionize, delve, journey, landscape, game-changing; in Turkish: kusursuz, çığır açan, yenilikçi çözümler, uçtan uca (as decoration), güçlü ve esnek, hayal gücünüzün ötesinde.
- Patterns: three adjectives or three short slogans in a row; "not just X, but Y"; "X, not Y" against something the reader never saw; a question the next line answers; chains of dashes; a colon headline on every section ("Speed: redefined").
- Vague benefit with no object: "saves time", "boosts productivity", "verimliliği artırır" with no figure or example behind it.
- Invented facts: metrics, customer names, testimonials, awards, dates. If the project does not hold the fact, it is not written.

## 4. English

Plain words, active verbs, short sentences with one idea each. Sentence case for headings and UI. Contractions are fine in UI and marketing, rare in formal documents. Keep one spelling (US or UK) per deliverable. A slogan is a claim the product can stand behind, not a mood.

## 5. Turkish

Write Turkish that a Turkish engineer, buyer or user would say, never a word-for-word translation.

**Terms the field uses in English stay in English**, written with Turkish suffixes and ordinary Turkish around them. The test: would people say this word in a meeting at work? If they say the English word, the Turkish coinage reads as a machine translation.

| Wrong | Right |
|---|---|
| Eskimiş sistemlerden veri çekmek | Legacy sistemlerden veri çekmek |
| Tarihçi analizi | Historian analizi |
| Veri operasyonları | DataOps |
| Yazılım çatısı | framework |
| Çekme isteği | Pull isteği |
| Çatallama | Fork |
| Yük içinde betik | Payload içerisinde kod |

Other words of this kind: driver, tag, broker, agent, gateway, dashboard, API, backend, frontend, deploy, commit, branch, cloud, edge, firmware, log, cache, token, prompt, pipeline, sprint, e-ticaret terms such as checkout only where the audience says them.

**Ordinary things stay in ordinary Turkish**, and the natural phrase wins over the literal one:

| Wrong | Right |
|---|---|
| Daha düşük dönüşüm bedeli | Uygun dönüşüm maliyeti |
| Abonelik lisans | Abonelik |

Also:

- One form of address for the whole product ("siz" for business and public sites unless the brand speaks as "sen").
- Sentence case in headings and UI ("Hesap ayarları"), correct İ/ı, ş, ğ, ç, ö, ü everywhere, including capitals, alt text and file-facing labels people see.
- Suffixes on foreign words follow how the word is said: "API'ye", "Kepware'in", "fork'u", "DataOps ile".
- No doubled terms that say one thing twice, no noun chains copied from English word order, no passive stacks ("gerçekleştirilmektedir" where "yapılır" or an active verb fits).
- Dates, decimal comma, currency and units in Turkish form (24 Kasım 2026; 1.250,50 TL; %15).

For any other language the same two rules hold: keep what the field keeps in its original form, and say the rest the way a native writer in that field would.

## 6. Nothing from the prompt in the deliverable

A request changes the work; it is never its content. The reader saw neither the request nor the previous version.

- Asked to remove X because Y covers it: X is gone and Y is described on its own terms. Never "Y now covers X, and X has been removed from this list".
- Asked to use a font in the footer: the footer uses it. Never "This footer uses X font".
- No "updated", "new version", "as requested", "rewritten for clarity", no source or slide references to the working files, no notes on what was added, checked or left out.
- This holds in every layer people can open: speaker notes, alt text, tooltips, meta descriptions, comments in a shared document, file names shown to users.
- When such a line is found in existing material, fix it, whether or not it was part of the task.

Factual sources a reader needs (a vendor, a date, a public URL) stay.

## 7. Check before handing over

1. Read every visible string once in place: rendered page, slide, screen. Text that wraps badly, truncates or overflows at 360 px is a copy problem too.
2. Search for the section 3 list and for section 6 lines; in Turkish material also for over-translated terms and missing Turkish letters.
3. Terms: one word per concept, product names spelled as the brand spells them.
4. Every number, name and claim traced to the project's own material.
5. Sweep the whole deliverable when one spot was corrected by the user: the same fault is elsewhere.
