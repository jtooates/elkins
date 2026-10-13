import fs from "node:fs";
import { AppDatabase } from "./database";
import { canonicalCourseKey, canonicalItemId, claimId } from "./normalization";
import type {
  ClaimField, ClaimInput, CourseItemInput, CourseItemKind, ImportResult
} from "../shared/types";

export const COURSE_URL = "https://courses.cs.umbc.edu/graduate/678/fall26/";
const SOURCE_ID = "course-website";
const MAX_HTML_BYTES = 600_000;
const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
};

// This first adapter supports UMBC schedule tables. Adding another university site*
// means implementing another parser; the database model remains unchanged.
function decode(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp|ndash|mdash);/gi, (_, entity: string) => {
    const named: Record<string, string> = {
      amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
      nbsp: " ", ndash: "–", mdash: "—"
    };
    if (entity.startsWith("#x")) return String.fromCodePoint(parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(parseInt(entity.slice(1), 10));
    return named[entity.toLowerCase()] ?? `&${entity};`;
  });
}

function plainText(html: string): string {
  return decode(html.replace(/<\s*br\b[^>]*>/gi, "\n")
    .replace(/<\/\s*(p|div|li|tr|td)\s*>/gi, "\n")
    .replace(/<[^>]*>/g, " ").replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n").trim());
}

function dateFromRow(text: string, year: number): string | null {
  const match = text.match(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(\d{1,2})\s+([A-Za-z]{3})\b/i);
  if (!match) return null;
  const month = MONTHS[match[2].toLowerCase()];
  if (!month) return null;
  const day = Number(match[1]);
  const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return new Date(`${iso}T12:00:00Z`).getUTCDate() === day ? iso : null;
}

function easternDeadline(date: string): string {
  // Resolve the Eastern UTC offset on the given date (including DST).
  const noon = new Date(`${date}T12:00:00Z`);
  const offsetText = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", timeZoneName: "shortOffset"
  }).formatToParts(noon).find(p => p.type === "timeZoneName")?.value ?? "GMT-5";
  const hours = Number(offsetText.replace("GMT", "")) || -5;
  const sign = hours < 0 ? "-" : "+";
  return `${date}T23:59:00${sign}${String(Math.abs(hours)).padStart(2, "0")}:00`;
}

function safeHttpLink(href: string, baseUrl: string): string | null {
  try {
    const url = new URL(decode(href), baseUrl);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch { return null; }
}

function linksInCell(cell: string, baseUrl: string) {
  const links: Array<{ title: string; url: string }> = [];
  for (const match of cell.matchAll(/<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = safeHttpLink(match[2], baseUrl);
    if (url) links.push({ title: plainText(match[3]).slice(0, 120), url });
  }
  return links;
}

export function parseCourseWebsite(html: string, url: string, observedAt: string) {
  const path = new URL(url).pathname;
  const siteId = path.match(/\/(?:graduate|undergraduate)\/(\d+)\/(fall|spring|summer|winter)(\d{2})\//i);
  if (!siteId) throw new Error("This adapter expects /graduate/NUMBER/fallYY/ or similar course URL");
  const code = `CMSC ${siteId[1]}`;
  const term = `${siteId[2][0].toUpperCase()}${siteId[2].slice(1).toLowerCase()} 20${siteId[3]}`;
  const year = Number(`20${siteId[3]}`);
  const courseTitle = plainText(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "Course website");
  const courseKey = canonicalCourseKey(code, term);
  const items = new Map<string, CourseItemInput>();
  const claims = new Map<string, ClaimInput>();
  const relationships: Array<{ from: string; relationship: string; to: string }> = [];

  function addItem(kind: CourseItemKind, title: string): CourseItemInput {
    const id = canonicalItemId(courseKey, kind, title);
    const item = { id, courseKey, courseCode: code, courseTitle, kind, title };
    items.set(id, item);
    return item;
  }
  function addClaim(item: CourseItemInput, field: ClaimField, value: string,
    locator: string, evidence: string, sourceUrl = url) {
    const id = claimId(item.id, SOURCE_ID, field, locator);
    claims.set(id, { id, itemId: item.id, field, value, sourceId: SOURCE_ID,
      locator, evidence: evidence.slice(0, 1000), sourceUrl, observedAt });
  }

  // Extract table rows without bringing arbitrary website JavaScript into Electron.
  // This is intentionally a constrained adapter rather than a general HTML engine.
  let sessionNumber = 0;
  for (const match of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...match[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(m => m[1]);
    if (cells.length < 4) continue;
    const date = dateFromRow(plainText(cells[1]), year);
    if (!date) continue;
    const topic = plainText(cells[2]).replace(/\n/g, " ");
    const events = plainText(cells[3]).replace(/\n/g, " ");
    const evidence = `${plainText(cells[1])} | ${topic} | ${events}`;
    const lessonNumber = plainText(cells[0]);
    const sessionTitle = `Class ${lessonNumber}: ${topic}`;
    const session = addItem("session", sessionTitle);
    addClaim(session, "date", date, `schedule:session:${lessonNumber}:date`, evidence);
    sessionNumber++;

    for (const hm of events.matchAll(/\b(?:Homework|HW)\s*(\d+)\s*(due|out)\b/gi)) {
      const number = hm[1];
      const assignment = addItem("assignment", `Homework ${number}`);
      if (hm[2].toLowerCase() === "due") {
        addClaim(assignment, "due_at", easternDeadline(date),
          `schedule:homework-${number}:due`, evidence);
      } else {
        addClaim(assignment, "issued_at", date,
          `schedule:homework-${number}:out`, evidence);
      }
      relationships.push({ from: session.id, relationship: "MENTIONS", to: assignment.id });
    }
    for (const qm of events.matchAll(/\bQuiz\s*(\d+)(?:\s+on\s+([^;]+?))?(?=\s+Quiz\b|$)/gi)) {
      const quiz = addItem("assessment", `Quiz ${qm[1]}`);
      addClaim(quiz, "date", date, `schedule:quiz-${qm[1]}:date`, evidence);
      relationships.push({ from: session.id, relationship: "HAS_EVENT", to: quiz.id });
      const homework = (qm[2] ?? "").match(/Homework\s*(\d+)/i);
      if (homework) {
        const assignment = addItem("assignment", `Homework ${homework[1]}`);
        relationships.push({ from: quiz.id, relationship: "ASSESSES", to: assignment.id });
      }
    }
    if (/\b(midterm|final)\s+exam\b/i.test(topic)) {
      const title = /midterm/i.test(topic) ? "Midterm Exam" : "Final Exam";
      const exam = addItem("assessment", title);
      addClaim(exam, "date", date, `schedule:${title.toLowerCase().replace(/ /g,"-")}:date`, evidence);
      relationships.push({ from: session.id, relationship: "HAS_EVENT", to: exam.id });
    }
    // Resource links may be PDFs, HTML homework, notebooks or lecture readings.
    const hwOut = events.match(/Homework\s*(\d+)\s*out/i);
    for (const link of linksInCell(cells[3], url)) {
      const assignment = hwOut ? addItem("assignment", `Homework ${hwOut[1]}`) : null;
      const short = link.title || "Course resource";
      const title = assignment ? `${assignment.title} — ${short}` : `${sessionTitle} — ${short}`;
      const resource = addItem("resource", title);
      addClaim(resource, "url", link.url, `resource:${resource.id}`, `${evidence} | Link: ${short}`);
      relationships.push({ from: assignment?.id ?? session.id,
        relationship: "HAS_RESOURCE", to: resource.id });
    }
  }
  if (!sessionNumber) throw new Error("No course schedule rows found; site layout may require a new adapter");

  // Extract explicit due-date statements outside the schedule, preserving provenance.
  const paragraphs = [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)];
  for (const paragraph of paragraphs) {
    const text = plainText(paragraph[1]).replace(/\n/g, " ");
    for (const due of text.matchAll(/\bHomework\s*(\d+)\s+is\s+due\s+([A-Za-z]+)\s+(\d{1,2})\b/gi)) {
      const month = MONTHS[due[2].slice(0, 3).toLowerCase()];
      if (!month) continue;
      const day = Number(due[3]);
      const date = `${year}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
      const assignment = addItem("assignment", `Homework ${due[1]}`);
      addClaim(assignment, "due_at", easternDeadline(date),
        `policy:homework-${due[1]}:due`, text);
    }
    if (/allowed\s+5\s+late\s+days/i.test(text)) {
      const policy = addItem("policy", "Late days");
      addClaim(policy, "description", text.slice(0, 1000), "policy:late-days", text);
    }
  }

  return { code, term, title: courseTitle, courseKey,
    items: [...items.values()], claims: [...claims.values()], relationships };
}

export class WebsiteCourseImporter {
  constructor(private db: AppDatabase, private fixturePath: string) {}

  async import(mode: "fixture" | "live"): Promise<ImportResult> {
    if (!this.db.hasConsent(SOURCE_ID, "courses") ||
        !this.db.hasConsent(SOURCE_ID, "assignments")) {
      throw new Error("Enable website course and assignment consent first");
    }
    const observedAt = new Date().toISOString();
    let html: string;
    if (mode === "fixture") {
      html = fs.readFileSync(this.fixturePath, "utf8");
    } else {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12_000);
      try {
        const res = await fetch(COURSE_URL, {
          redirect: "error", signal: controller.signal,
          headers: { Accept: "text/html" }
        });
        if (!res.ok || !res.headers.get("content-type")?.includes("text/html")) {
          throw new Error(`Unexpected website response: HTTP ${res.status}`);
        }
        const len = Number(res.headers.get("content-length") ?? 0);
        if (len > MAX_HTML_BYTES) throw new Error("Course page exceeds size limit");
        if (!res.body) throw new Error("Empty website response");
        const reader = res.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          total += next.value.byteLength;
          if (total > MAX_HTML_BYTES) {
            await reader.cancel();
            throw new Error("Course page exceeds size limit");
          }
          chunks.push(next.value);
        }
        html = new TextDecoder().decode(Buffer.concat(chunks));
      } finally { clearTimeout(timeout); }
    }
    const parsed = parseCourseWebsite(html, COURSE_URL, observedAt);
    // Store a concise course provenance record, not executable HTML.
    const rawId = "course-website:raw:cmsc678";
    this.db.upsertRawRecord({ id: rawId, sourceId: SOURCE_ID, recordType: "course_website",
      externalId: parsed.courseKey, endpoint: COURSE_URL,
      rawJson: { url: COURSE_URL, mode, itemCount: parsed.items.length },
      retrievedAt: observedAt });
    this.db.upsertCourse({ id: `course-website:course:${parsed.courseKey}`,
      sourceId: SOURCE_ID, externalId: parsed.courseKey,
      courseCode: parsed.code, title: parsed.title, term: parsed.term,
      description: "Imported from the public course schedule", rawRecordId: rawId });
    this.db.importContent(parsed.items, parsed.claims, parsed.relationships,
      { sourceId: SOURCE_ID, courseKey: parsed.courseKey, observedAt });
    this.db.markSourceSynced(SOURCE_ID, observedAt);
    return { courseCode: parsed.code, itemCount: parsed.items.length,
      claimCount: parsed.claims.length, conflicts: this.db.getConflicts().length,
      syncedAt: observedAt, mode };
  }
}
