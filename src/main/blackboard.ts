import fs from "fs";
import { AppDatabase } from "./database";
import { ConsentScope } from "../shared/types";

interface ApiResponseDump {
  generatedAt: string;
  description: string;
  responses: Array<{
    method: string;
    endpoint: string;
    status: number;
    body: any;
  }>;
}

const SOURCE_ID = "blackboard-mock";

function findResponse(dump: ApiResponseDump, endpoint: string) {
  const response = dump.responses.find((r) => r.endpoint === endpoint);
  if (!response) throw new Error(`Mock response missing for ${endpoint}`);
  return response;
}

function recordTypeFromEndpoint(endpoint: string) {
  if (endpoint.includes("gradebook/columns")) return "gradebook_column";
  if (endpoint.includes("announcements")) return "announcement";
  if (endpoint.includes("/contents")) return "content";
  if (endpoint.includes("/calendars/items")) return "calendar_item";
  if (/\/courses\/_\d+_1$/.test(endpoint)) return "course";
  if (endpoint.includes("users/me/courses")) return "membership";
  return "unknown";
}

function stripHtml(value: string | undefined | null): string | null {
  if (!value) return null;
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .trim();
}

export class MockBlackboardConnector {
  constructor(private db: AppDatabase, private dumpPath: string) {}

  sync() {
    const required: ConsentScope[] = ["courses"];
    required.forEach((scope) => {
      if (!this.db.hasConsent(SOURCE_ID, scope)) {
        throw new Error(`Blackboard connector is not authorized for '${scope}'.`);
      }
    });

    const dump = JSON.parse(fs.readFileSync(this.dumpPath, "utf8")) as ApiResponseDump;
    const retrievedAt = new Date().toISOString();

    // 1) Current user's course memberships tell us which course IDs to load.
    const membershipsEndpoint = "/learn/api/public/v1/users/me/courses";
    const memberships = findResponse(dump, membershipsEndpoint).body.results ?? [];
    const courseExternalIds = memberships.map((m: any) => m.courseId);

    for (const membership of memberships) {
      this.storeRaw(membershipsEndpoint, "membership", membership, retrievedAt);
    }

    // 2) Normalize individual course objects.
    for (const courseExternalId of courseExternalIds) {
      const courseEndpoint = `/learn/api/public/v1/courses/${courseExternalId}`;
      const course = findResponse(dump, courseEndpoint).body;
      const rawRecordId = this.storeRaw(courseEndpoint, "course", course, retrievedAt);
      this.db.upsertCourse({
        id: `${SOURCE_ID}:course:${course.id}`,
        sourceId: SOURCE_ID,
        externalId: course.id,
        courseCode: course.courseId ?? course.externalId ?? course.id,
        title: course.name,
        term: course.term?.name ?? null,
        description: stripHtml(course.description),
        rawRecordId
      });
    }

    // 3) Assignment/gradebook data. Description is enriched from linked content when possible.
    if (this.db.hasConsent(SOURCE_ID, "assignments")) {
      for (const courseExternalId of courseExternalIds) {
        const gradeEndpoint = `/learn/api/public/v2/courses/${courseExternalId}/gradebook/columns`;
        const contentEndpoint = `/learn/api/public/v1/courses/${courseExternalId}/contents`;
        const gradeColumns = findResponse(dump, gradeEndpoint).body.results ?? [];
        const contents = findResponse(dump, contentEndpoint).body.results ?? [];
        const contentsById = new Map(contents.map((c: any) => [c.id, c]));

        for (const content of contents) this.storeRaw(contentEndpoint, "content", content, retrievedAt);

        for (const column of gradeColumns) {
          const rawRecordId = this.storeRaw(gradeEndpoint, "gradebook_column", column, retrievedAt);
          const content: any = column.contentId ? contentsById.get(column.contentId) : undefined;
          this.db.upsertAssignment({
            id: `${SOURCE_ID}:assignment:${courseExternalId}:${column.id}`,
            sourceId: SOURCE_ID,
            courseId: `${SOURCE_ID}:course:${courseExternalId}`,
            externalId: column.id,
            title: column.name,
            description: stripHtml(content?.body ?? content?.description ?? column.description),
            dueAt: column.grading?.due ?? null,
            possiblePoints: typeof column.score?.possible === "number" ? column.score.possible : null,
            modifiedAt: content?.modified ?? column.modified ?? column.created ?? null,
            rawRecordId
          });
        }
      }
    }

    // 4) Announcements are a separate normalized type.
    if (this.db.hasConsent(SOURCE_ID, "announcements")) {
      for (const courseExternalId of courseExternalIds) {
        const endpoint = `/learn/api/public/v1/courses/${courseExternalId}/announcements`;
        const results = findResponse(dump, endpoint).body.results ?? [];
        for (const announcement of results) {
          const rawRecordId = this.storeRaw(endpoint, "announcement", announcement, retrievedAt);
          this.db.upsertAnnouncement({
            id: `${SOURCE_ID}:announcement:${courseExternalId}:${announcement.id}`,
            sourceId: SOURCE_ID,
            courseId: `${SOURCE_ID}:course:${courseExternalId}`,
            externalId: announcement.id,
            title: announcement.title,
            body: stripHtml(announcement.body) ?? "",
            createdAt: announcement.created ?? null,
            modifiedAt: announcement.modified ?? null,
            rawRecordId
          });
        }
      }
    }

    // 5) We keep calendar data in the raw layer for now. It demonstrates that a second
    // Blackboard object can corroborate due dates without changing the normalized schema.
    if (this.db.hasConsent(SOURCE_ID, "calendar")) {
      const endpoint = "/learn/api/public/v1/calendars/items?type=GradebookColumn";
      const results = findResponse(dump, endpoint).body.results ?? [];
      for (const item of results) this.storeRaw(endpoint, "calendar_item", item, retrievedAt);
    }

    this.db.markSourceSynced(SOURCE_ID, retrievedAt);
    return { importedCourses: courseExternalIds.length, syncedAt: retrievedAt };
  }

  private storeRaw(endpoint: string, recordType: string, object: any, retrievedAt: string) {
    const externalId = object.id ?? object.courseId ?? `${recordType}-${Math.random()}`;
    const id = `${SOURCE_ID}:raw:${recordType}:${externalId}`;
    this.db.upsertRawRecord({
      id,
      sourceId: SOURCE_ID,
      recordType: recordType || recordTypeFromEndpoint(endpoint),
      externalId,
      endpoint,
      rawJson: object,
      retrievedAt
    });
    return id;
  }
}
