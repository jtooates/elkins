import Database from "better-sqlite3";
import { canonicalCourseKey, canonicalItemId, comparableValue } from "./normalization";
import {
  AppSettings,
  AppSnapshot,
  AssignmentRecord,
  ConsentScope,
  ConsentUpdate,
  CourseRecord,
  EgressLogRecord,
  NotificationRecord,
  SourceDetail,
  SourceRecord,
  ClaimInput, ChoiceUpdate, ContentClaim, CourseItemInput, CourseItemView,
  FieldConflict, StudentChoice, ClaimField
} from "../shared/types";

export class AppDatabase {
  private db: Database.Database;

  constructor(databasePath: string) {
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
    this.seedDefaults();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        display_name TEXT NOT NULL,
        description TEXT NOT NULL,
        connected INTEGER NOT NULL DEFAULT 0,
        last_synced_at TEXT
      );

      CREATE TABLE IF NOT EXISTS consents (
        source_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        granted INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (source_id, scope),
        FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS raw_records (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        record_type TEXT NOT NULL,
        external_id TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        retrieved_at TEXT NOT NULL,
        FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS courses (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        external_id TEXT NOT NULL,
        course_code TEXT NOT NULL,
        title TEXT NOT NULL,
        term TEXT,
        description TEXT,
        raw_record_id TEXT,
        FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE,
        FOREIGN KEY (raw_record_id) REFERENCES raw_records(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS assignments (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        course_id TEXT NOT NULL,
        external_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        due_at TEXT,
        possible_points REAL,
        modified_at TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        raw_record_id TEXT,
        FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE,
        FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE,
        FOREIGN KEY (raw_record_id) REFERENCES raw_records(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS announcements (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        course_id TEXT NOT NULL,
        external_id TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT,
        modified_at TEXT,
        raw_record_id TEXT,
        FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE,
        FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE,
        FOREIGN KEY (raw_record_id) REFERENCES raw_records(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        reason TEXT NOT NULL,
        assignment_id TEXT,
        created_at TEXT NOT NULL,
        delivered_at TEXT
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS course_items (
        id TEXT PRIMARY KEY,
        course_key TEXT NOT NULL,
        course_code TEXT NOT NULL,
        course_title TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS content_claims (
        id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL REFERENCES course_items(id) ON DELETE CASCADE,
        source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        field TEXT NOT NULL,
        value TEXT NOT NULL,
        locator TEXT NOT NULL,
        evidence TEXT NOT NULL,
        source_url TEXT,
        observed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_claim_item_field ON content_claims(item_id, field);

      CREATE TABLE IF NOT EXISTS student_choices (
        item_id TEXT NOT NULL REFERENCES course_items(id) ON DELETE CASCADE,
        field TEXT NOT NULL,
        selected_claim_id TEXT,
        selected_value TEXT,
        manual_value TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (item_id, field)
      );

      CREATE TABLE IF NOT EXISTS course_relationships (
        from_item_id TEXT NOT NULL REFERENCES course_items(id) ON DELETE CASCADE,
        relationship TEXT NOT NULL,
        to_item_id TEXT NOT NULL REFERENCES course_items(id) ON DELETE CASCADE,
        PRIMARY KEY (from_item_id, relationship, to_item_id)
      );

      CREATE TABLE IF NOT EXISTS egress_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        purpose TEXT NOT NULL,
        fields_json TEXT NOT NULL,
        payload_preview TEXT NOT NULL,
        model TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  private seedDefaults() {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO sources (id, type, display_name, description, connected)
      VALUES (?, ?, ?, ?, 0)
      ON CONFLICT(id) DO NOTHING
    `).run(
      "blackboard-mock",
      "blackboard",
      "Blackboard (synthetic prototype)",
      "Local API-shaped JSON used to test the Blackboard connector without contacting UMBC."
    );

    this.db.prepare(`
      INSERT INTO sources (id, type, display_name, description, connected)
      VALUES (?, ?, ?, ?, 0) ON CONFLICT(id) DO NOTHING
    `).run(
      "course-website", "website", "CMSC 678 website (public)",
      "Student-authorized import from the public UMBC course schedule."
    );

    const insertConsent = this.db.prepare(`
      INSERT INTO consents (source_id, scope, granted, updated_at)
      VALUES (?, ?, 0, ?)
      ON CONFLICT(source_id, scope) DO NOTHING
    `);
    (["courses", "assignments", "announcements", "calendar"] as ConsentScope[]).forEach((scope) => {
      insertConsent.run("blackboard-mock", scope, now);
      insertConsent.run("course-website", scope, now);
    });

    const defaults: AppSettings = {
      notificationsEnabled: true,
      backgroundChecksEnabled: true,
      startAtLogin: false,
      quietStart: "22:00",
      quietEnd: "08:00"
    };
    const insertSetting = this.db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO NOTHING
    `);
    Object.entries(defaults).forEach(([key, value]) => insertSetting.run(key, String(value)));
  }

  close() {
    this.db.close();
  }

  getSource(sourceId: string): SourceRecord {
    const source = this.db.prepare(`SELECT * FROM sources WHERE id = ?`).get(sourceId) as any;
    if (!source) throw new Error(`Unknown source: ${sourceId}`);
    const consents = this.db.prepare(`SELECT * FROM consents WHERE source_id = ? ORDER BY scope`).all(sourceId) as any[];
    return {
      id: source.id,
      type: source.type,
      displayName: source.display_name,
      description: source.description,
      connected: Boolean(source.connected),
      lastSyncedAt: source.last_synced_at,
      consents: consents.map((c) => ({ scope: c.scope, granted: Boolean(c.granted), updatedAt: c.updated_at }))
    };
  }

  listSources(): SourceRecord[] {
    const rows = this.db.prepare(`SELECT id FROM sources ORDER BY display_name`).all() as { id: string }[];
    return rows.map((row) => this.getSource(row.id));
  }

  updateConsent(update: ConsentUpdate) {
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      this.db.prepare(`UPDATE sources SET connected = ? WHERE id = ?`).run(update.connected ? 1 : 0, update.sourceId);
      const stmt = this.db.prepare(`UPDATE consents SET granted = ?, updated_at = ? WHERE source_id = ? AND scope = ?`);
      const granted = new Set(update.scopes);
      (["courses", "assignments", "announcements", "calendar"] as ConsentScope[]).forEach((scope) => {
        stmt.run(granted.has(scope) ? 1 : 0, now, update.sourceId, scope);
      });
    });
    tx();
  }

  disconnectSource(sourceId: string) {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare(`UPDATE sources SET connected = 0 WHERE id = ?`).run(sourceId);
      this.db.prepare(`UPDATE consents SET granted = 0, updated_at = ? WHERE source_id = ?`).run(now, sourceId);
    })();
  }

  deleteSourceData(sourceId: string) {
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM content_claims WHERE source_id = ?`).run(sourceId);
      this.db.prepare(`DELETE FROM course_items WHERE NOT EXISTS
        (SELECT 1 FROM content_claims c WHERE c.item_id = course_items.id)`).run();
      this.db.prepare(`DELETE FROM announcements WHERE source_id = ?`).run(sourceId);
      this.db.prepare(`DELETE FROM assignments WHERE source_id = ?`).run(sourceId);
      this.db.prepare(`DELETE FROM courses WHERE source_id = ?`).run(sourceId);
      this.db.prepare(`DELETE FROM raw_records WHERE source_id = ?`).run(sourceId);
      this.db.prepare(`UPDATE sources SET last_synced_at = NULL WHERE id = ?`).run(sourceId);
    })();
  }

  hasConsent(sourceId: string, scope: ConsentScope): boolean {
    const row = this.db.prepare(`
      SELECT s.connected, c.granted
      FROM sources s JOIN consents c ON c.source_id = s.id
      WHERE s.id = ? AND c.scope = ?
    `).get(sourceId, scope) as any;
    return Boolean(row?.connected && row?.granted);
  }

  upsertRawRecord(args: {
    id: string;
    sourceId: string;
    recordType: string;
    externalId: string;
    endpoint: string;
    rawJson: unknown;
    retrievedAt: string;
  }) {
    this.db.prepare(`
      INSERT INTO raw_records (id, source_id, record_type, external_id, endpoint, raw_json, retrieved_at)
      VALUES (@id, @sourceId, @recordType, @externalId, @endpoint, @rawJson, @retrievedAt)
      ON CONFLICT(id) DO UPDATE SET
        record_type = excluded.record_type,
        endpoint = excluded.endpoint,
        raw_json = excluded.raw_json,
        retrieved_at = excluded.retrieved_at
    `).run({ ...args, rawJson: JSON.stringify(args.rawJson) });
  }

  upsertCourse(course: {
    id: string;
    sourceId: string;
    externalId: string;
    courseCode: string;
    title: string;
    term: string | null;
    description: string | null;
    rawRecordId: string;
  }) {
    this.db.prepare(`
      INSERT INTO courses (id, source_id, external_id, course_code, title, term, description, raw_record_id)
      VALUES (@id, @sourceId, @externalId, @courseCode, @title, @term, @description, @rawRecordId)
      ON CONFLICT(id) DO UPDATE SET
        course_code = excluded.course_code,
        title = excluded.title,
        term = excluded.term,
        description = excluded.description,
        raw_record_id = excluded.raw_record_id
    `).run(course);
  }

  upsertAssignment(assignment: {
    id: string;
    sourceId: string;
    courseId: string;
    externalId: string;
    title: string;
    description: string | null;
    dueAt: string | null;
    possiblePoints: number | null;
    modifiedAt: string | null;
    rawRecordId: string;
  }) {
    this.db.prepare(`
      INSERT INTO assignments
        (id, source_id, course_id, external_id, title, description, due_at, possible_points, modified_at, raw_record_id)
      VALUES
        (@id, @sourceId, @courseId, @externalId, @title, @description, @dueAt, @possiblePoints, @modifiedAt, @rawRecordId)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        description = excluded.description,
        due_at = excluded.due_at,
        possible_points = excluded.possible_points,
        modified_at = excluded.modified_at,
        raw_record_id = excluded.raw_record_id
    `).run(assignment);
  }

  upsertAnnouncement(announcement: {
    id: string;
    sourceId: string;
    courseId: string;
    externalId: string;
    title: string;
    body: string;
    createdAt: string | null;
    modifiedAt: string | null;
    rawRecordId: string;
  }) {
    this.db.prepare(`
      INSERT INTO announcements
        (id, source_id, course_id, external_id, title, body, created_at, modified_at, raw_record_id)
      VALUES
        (@id, @sourceId, @courseId, @externalId, @title, @body, @createdAt, @modifiedAt, @rawRecordId)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        body = excluded.body,
        created_at = excluded.created_at,
        modified_at = excluded.modified_at,
        raw_record_id = excluded.raw_record_id
    `).run(announcement);
  }

  // Shared content store: raw Blackboard records remain intact.
  upsertCourseItem(item: CourseItemInput) {
    this.db.prepare(`
      INSERT INTO course_items (id, course_key, course_code, course_title, kind, title)
      VALUES (@id, @courseKey, @courseCode, @courseTitle, @kind, @title)
      ON CONFLICT(id) DO UPDATE SET
        course_title = excluded.course_title, course_code = excluded.course_code,
        title = excluded.title
    `).run(item);
  }

  upsertClaim(claim: ClaimInput) {
    this.db.prepare(`
      INSERT INTO content_claims
        (id, item_id, source_id, field, value, locator, evidence, source_url, observed_at)
      VALUES (@id, @itemId, @sourceId, @field, @value, @locator, @evidence, @sourceUrl, @observedAt)
      ON CONFLICT(id) DO UPDATE SET
        value = excluded.value, evidence = excluded.evidence,
        source_url = excluded.source_url, observed_at = excluded.observed_at
    `).run(claim);
  }

  linkCourseItems(fromItemId: string, relationship: string, toItemId: string) {
    this.db.prepare(`
      INSERT OR IGNORE INTO course_relationships (from_item_id, relationship, to_item_id)
      VALUES (?, ?, ?)
    `).run(fromItemId, relationship, toItemId);
  }

  // Every fetch/import is atomic. A malformed source cannot leave half-imported claims.
  importContent(items: CourseItemInput[], claims: ClaimInput[],
    relationships: Array<{ from: string; relationship: string; to: string }> = [],
    replace?: { sourceId: string; courseKey: string; observedAt: string }) {
    this.db.transaction(() => {
      for (const item of items) this.upsertCourseItem(item);
      for (const claim of claims) this.upsertClaim(claim);
      if (replace) {
        // Claims removed from a refreshed page are not treated as still current.
        this.db.prepare(`DELETE FROM content_claims
          WHERE source_id = ? AND observed_at <> ?
          AND item_id IN (SELECT id FROM course_items WHERE course_key = ?)`)
          .run(replace.sourceId, replace.observedAt, replace.courseKey);
        this.db.prepare(`DELETE FROM course_items WHERE NOT EXISTS
          (SELECT 1 FROM content_claims c WHERE c.item_id = course_items.id)`).run();
      }
      for (const relation of relationships) {
        this.linkCourseItems(relation.from, relation.relationship, relation.to);
      }
    })();
  }

  private activeClaims(): ContentClaim[] {
    const rows = this.db.prepare(`
      SELECT cl.*, s.display_name AS source_label
      FROM content_claims cl
      JOIN course_items i ON i.id = cl.item_id
      JOIN sources s ON s.id = cl.source_id
      JOIN consents co ON co.source_id = s.id
        AND co.scope = CASE WHEN i.kind = 'assignment' OR i.kind = 'assessment'
          THEN 'assignments' WHEN i.kind = 'announcement' THEN 'announcements'
          ELSE 'courses' END
      WHERE s.connected = 1 AND co.granted = 1
      ORDER BY cl.observed_at DESC, cl.id
    `).all() as any[];
    return rows.map(r => ({
      id: r.id, itemId: r.item_id, sourceId: r.source_id,
      sourceLabel: r.source_label, field: r.field, value: r.value,
      locator: r.locator, evidence: r.evidence, sourceUrl: r.source_url,
      observedAt: r.observed_at
    }));
  }

  private getChoice(itemId: string, field: string): StudentChoice | null {
    const row = this.db.prepare(`
      SELECT * FROM student_choices WHERE item_id = ? AND field = ?
    `).get(itemId, field) as any;
    return row ? {
      itemId: row.item_id, field: row.field, selectedClaimId: row.selected_claim_id,
      selectedValue: row.selected_value, manualValue: row.manual_value,
      updatedAt: row.updated_at
    } : null;
  }

  private resolveField(itemId: string, field: ClaimField, claims: ContentClaim[]) {
    const choice = this.getChoice(itemId, field);
    const values = [...new Set(claims.map(c => comparableValue(field, c.value)))];
    if (choice?.manualValue) {
      return { value: choice.manualValue, status: "resolved" as const, choice };
    }
    if (choice?.selectedClaimId) {
      const chosen = claims.find(c => c.id === choice.selectedClaimId);
      if (!chosen || chosen.value !== choice.selectedValue) {
        return { value: null, status: "changed" as const, choice };
      }
      return { value: chosen.value, status: "resolved" as const, choice };
    }
    if (values.length > 1) return { value: null, status: "unresolved" as const, choice };
    return { value: claims[0]?.value ?? null, status: "resolved" as const, choice };
  }

  getConflicts(): FieldConflict[] {
    const groups = new Map<string, ContentClaim[]>();
    for (const claim of this.activeClaims()) {
      const key = `${claim.itemId}\u0000${claim.field}`;
      groups.set(key, [...(groups.get(key) ?? []), claim]);
    }
    const result: FieldConflict[] = [];
    const lookup = this.db.prepare(`SELECT * FROM course_items WHERE id = ?`);
    for (const [key, claims] of groups) {
      const [itemId, field] = key.split("\u0000");
      const distinct = new Set(claims.map(c => comparableValue(field as ClaimField, c.value)));
      const decision = this.resolveField(itemId, field as ClaimField, claims);
      if (distinct.size < 2 && decision.status !== "changed") continue;
      const item = lookup.get(itemId) as any;
      result.push({ itemId, courseCode: item.course_code, itemTitle: item.title,
        field: field as ClaimField, claims, choice: decision.choice,
        effectiveValue: decision.value, status: decision.status });
    }
    return result.sort((a, b) => (a.status === "resolved" ? 1 : 0) -
      (b.status === "resolved" ? 1 : 0) || a.itemTitle.localeCompare(b.itemTitle));
  }

  getActiveContentItems(): CourseItemView[] {
    const visibleClaims = this.activeClaims();
    const byItem = new Map<string, ContentClaim[]>();
    for (const c of visibleClaims) byItem.set(c.itemId, [...(byItem.get(c.itemId) ?? []), c]);
    const statement = this.db.prepare(`SELECT * FROM course_items WHERE id = ?`);
    const related = this.db.prepare(`
      SELECT r.relationship, r.to_item_id, i.title FROM course_relationships r
      JOIN course_items i ON i.id = r.to_item_id WHERE r.from_item_id = ?
    `);
    return Array.from(byItem, ([id, claims]) => {
      const row = statement.get(id) as any;
      const fields: Record<string, string | null> = {};
      const unresolvedFields: ClaimField[] = [];
      const fieldNames = [...new Set(claims.map(c => c.field))];
      for (const field of fieldNames) {
        const matching = claims.filter(c => c.field === field);
        const decision = this.resolveField(id, field, matching);
        fields[field] = decision.value;
        if (decision.status !== "resolved") unresolvedFields.push(field);
      }
      return {
        id, courseKey: row.course_key, courseCode: row.course_code,
        courseTitle: row.course_title, kind: row.kind, title: row.title,
        fields, claimCount: claims.length,
        sourceLabels: [...new Set(claims.map(c => c.sourceLabel))],
        unresolvedFields,
        related: (related.all(id) as any[]).map(r => ({
          relationship: r.relationship, itemId: r.to_item_id, title: r.title
        }))
      };
    }).sort((a, b) => a.courseCode.localeCompare(b.courseCode) ||
      a.kind.localeCompare(b.kind) || a.title.localeCompare(b.title));
  }

  saveStudentChoice(update: ChoiceUpdate) {
    if (!this.db.prepare(`SELECT 1 FROM course_items WHERE id = ?`).get(update.itemId)) {
      throw new Error("Unknown course item");
    }
    const candidates = this.activeClaims().filter(c =>
      c.itemId === update.itemId && c.field === update.field);
    if (!candidates.length) throw new Error("No authorized claims for that field");
    const manual = update.manualValue?.trim() || null;
    const selected = update.selectedClaimId || null;
    if (manual && selected) throw new Error("Choose a source OR enter a correction");
    if (!manual && !selected) {
      this.db.prepare(`DELETE FROM student_choices WHERE item_id = ? AND field = ?`)
        .run(update.itemId, update.field);
      return;
    }
    if (manual && update.field === "due_at" &&
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(manual)) {
      throw new Error("Use an ISO date/time with timezone, such as 2026-12-02T23:59:00-05:00");
    }
    if (manual && manual.length > 2000) throw new Error("Correction is too long");
    const choice = selected ? candidates.find(c => c.id === selected) : undefined;
    if (selected && !choice) throw new Error("Selected evidence is unavailable or not authorized");
    this.db.prepare(`
      INSERT INTO student_choices
        (item_id, field, selected_claim_id, selected_value, manual_value, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(item_id, field) DO UPDATE SET
        selected_claim_id = excluded.selected_claim_id,
        selected_value = excluded.selected_value,
        manual_value = excluded.manual_value,
        updated_at = excluded.updated_at
    `).run(update.itemId, update.field, selected, choice?.value ?? null,
      manual, new Date().toISOString());
  }

  markSourceSynced(sourceId: string, iso: string) {
    this.db.prepare(`UPDATE sources SET last_synced_at = ? WHERE id = ?`).run(iso, sourceId);
  }

  getActiveCourses(): CourseRecord[] {
    return (this.db.prepare(`
      SELECT c.* FROM courses c
      JOIN sources s ON s.id = c.source_id
      JOIN consents p ON p.source_id = s.id AND p.scope = 'courses'
      WHERE s.connected = 1 AND p.granted = 1
      ORDER BY c.course_code
    `).all() as any[]).map((r) => ({
      id: r.id,
      sourceId: r.source_id,
      externalId: r.external_id,
      courseCode: r.course_code,
      title: r.title,
      term: r.term,
      description: r.description
    }));
  }

  getActiveAssignments(): AssignmentRecord[] {
    const normalized = this.getActiveContentItems().filter(i => i.kind === "assignment");
    const byKey = new Map(normalized.map(i => [i.id, i]));
    const activeCourses = this.getActiveCourses();
    const originals = (this.db.prepare(`
      SELECT a.*, c.course_code, c.title AS course_title, c.term
      FROM assignments a
      JOIN courses c ON c.id = a.course_id
      JOIN sources s ON s.id = a.source_id
      JOIN consents p ON p.source_id = s.id AND p.scope = 'assignments'
      WHERE s.connected = 1 AND p.granted = 1
    `).all() as any[]).map(this.mapAssignment);
    const matched = new Set<string>();
    const result = originals.map((a) => {
      const course = activeCourses.find(c => c.courseCode === a.courseCode);
      const key = canonicalItemId(canonicalCourseKey(a.courseCode, course?.term ?? null),
        "assignment", a.title);
      const item = byKey.get(key);
      if (!item) return a; // Historical sync still appears before migration.
      matched.add(key);
      return { ...a, dueAt: item.fields.due_at ?? null,
        hasUnresolvedConflict: item.unresolvedFields.includes("due_at"),
        sourceLabels: item.sourceLabels };
    });
    for (const item of normalized) {
      if (matched.has(item.id)) continue;
      result.push({
        id: item.id, sourceId: "course-website", courseId: item.courseKey,
        courseCode: item.courseCode, courseTitle: item.courseTitle,
        externalId: item.id, title: item.title,
        description: item.fields.description ?? null,
        dueAt: item.fields.due_at ?? null,
        possiblePoints: null, modifiedAt: null, status: "open",
        hasUnresolvedConflict: item.unresolvedFields.includes("due_at"),
        sourceLabels: item.sourceLabels
      });
    }
    return result.sort((a, b) => (!a.dueAt ? 1 : !b.dueAt ? -1 :
      a.dueAt.localeCompare(b.dueAt)));
  }

  getActiveAnnouncements() {
    return (this.db.prepare(`
      SELECT a.*, c.course_code
      FROM announcements a
      JOIN courses c ON c.id = a.course_id
      JOIN sources s ON s.id = a.source_id
      JOIN consents p ON p.source_id = s.id AND p.scope = 'announcements'
      WHERE s.connected = 1 AND p.granted = 1
      ORDER BY a.created_at DESC
    `).all() as any[]).map((r) => ({
      id: r.id,
      courseId: r.course_id,
      courseCode: r.course_code,
      title: r.title,
      body: r.body,
      createdAt: r.created_at
    }));
  }

  getAssignmentSource(assignmentId: string): SourceDetail {
    const row = this.db.prepare(`
      SELECT
        a.*, c.course_code, c.title AS course_title,
        r.endpoint, r.retrieved_at, r.raw_json,
        s.id AS s_id, s.type AS s_type, s.display_name, s.description AS s_description,
        s.connected, s.last_synced_at
      FROM assignments a
      JOIN courses c ON c.id = a.course_id
      JOIN raw_records r ON r.id = a.raw_record_id
      JOIN sources s ON s.id = a.source_id
      JOIN consents p ON p.source_id = s.id AND p.scope = 'assignments'
      WHERE a.id = ? AND s.connected = 1 AND p.granted = 1
    `).get(assignmentId) as any;
    if (!row) {
      // Website assignments are stored in course_items instead of the
      // original Blackboard-only assignments table.
      const item = this.getActiveContentItems().find(i =>
        i.id === assignmentId && i.kind === "assignment");
      if (!item) throw new Error("Assignment source not found or not authorized");

      // All visible claims preserve their source, location, and evidence.
      const claims = this.activeClaims().filter(c => c.itemId === item.id);
      const assignment = this.getActiveAssignments().find(a => a.id === assignmentId);
      if (!assignment || !claims.length) throw new Error("No evidence is available");

      return {
        source: this.getSource("course-website"),
        assignment,
        endpoint: claims.find(c => c.sourceUrl)?.sourceUrl ?? "",
        retrievedAt: claims[0].observedAt,
        rawJson: claims
      };
    }
    return {
      source: this.getSource(row.s_id),
      assignment: this.mapAssignment(row),
      endpoint: row.endpoint,
      retrievedAt: row.retrieved_at,
      rawJson: JSON.parse(row.raw_json)
    };
  }

  private mapAssignment = (r: any): AssignmentRecord => ({
    id: r.id,
    sourceId: r.source_id,
    courseId: r.course_id,
    courseCode: r.course_code,
    courseTitle: r.course_title,
    externalId: r.external_id,
    title: r.title,
    description: r.description,
    dueAt: r.due_at,
    possiblePoints: r.possible_points,
    modifiedAt: r.modified_at,
    status: r.status
  });

  insertNotification(n: Omit<NotificationRecord, "id">): NotificationRecord {
    const result = this.db.prepare(`
      INSERT INTO notifications (kind, title, body, reason, assignment_id, created_at, delivered_at)
      VALUES (@kind, @title, @body, @reason, @assignmentId, @createdAt, @deliveredAt)
    `).run(n);
    return { id: Number(result.lastInsertRowid), ...n };
  }

  markNotificationDelivered(id: number, iso: string) {
    this.db.prepare(`UPDATE notifications SET delivered_at = ? WHERE id = ?`).run(iso, id);
  }

  listNotifications(): NotificationRecord[] {
    return (this.db.prepare(`SELECT * FROM notifications ORDER BY created_at DESC LIMIT 100`).all() as any[]).map((r) => ({
      id: r.id,
      kind: r.kind,
      title: r.title,
      body: r.body,
      reason: r.reason,
      assignmentId: r.assignment_id,
      createdAt: r.created_at,
      deliveredAt: r.delivered_at
    }));
  }

  hasRecentNotification(assignmentId: string, kind: string, hours: number): boolean {
    const cutoff = new Date(Date.now() - hours * 3600_000).toISOString();
    const row = this.db.prepare(`
      SELECT id FROM notifications
      WHERE assignment_id = ? AND kind = ? AND created_at >= ?
      LIMIT 1
    `).get(assignmentId, kind, cutoff);
    return Boolean(row);
  }

  getSettings(): AppSettings {
    const rows = this.db.prepare(`SELECT key, value FROM settings`).all() as { key: string; value: string }[];
    const data = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    return {
      notificationsEnabled: data.notificationsEnabled !== "false",
      backgroundChecksEnabled: data.backgroundChecksEnabled !== "false",
      startAtLogin: data.startAtLogin === "true",
      quietStart: data.quietStart ?? "22:00",
      quietEnd: data.quietEnd ?? "08:00"
    };
  }

  setSetting(key: keyof AppSettings, value: boolean | string) {
    this.db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, String(value));
  }

  getDueSoonAssignments(days: number): AssignmentRecord[] {
    const now = new Date();
    const future = new Date(now.getTime() + days * 86400_000);
    return this.getActiveAssignments().filter((a) => {
      if (!a.dueAt) return false;
      const due = new Date(a.dueAt);
      return due >= now && due <= future;
    });
  }

  insertEgressLog(args: Omit<EgressLogRecord, "id">): EgressLogRecord {
    const result = this.db.prepare(`
      INSERT INTO egress_log (purpose, fields_json, payload_preview, model, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(args.purpose, JSON.stringify(args.fields), JSON.stringify(args.payloadPreview), args.model, args.createdAt);
    return { id: Number(result.lastInsertRowid), ...args };
  }

  listEgressLog(): EgressLogRecord[] {
    return (this.db.prepare(`SELECT * FROM egress_log ORDER BY created_at DESC LIMIT 100`).all() as any[]).map((r) => ({
      id: r.id,
      purpose: r.purpose,
      fields: JSON.parse(r.fields_json),
      payloadPreview: JSON.parse(r.payload_preview),
      model: r.model,
      createdAt: r.created_at
    }));
  }

  getSnapshot(meta: AppSnapshot["meta"]): AppSnapshot {
    return {
      sources: this.listSources(),
      courses: this.getActiveCourses(),
      assignments: this.getActiveAssignments(),
      announcements: this.getActiveAnnouncements(),
      notifications: this.listNotifications(),
      egressLog: this.listEgressLog(),
      settings: this.getSettings(),
      meta,
      contentItems: this.getActiveContentItems(),
      conflicts: this.getConflicts()
    };
  }
}
