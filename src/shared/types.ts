export type ConsentScope =
  | "courses"
  | "assignments"
  | "announcements"
  | "calendar";

export interface ConsentRecord {
  scope: ConsentScope;
  granted: boolean;
  updatedAt: string;
}

export interface SourceRecord {
  id: string;
  type: string;
  displayName: string;
  description: string;
  connected: boolean;
  lastSyncedAt: string | null;
  consents: ConsentRecord[];
}

export interface CourseRecord {
  id: string;
  sourceId: string;
  externalId: string;
  courseCode: string;
  title: string;
  term: string | null;
  description: string | null;
}

export interface AssignmentRecord {
  id: string;
  sourceId: string;
  courseId: string;
  courseCode: string;
  courseTitle: string;
  externalId: string;
  title: string;
  description: string | null;
  dueAt: string | null;
  possiblePoints: number | null;
  modifiedAt: string | null;
  status: string;
  hasUnresolvedConflict?: boolean;
  sourceLabels?: string[];
}

export interface AnnouncementRecord {
  id: string;
  courseId: string;
  courseCode: string;
  title: string;
  body: string;
  createdAt: string | null;
}

export interface NotificationRecord {
  id: number;
  kind: string;
  title: string;
  body: string;
  reason: string;
  assignmentId: string | null;
  createdAt: string;
  deliveredAt: string | null;
}

export interface EgressLogRecord {
  id: number;
  purpose: string;
  fields: string[];
  payloadPreview: unknown;
  model: string;
  createdAt: string;
}

export interface AppSettings {
  notificationsEnabled: boolean;
  backgroundChecksEnabled: boolean;
  startAtLogin: boolean;
  quietStart: string;
  quietEnd: string;
}

export interface AppMeta {
  databasePath: string;
  prototypeMode: boolean;
  backgroundCheckSeconds: number;
  packaged: boolean;
}

export interface AppSnapshot {
  sources: SourceRecord[];
  courses: CourseRecord[];
  assignments: AssignmentRecord[];
  announcements: AnnouncementRecord[];
  notifications: NotificationRecord[];
  egressLog: EgressLogRecord[];
  settings: AppSettings;
  meta: AppMeta;
  contentItems: CourseItemView[];
  conflicts: FieldConflict[];
}

export interface SourceDetail {
  source: SourceRecord;
  assignment: AssignmentRecord;
  endpoint: string;
  retrievedAt: string;
  rawJson: unknown;
}

export interface ConsentUpdate {
  sourceId: string;
  connected: boolean;
  scopes: ConsentScope[];
}

export interface SettingUpdate {
  key: keyof AppSettings;
  value: boolean | string;
}

export interface HelpCheckResult {
  created: boolean;
  message: string;
  notification?: NotificationRecord;
}

export interface EgressSimulationResult {
  payload: unknown;
  fields: string[];
  message: string;
}

// Shared normalized content model. One logical item may have claims from many sources.
export type CourseItemKind =
  | "assignment" | "assessment" | "session"
  | "resource" | "policy" | "announcement";

export type ClaimField = "due_at" | "date" | "url" | "description" | "issued_at";

export interface CourseItemInput {
  id: string;
  courseKey: string;
  courseCode: string;
  courseTitle: string;
  kind: CourseItemKind;
  title: string;
}

export interface ClaimInput {
  id: string;
  itemId: string;
  sourceId: string;
  field: ClaimField;
  value: string;
  locator: string;
  evidence: string;
  sourceUrl: string | null;
  observedAt: string;
}

export interface ContentClaim extends ClaimInput {
  sourceLabel: string;
}

export interface StudentChoice {
  itemId: string;
  field: ClaimField;
  selectedClaimId: string | null;
  selectedValue: string | null;
  manualValue: string | null;
  updatedAt: string;
}

export interface FieldConflict {
  itemId: string;
  courseCode: string;
  itemTitle: string;
  field: ClaimField;
  claims: ContentClaim[];
  choice: StudentChoice | null;
  effectiveValue: string | null;
  status: "unresolved" | "resolved" | "changed";
}

export interface CourseItemView extends CourseItemInput {
  fields: Record<string, string | null>;
  claimCount: number;
  sourceLabels: string[];
  unresolvedFields: ClaimField[];
  related: Array<{ relationship: string; itemId: string; title: string }>;
}

export interface ImportResult {
  courseCode: string;
  itemCount: number;
  claimCount: number;
  conflicts: number;
  syncedAt: string;
  mode: "fixture" | "live";
}

export interface ChoiceUpdate {
  itemId: string;
  field: ClaimField;
  selectedClaimId?: string | null;
  manualValue?: string | null;
}
