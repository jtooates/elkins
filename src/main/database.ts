import Database from "better-sqlite3";
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
  SourceRecord
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

    const insertConsent = this.db.prepare(`
      INSERT INTO consents (source_id, scope, granted, updated_at)
      VALUES (?, ?, 0, ?)
      ON CONFLICT(source_id, scope) DO NOTHING
    `);
    (["courses", "assignments", "announcements", "calendar"] as ConsentScope[]).forEach((scope) => {
      insertConsent.run("blackboard-mock", scope, now);
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
    return (this.db.prepare(`
      SELECT a.*, c.course_code, c.title AS course_title
      FROM assignments a
      JOIN courses c ON c.id = a.course_id
      JOIN sources s ON s.id = a.source_id
      JOIN consents p ON p.source_id = s.id AND p.scope = 'assignments'
      WHERE s.connected = 1 AND p.granted = 1
      ORDER BY CASE WHEN a.due_at IS NULL THEN 1 ELSE 0 END, a.due_at ASC
    `).all() as any[]).map(this.mapAssignment);
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
    if (!row) throw new Error("Assignment source not found");
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
      meta
    };
  }
}
