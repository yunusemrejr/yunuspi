/** Invented specifics in documents the session produced.
 *
 * A weaker model asked for a memo, letter, CV or report fills gaps with plausible facts: a room it
 * was never told about, a phone number, a signature name. Nothing in the file's structure shows it.
 * This compares the specifics a produced document states (contact data, person names, rooms and
 * street addresses, dates, times, amounts) with everything the session actually saw: the user's own
 * words, tool output, and the files the session referenced. What is stated but never seen is reported
 * once, softly worded for derived figures, so the model removes it, marks it as a placeholder, or asks.
 * Pure extraction and matching live here; `collectEvidence` reads the session branch plus referenced
 * files within fixed bounds. `PI_SPECIFICS=off` disables the check. */
import fs from "node:fs";
import path from "node:path";
import { describeBinary } from "./binary-read.ts";
import type { Finding } from "./office-read.ts";

export type Evidence = { text: string; compact: string; words: Set<string>; datesFull: Set<string>; datesDay: Set<string>; datesBare: Set<string>; times: Set<number>; numbers: Set<string> };
export type Unsupported = { contact: string[]; name: string[]; place: string[]; figure: string[]; /** How many distinct contacts, names and places were unsupported before the lists were cut short. */ people: number };

const LIST_LIMIT = 6;
const fold = (value: string): string => value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/ı/g, "i").replace(/[ \t\u00a0]+/g, " ");
const tokens = (value: string): string[] => fold(value).match(/[\p{L}\p{N}]+/gu) ?? [];
const MONTHS: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8, september: 9, sep: 9, sept: 9, october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
  ocak: 1, subat: 2, mart: 3, nisan: 4, mayis: 5, haziran: 6, temmuz: 7, agustos: 8, eylul: 9, ekim: 10, kasim: 11, aralik: 12,
};
const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|ocak|subat|mart|nisan|mayis|haziran|temmuz|agustos|eylul|ekim|kasim|aralik)";
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi;
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'`)\]]+/gi;
const PHONE = /(?<![\w.+-])(?:\+\d{1,3}[ .-]?)?(?:\(\d{2,4}\)[ .-]?|\d{2,4}[ .-])\d{3,4}[ .-]\d{2,4}(?:[ .-]\d{2,4})?(?![\w])/g;
const PLACE_LABEL = "(?:Conference Room|Meeting Room|Room|Suite|Building|Bldg|Floor|Hall|Apt|Apartment|Gate|Booth|Terminal)";
const PLACE = new RegExp(`\\b(${PLACE_LABEL})\\.?\\s*#?\\s*([A-Z](?![A-Za-z])|\\d{1,4}[A-Z]?(?![\\p{L}\\d]))`, "gu");
const STREET = /\b(\d{1,5})\s+((?:[A-Z][\p{L}.'-]+\s+){0,3}?[A-Z][\p{L}'-]+)\s+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Way|Court|Ct|Place|Pl|Sokak|Sk|Cadde|Caddesi)\b/gu;
const NAME_WORD = "[A-Z\\p{Lu}][\\p{L}'’-]+";
const NAME = `(?:(?:Mr|Mrs|Ms|Miss|Dr|Prof)\\.?\\s+)?${NAME_WORD}(?:\\s+${NAME_WORD}){0,2}`;
/** Words that make a capitalised line a role, group or organisation rather than a person. */
const NOT_A_PERSON = new Set(["team", "all", "everyone", "staff", "sir", "madam", "colleagues", "folks", "there", "customer", "client", "guest", "members", "friends", "recipient", "user", "manager", "committee", "department", "dept", "office", "board", "council", "management", "group", "inc", "llc", "ltd", "corp", "co", "gmbh", "company", "university", "school", "hr", "sales", "support", "department", "whom", "concerned", "applicant", "candidate", "reader", "editor", "owner", "director", "officer", "assistant", "coordinator", "administrator", "leadership", "faculty", "employees", "parents", "students", "residents", "neighbors", "neighbours", "partners", "stakeholders", "name", "title", "date", "subject", "regards", "best", "thanks", "sincerely", "signature", "position", "role", "the", "your", "my", "our", "to", "from", "cc", "re", "attn", "attention", "dear", "hello", "hi"]);
const SALUTATION = new RegExp(`^[ \\t]*(?:Dear|Hello|Hi|Hey)[ \\t]+(${NAME})[ \\t]*[,:]?[ \\t]*$`, "gmu");
const SIGNATURE = new RegExp(`(?:Sincerely|Best regards|Kind regards|Warm regards|Regards|Best wishes|Best|Thanks|Thank you|Cheers|Yours sincerely|Yours faithfully|Respectfully|With appreciation|Saygilarimla|Saygılarımla|Sevgilerle)[ \\t]*[,.]?[ \\t]*\\n+[ \\t]*(${NAME_WORD}(?:[ \\t]+${NAME_WORD}){1,3})[ \\t]*(?:\\n|$)`, "gu");
const LABELLED = new RegExp(`^[ \\t]*(?:From|To|Cc|Attn|Attention|Prepared by|Presented by|Submitted by|Author|Signed|Contact|Manager|Supervisor|Sender|Recipient)[ \\t]*:[ \\t]*(${NAME_WORD}(?:[ \\t]+${NAME_WORD}){1,3})(?=[ \\t]*(?:[<,(\\n]|$))`, "gmu");
const HONORIFIC = new RegExp(`\\b(?:Mr|Mrs|Ms|Miss|Dr|Prof)\\.?[ \\t]+(${NAME_WORD}(?:[ \\t]+${NAME_WORD})?)`, "gu");
const AMOUNT = /(?:[$€£₺¥][ ]?(\d[\d.,]*)|(\d[\d.,]*)[ ]?(?:USD|EUR|GBP|TRY|TL|dollars?|euros?|pounds?|lira)\b)/gi;
const TIME_COLON = /(?<![\d:.])([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?[ ]?(a\.?m\.?|p\.?m\.?)?(?![\d:])/gi;
const TIME_MERIDIEM = /(?<![\d:.])(1[0-2]|0?[1-9])[ ]?(a\.?m\.?|p\.?m\.?)(?![\p{L}\d])/giu;

const unique = (values: Iterable<string>): string[] => [...new Set(values)];

/** Candidate numeric values for one printed number: "1,234.50", "1.234,50", "1234,5" and "1.234" read more than one way. */
function numberValues(printed: string): string[] {
  const clean = printed.replace(/[^\d.,]/g, "").replace(/[.,]+$/, "");
  if (!clean) return [];
  const out = new Set<string>(), canonical = (value: string) => String(Number(value));
  const lastDot = clean.lastIndexOf("."), lastComma = clean.lastIndexOf(",");
  if (lastDot >= 0 && lastComma >= 0) out.add(canonical(clean.slice(0, Math.max(lastDot, lastComma)).replace(/[.,]/g, "") + "." + clean.slice(Math.max(lastDot, lastComma) + 1)));
  else if (lastDot >= 0 || lastComma >= 0) {
    const mark = lastDot >= 0 ? "." : ",", at = clean.lastIndexOf(mark), tail = clean.slice(at + 1);
    out.add(canonical(clean.replace(/[.,]/g, "")));
    out.add(canonical(clean.slice(0, at).replace(/[.,]/g, "") + "." + tail));
  } else out.add(canonical(clean));
  return [...out].filter(value => value !== "NaN");
}

type DateParts = { year?: number; month: number; day: number; raw: string };
/** Diacritics and the dotless i removed, case kept, so a reported date reads as the document wrote it. */
const plain = (value: string): string => value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/ı/g, "i").replace(/İ/g, "I");
function dateParts(text: string): DateParts[] {
  const out: DateParts[] = [], folded = plain(text);
  const push = (raw: string, month: number, day: number, year?: number) => { if (month >= 1 && month <= 12 && day >= 1 && day <= 31) out.push({ month, day, raw: raw.trim(), ...(year && year >= 1900 && year <= 2200 ? { year } : {}) }); };
  const year = (value?: string) => value === undefined ? undefined : value.length === 2 ? 2000 + Number(value) : Number(value);
  for (const m of folded.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?[ .]+(?:of[ ]+)?(${MONTH})\\b\\.?,?(?:[ ]+(\\d{4}))?`, "gi"))) push(m[0], MONTHS[m[2].toLowerCase()] ?? 0, Number(m[1]), year(m[3]));
  for (const m of folded.matchAll(new RegExp(`\\b(${MONTH})\\.?[ ]+(\\d{1,2})(?:st|nd|rd|th)?(?!\\d)(?:,?[ ]+(\\d{4}))?`, "gi"))) push(m[0], MONTHS[m[1].toLowerCase()] ?? 0, Number(m[2]), year(m[3]));
  for (const m of folded.matchAll(/(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g)) push(m[0], Number(m[2]), Number(m[3]), Number(m[1]));
  for (const m of folded.matchAll(/(?<![\d.])(\d{1,2})[./](\d{1,2})[./](\d{4}|\d{2})(?![\d])/g)) { push(m[0], Number(m[2]), Number(m[1]), year(m[3])); push(m[0], Number(m[1]), Number(m[2]), year(m[3])); }
  return out;
}
const timeKeys = (hour: number, minute: number, meridiem?: string): number[] => {
  if (meridiem) return [((hour % 12) + (/^p/i.test(meridiem) ? 12 : 0)) * 60 + minute];
  return hour >= 1 && hour <= 12 ? [hour * 60 + minute, ((hour % 12) + 12) * 60 + minute] : [hour * 60 + minute];
};
function timesIn(text: string): Array<{ keys: number[]; raw: string }> {
  const out: Array<{ keys: number[]; raw: string }> = [];
  for (const m of text.matchAll(TIME_COLON)) out.push({ keys: timeKeys(Number(m[1]), Number(m[2]), m[3]), raw: m[0].trim() });
  for (const m of text.matchAll(TIME_MERIDIEM)) out.push({ keys: timeKeys(Number(m[1]), 0, m[2]), raw: m[0].trim() });
  return out;
}
const withoutLinks = (text: string): string => text.replace(URL_RE, " ").replace(EMAIL, " ");

/** Everything the session saw, indexed once for the matches below. */
export function makeEvidence(parts: string[], today: Date = new Date()): Evidence {
  const text = fold(parts.join("\n"));
  const evidence: Evidence = { text, compact: text.replace(/[ ().\-–]/g, ""), words: new Set(tokens(text)), datesFull: new Set(), datesDay: new Set(), datesBare: new Set(), times: new Set(), numbers: new Set() };
  const addDate = (date: DateParts) => { evidence.datesDay.add(`${date.month}-${date.day}`); if (date.year) evidence.datesFull.add(`${date.year}-${date.month}-${date.day}`); else evidence.datesBare.add(`${date.month}-${date.day}`); };
  for (const date of dateParts(text)) addDate(date);
  addDate({ year: today.getFullYear(), month: today.getMonth() + 1, day: today.getDate() });
  for (const time of timesIn(text)) for (const key of time.keys) evidence.times.add(key);
  for (const m of text.matchAll(/\d[\d.,]*\d|\d/g)) for (const value of numberValues(m[0])) evidence.numbers.add(value);
  return evidence;
}

const HONORIFICS = new Set(["mr", "mrs", "ms", "miss", "dr", "prof"]);
const wordsSeen = (name: string, evidence: Evidence): boolean => { const parts = tokens(name).filter(part => part.length >= 2 && !HONORIFICS.has(part)); return parts.length === 0 || parts.every(part => evidence.words.has(part)); };
const personLike = (name: string): boolean => { const parts = tokens(name); return parts.length > 0 && !parts.some(part => NOT_A_PERSON.has(part)); };

/** Specifics the document states that nothing in the evidence supports. */
export function unsupportedSpecifics(documentText: string, evidence: Evidence): Unsupported {
  const contact: string[] = [], name: string[] = [], place: string[] = [], figure: string[] = [];
  const text = documentText.replace(/\u00a0/g, " ");
  for (const m of text.matchAll(EMAIL)) if (!evidence.text.includes(m[0].toLowerCase())) contact.push(m[0]);
  for (const m of text.matchAll(URL_RE)) {
    const shown = m[0].replace(/[.,;:!?]+$/, ""), key = fold(shown).replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/?#]+$/, "");
    if (key && !evidence.text.includes(key)) contact.push(shown);
  }
  for (const m of withoutLinks(text).matchAll(PHONE)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length > 15 || !(digits.length >= 9 || (m[0].startsWith("+") && digits.length >= 8))) continue;
    if (!evidence.compact.includes(digits)) contact.push(m[0].trim());
  }
  const seenNames: string[] = [];
  for (const pattern of [SALUTATION, SIGNATURE, LABELLED, HONORIFIC]) for (const m of text.matchAll(pattern)) {
    const person = m[1].replace(/[.,:]+$/, "").trim(), key = tokens(person).filter(part => !HONORIFICS.has(part)).join(" ");
    if (!key || seenNames.some(known => known === key || known.endsWith(` ${key}`) || key.endsWith(` ${known}`))) continue; // "Dr. Smith" and "Smith" are one person
    if (personLike(person) && !wordsSeen(person, evidence)) { name.push(person); seenNames.push(key); }
  }
  for (const m of text.matchAll(PLACE)) {
    const label = fold(m[1]).split(" ").pop()!.replace(/^bldg$/, "building"), id = fold(m[2]);
    const found = new RegExp(`\\b${label === "building" ? "(?:building|bldg)" : label}\\.?\\s*#?\\s*${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\d])`, "u").test(evidence.text);
    if (!found) place.push(`${m[1]} ${m[2]}`);
  }
  for (const m of text.matchAll(STREET)) {
    const first = tokens(m[2])[0];
    if (first && !new RegExp(`\\b${m[1]}\\s+${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "u").test(evidence.text)) place.push(m[0]);
  }
  // A date written 03/04/2026 reads two ways; it counts as supported when either reading is.
  const dates = new Map<string, boolean>();
  for (const date of dateParts(text)) {
    const day = `${date.month}-${date.day}`;
    const supported = date.year ? evidence.datesFull.has(`${date.year}-${day}`) || evidence.datesBare.has(day) : evidence.datesDay.has(day);
    dates.set(date.raw, (dates.get(date.raw) ?? false) || supported);
  }
  for (const [raw, supported] of dates) if (!supported) figure.push(raw);
  for (const time of timesIn(text)) if (!time.keys.some(key => evidence.times.has(key))) figure.push(time.raw);
  for (const m of text.matchAll(AMOUNT)) {
    const values = numberValues(m[1] ?? m[2] ?? "");
    if (values.length && !values.some(value => evidence.numbers.has(value))) figure.push(m[0].trim());
  }
  const first = (values: string[]) => unique(values).slice(0, LIST_LIMIT);
  return { contact: first(contact), name: first(name), place: first(place), figure: first(figure), people: unique(contact).length + unique(name).length + unique(place).length };
}

const sentence = (values: string[]) => values.join("; ");
const SOURCE = "in the request, the files read or any tool output of this session";
/** Findings for one produced document. Many unsupported names and contacts mean a data-driven merge, so they are reported as one soft note. */
export function specificsFindings(found: Unsupported): Finding[] {
  const findings: Finding[] = [];
  const people = found.people;
  if (people > 10) return [{ severity: "info", code: "unsupported-specifics", message: `${people}+ contacts, names or places in the document appear nowhere ${SOURCE}; if they come from a data file the script read, spot-check a few against it` }];
  if (found.contact.length) findings.push({ severity: "warn", code: "unsupported-contact", message: `Contact details appear nowhere ${SOURCE}: ${sentence(found.contact)}`, hint: "Never invent contact data: remove it, write a visible placeholder such as [phone], or ask the user for the real value" });
  if (found.name.length) findings.push({ severity: "warn", code: "unsupported-name", message: `Names in a greeting, signature or title appear nowhere ${SOURCE}: ${sentence(found.name)}`, hint: "Use only names you were given; otherwise write the role (\"Facilities team\") or a visible [Your name] placeholder and say so" });
  if (found.place.length) findings.push({ severity: "warn", code: "unsupported-place", message: `Rooms or addresses appear nowhere ${SOURCE}: ${sentence(found.place)}`, hint: "Remove invented locations: state a room, building or address only if the user gave it, and drop asides such as \"previously …\" that rely on facts you do not have" });
  if (found.figure.length) findings.push({ severity: "info", code: "unsupported-figure", message: `Dates, times or amounts with no source ${SOURCE}: ${sentence(found.figure)}`, hint: "Derived values are fine (a total you computed, a date from \"next Friday\"); invented ones are not: take those out or ask" });
  return findings;
}

/* ───────────── evidence from the session ───────────── */
const TEXT_REFERENCE = /\.(?:csv|tsv|json|jsonl|txt|md|html?|xml|ya?ml|eml|vcf|ics|log|rtf|tex)$/i;
const BINARY_REFERENCE = /\.(?:docx|xlsx|pptx|odt|ods|odp|pdf)$/i;
const REFERENCE_TOKEN = /[^\s"'`<>|;&()=,]+\.(?:csv|tsv|json|jsonl|txt|md|html?|xml|ya?ml|eml|vcf|ics|log|rtf|tex|docx|xlsx|pptx|odt|ods|odp|pdf)\b/giu;
const MAX_RESULT = 200_000, MAX_FILE = 300_000, MAX_FILES = 12, MAX_TOTAL = 4_000_000;
const textOf = (content: unknown): string => typeof content === "string" ? content : Array.isArray(content) ? content.filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("\n") : "";
/** A call that only looks at files cannot have written the produced file, so what it printed earlier is still the user's material. */
const looksOnly = (name: unknown, args: any): boolean => ["read", "ls", "find", "grep", "deliverable_check"].includes(String(name)) || (name === "office_doc" && ["read", "verify"].includes(String(args?.action)));

/** Text of everything the session was told or showed it, plus bounded contents of referenced input files. Once a produced file has been written, results that mention it (reading it back) no longer count, and neither does the produced file itself. */
export async function collectEvidence(branch: unknown[], options: { cwd: string; produced: string[]; signal?: AbortSignal }): Promise<string[]> {
  const parts: string[] = [], produced = new Set(options.produced.map(file => path.resolve(file)));
  const producedNames = [...produced].map(file => path.basename(file).toLowerCase());
  const calls = new Map<string, { args: string }>(), references = new Set<string>(), written = new Set<string>();
  let total = 0;
  const add = (value: string) => { if (value && total < MAX_TOTAL) { const cut = value.slice(0, MAX_RESULT); parts.push(cut); total += cut.length; } };
  const strings = (value: unknown, depth = 0): string[] => typeof value === "string" ? [value] : depth < 4 && value && typeof value === "object" ? Object.values(value as object).flatMap(item => strings(item, depth + 1)) : [];
  const reference = (value: string) => {
    if (value.length <= 400 && !/\n/.test(value) && (TEXT_REFERENCE.test(value) || BINARY_REFERENCE.test(value))) references.add(value.trim());
    for (const m of value.matchAll(REFERENCE_TOKEN)) references.add(m[0].replace(/^[@`'"]+/, ""));
  };
  for (const entry of branch as any[]) {
    if (entry?.type === "compaction" && typeof entry.summary === "string") { add(entry.summary); continue; }
    const message = entry?.type === "message" ? entry.message : undefined;
    if (!message) continue;
    if (message.role === "user") { const body = textOf(message.content); add(body); reference(body); }
    else if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part?.type !== "toolCall") continue;
        const args = JSON.stringify(part.arguments ?? {}), lower = args.toLowerCase();
        const names = looksOnly(part.name, part.arguments) ? [] : producedNames.filter(name => lower.includes(name));
        for (const name of names) written.add(name);
        calls.set(String(part.id), { args: lower });
        for (const value of strings(part.arguments)) reference(value);
      }
    } else if (message.role === "toolResult") {
      const call = calls.get(String(message.toolCallId));
      if (call && producedNames.some(name => written.has(name) && call.args.includes(name))) continue;
      add(textOf(message.content));
    }
  }
  let files = 0;
  for (const raw of references) {
    if (files >= MAX_FILES || total >= MAX_TOTAL || options.signal?.aborted) break;
    try {
      const file = path.resolve(options.cwd, raw.replace(/^~(?=\/)/, process.env.HOME ?? "~"));
      if (produced.has(file)) continue;
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size === 0 || stat.size > 8_000_000) continue;
      if (TEXT_REFERENCE.test(file)) { const fd = fs.openSync(file, "r"); try { const buffer = Buffer.alloc(Math.min(MAX_FILE, stat.size)); fs.readSync(fd, buffer, 0, buffer.length, 0); add(buffer.toString("utf8")); } finally { fs.closeSync(fd); } files++; }
      else if (BINARY_REFERENCE.test(file)) { const view = await describeBinary(file, { maxChars: MAX_FILE, signal: options.signal }); add(view.text); files++; }
    } catch { /* an unreadable or missing reference adds no evidence */ }
  }
  return parts;
}

/** Findings for a produced document: its text against the session evidence. Empty when nothing is unsupported. */
export function documentFindings(documentText: string, evidenceParts: string[]): Finding[] {
  if (!documentText.trim()) return [];
  return specificsFindings(unsupportedSpecifics(documentText, makeEvidence(evidenceParts)));
}
