import { createHash } from "node:crypto";
import type { ClaimField, CourseItemKind } from "../shared/types";

export function canonicalCourseKey(code: string, term: string | null): string {
  const cleanCode = code.toLowerCase().replace(/[^a-z0-9]/g, "");
  const cleanTerm = (term ?? "unknown").toLowerCase().replace(/[^a-z0-9]/g, "");
  return `${cleanCode}:${cleanTerm}`;
}

export function canonicalItemId(courseKey: string, kind: CourseItemKind, title: string): string {
  const lower = title.trim().toLowerCase();
  const homework = lower.match(/\b(?:homework|hw|assignment)\s*#?\s*(\d+)\b/);
  const quiz = lower.match(/\bquiz\s*#?\s*(\d+)\b/);
  let key = lower.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (kind === "assignment" && homework) key = `homework-${homework[1]}`;
  if (kind === "assessment" && quiz) key = `quiz-${quiz[1]}`;
  if (kind === "assessment" && /midterm/i.test(title)) key = "midterm";
  if (kind === "assessment" && /final exam/i.test(title)) key = "final-exam";
  return `${courseKey}:${kind}:${key}`;
}

export function claimId(
  itemId: string, sourceId: string, field: ClaimField, locator: string
): string {
  const content = `${itemId}\u0000${sourceId}\u0000${field}\u0000${locator}`;
  return createHash("sha256").update(content).digest("hex").slice(0, 28);
}

// Identical dates in different ISO representations should not create fake conflicts.
export function comparableValue(field: ClaimField, value: string): string {
  if (field === "due_at" || field === "date" || field === "issued_at") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return field === "date" ? value.slice(0, 10) : date.toISOString();
    }
  }
  return value.trim();
}
