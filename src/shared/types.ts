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
