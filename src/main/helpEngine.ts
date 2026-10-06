import { Notification } from "electron";
import { AppDatabase } from "./database";
import { HelpCheckResult, NotificationRecord } from "../shared/types";

function hoursUntil(iso: string) {
  return (new Date(iso).getTime() - Date.now()) / 3600_000;
}

function inQuietHours(start: string, end: string) {
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  const s = sh * 60 + sm;
  const e = eh * 60 + em;
  if (s === e) return false;
  return s < e ? minutes >= s && minutes < e : minutes >= s || minutes < e;
}

export class HelpEngine {
  constructor(
    private db: AppDatabase,
    private onNotify: (notification: NotificationRecord) => void,
    private onNotificationClick: () => void
  ) {}

  run(trigger: "timer" | "manual"): HelpCheckResult {
    const settings = this.db.getSettings();
    if (!settings.notificationsEnabled) {
      return { created: false, message: "Notifications are disabled in settings." };
    }
    if (trigger === "timer" && !settings.backgroundChecksEnabled) {
      return { created: false, message: "Background checks are disabled." };
    }
    if (trigger === "timer" && inQuietHours(settings.quietStart, settings.quietEnd)) {
      return { created: false, message: "Skipped because the app is inside quiet hours." };
    }

    const candidates = this.db.getDueSoonAssignments(7)
      .filter((a) => a.dueAt)
      .sort((a, b) => new Date(a.dueAt!).getTime() - new Date(b.dueAt!).getTime());

    for (const assignment of candidates) {
      if (this.db.hasRecentNotification(assignment.id, "deadline-risk", 12)) continue;
      const hours = Math.max(0, hoursUntil(assignment.dueAt!));
      const days = Math.max(1, Math.ceil(hours / 24));
      const notification = this.createAndDeliver({
        kind: "deadline-risk",
        title: `${assignment.courseCode}: ${assignment.title}`,
        body: `Due in about ${days} day${days === 1 ? "" : "s"}. Pick one concrete first step you can start next.`,
        reason: `Rule fired because this Blackboard assignment is due within 7 days and no deadline-risk nudge was sent in the last 12 hours.`,
        assignmentId: assignment.id
      });
      return { created: true, message: "A deadline-risk nudge was created.", notification };
    }

    return { created: false, message: "No assignment currently meets the prototype nudge rule." };
  }

  sendTestNotification(): NotificationRecord {
    return this.createAndDeliver({
      kind: "test",
      title: "Student Assistant test",
      body: "System tray notifications are working. Click this notification to reopen the app.",
      reason: "Manual test notification requested by the user.",
      assignmentId: null
    });
  }

  private createAndDeliver(input: Omit<NotificationRecord, "id" | "createdAt" | "deliveredAt">) {
    const createdAt = new Date().toISOString();
    const record = this.db.insertNotification({ ...input, createdAt, deliveredAt: null });

    if (Notification.isSupported()) {
      const native = new Notification({ title: record.title, body: record.body });
      native.on("click", this.onNotificationClick);
      native.show();
      const deliveredAt = new Date().toISOString();
      this.db.markNotificationDelivered(record.id, deliveredAt);
      record.deliveredAt = deliveredAt;
    }

    this.onNotify(record);
    return record;
  }
}
