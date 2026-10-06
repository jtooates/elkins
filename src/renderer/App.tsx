import { useEffect, useMemo, useState } from "react";
import type {
  AppSnapshot,
  ConsentScope,
  EgressSimulationResult,
  SourceDetail
} from "../shared/types";

type Page = "dashboard" | "assignments" | "sources" | "knowledge" | "notifications" | "privacy";

const scopeLabels: Record<ConsentScope, string> = {
  courses: "Course names and descriptions",
  assignments: "Assignments, due dates, and point values",
  announcements: "Course announcements",
  calendar: "Blackboard calendar / gradebook deadline events"
};

function fmtDate(iso: string | null | undefined) {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function App() {
  const [page, setPage] = useState<Page>("dashboard");
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [sourceDetail, setSourceDetail] = useState<SourceDetail | null>(null);
  const [egressPreview, setEgressPreview] = useState<EgressSimulationResult | null>(null);

  const refresh = async () => setSnapshot(await window.studentAssistant.getSnapshot());

  useEffect(() => {
    refresh();
    return window.studentAssistant.onDataChanged(refresh);
  }, []);

  const run = async (fn: () => Promise<any>, success?: (result: any) => string) => {
    setBusy(true);
    try {
      const result = await fn();
      await refresh();
      setToast(success ? success(result) : "Done");
      window.setTimeout(() => setToast(null), 3500);
      return result;
    } catch (error: any) {
      setToast(error?.message ?? String(error));
      window.setTimeout(() => setToast(null), 5000);
    } finally {
      setBusy(false);
    }
  };

  if (!snapshot) return <div className="loading">Opening local student store…</div>;

  const blackboard = snapshot.sources.find((s) => s.id === "blackboard-mock")!;
  const nav: Array<[Page, string, string]> = [
    ["dashboard", "Dashboard", "⌂"],
    ["assignments", "Assignments", "✓"],
    ["sources", "Sources & consent", "◎"],
    ["knowledge", "What I know", "◇"],
    ["notifications", "Notification history", "◌"],
    ["privacy", "Privacy & settings", "▣"]
  ];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">SA</div>
          <div>
            <strong>Student Assistant</strong>
            <span>research prototype</span>
          </div>
        </div>
        <nav>
          {nav.map(([id, label, icon]) => (
            <button key={id} className={page === id ? "nav active" : "nav"} onClick={() => setPage(id)}>
              <span className="nav-icon">{icon}</span>{label}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span className={blackboard.connected ? "status-dot connected" : "status-dot"} />
          {blackboard.connected ? "Blackboard connected" : "No source connected"}
        </div>
      </aside>

      <main className="main">
        {page === "dashboard" && <Dashboard snapshot={snapshot} setPage={setPage} run={run} />}
        {page === "assignments" && <Assignments snapshot={snapshot} onSource={async (id) => setSourceDetail(await window.studentAssistant.getAssignmentSource(id))} />}
        {page === "sources" && <Sources snapshot={snapshot} run={run} />}
        {page === "knowledge" && <Knowledge snapshot={snapshot} />}
        {page === "notifications" && <NotificationHistory snapshot={snapshot} run={run} />}
        {page === "privacy" && <Privacy snapshot={snapshot} run={run} onPreview={async () => {
          const result = await run(() => window.studentAssistant.simulateEgress(), () => "Created a local egress-log example. No data was sent anywhere.");
          if (result) setEgressPreview(result);
        }} />}
      </main>

      {sourceDetail && <SourceModal detail={sourceDetail} onClose={() => setSourceDetail(null)} />}
      {egressPreview && <EgressModal detail={egressPreview} onClose={() => setEgressPreview(null)} />}
      {busy && <div className="busy-bar" />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function PageHeader({ eyebrow, title, text, actions }: { eyebrow: string; title: string; text: string; actions?: any }) {
  return <header className="page-header">
    <div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{text}</p></div>
    {actions && <div className="header-actions">{actions}</div>}
  </header>;
}

function Dashboard({ snapshot, setPage, run }: any) {
  const upcoming = snapshot.assignments.slice(0, 4);
  return <>
    <PageHeader eyebrow="Local-first prototype" title="Your semester at a glance" text="Everything on this screen is stored locally. The Blackboard data is synthetic for testing." actions={<>
      <button className="secondary" onClick={() => setPage("sources")}>Manage sources</button>
      <button className="primary" onClick={() => run(() => window.studentAssistant.runHelpCheck(), (r: any) => r.message)}>Run help check</button>
    </>} />

    <section className="stat-grid">
      <Stat label="Connected sources" value={snapshot.sources.filter((s: any) => s.connected).length} hint="Student-controlled" />
      <Stat label="Known courses" value={snapshot.courses.length} hint="Normalized locally" />
      <Stat label="Upcoming assignments" value={snapshot.assignments.filter((a: any) => a.dueAt).length} hint="From allowed sources" />
      <Stat label="Nudges logged" value={snapshot.notifications.length} hint="Every reason is inspectable" />
    </section>

    <section className="two-col">
      <div className="panel">
        <div className="panel-title"><h2>Upcoming work</h2><button className="link" onClick={() => setPage("assignments")}>See all</button></div>
        {upcoming.length === 0 ? <Empty title="No Blackboard data yet" text="Connect the synthetic Blackboard source and run a sync." /> : upcoming.map((a: any) => <div className="list-row" key={a.id}>
          <div><span className="course-chip">{a.courseCode}</span><strong>{a.title}</strong><small>{a.description ?? "No description"}</small></div>
          <div className="date">{fmtDate(a.dueAt)}</div>
        </div>)}
      </div>
      <div className="panel">
        <div className="panel-title"><h2>Recent announcements</h2></div>
        {snapshot.announcements.length === 0 ? <Empty title="Nothing imported" text="Announcements appear here after a Blackboard sync if permission is granted." /> : snapshot.announcements.slice(0, 4).map((a: any) => <div className="announcement" key={a.id}>
          <span className="course-chip">{a.courseCode}</span><strong>{a.title}</strong><p>{a.body}</p><small>{fmtDate(a.createdAt)}</small>
        </div>)}
      </div>
    </section>

    <section className="privacy-banner">
      <div><strong>Why does the assistant know this?</strong><p>Every imported item keeps provenance. Open an assignment and choose <em>View source</em> to inspect the original API-shaped Blackboard object.</p></div>
      <button className="secondary" onClick={() => setPage("knowledge")}>What I know</button>
    </section>
  </>;
}

function Stat({ label, value, hint }: any) {
  return <div className="stat"><span>{label}</span><strong>{value}</strong><small>{hint}</small></div>;
}

function Assignments({ snapshot, onSource }: any) {
  return <>
    <PageHeader eyebrow="Normalized data" title="Assignments" text="The UI uses one internal Assignment shape even though Blackboard represents course content, gradebook columns, and calendar items separately." />
    <div className="panel table-panel">
      {snapshot.assignments.length === 0 ? <Empty title="No assignments" text="Connect Blackboard from Sources & consent, then run a mock sync." /> : <table>
        <thead><tr><th>Course</th><th>Assignment</th><th>Due</th><th>Points</th><th>Provenance</th></tr></thead>
        <tbody>{snapshot.assignments.map((a: any) => <tr key={a.id}>
          <td><span className="course-chip">{a.courseCode}</span></td>
          <td><strong>{a.title}</strong><small>{a.description ?? "No description"}</small></td>
          <td>{fmtDate(a.dueAt)}</td>
          <td>{a.possiblePoints ?? "—"}</td>
          <td><button className="link" onClick={() => onSource(a.id)}>View source</button></td>
        </tr>)}</tbody>
      </table>}
    </div>
  </>;
}

function Sources({ snapshot, run }: any) {
  const source = snapshot.sources[0];
  const current = new Set(source.consents.filter((c: any) => c.granted).map((c: any) => c.scope));
  const [selected, setSelected] = useState<Set<ConsentScope>>(new Set(current));
  useEffect(() => setSelected(new Set(current)), [source.connected, source.consents.map((c: any) => `${c.scope}:${c.granted}`).join("|")]);

  const toggle = (scope: ConsentScope) => {
    const next = new Set(selected);
    next.has(scope) ? next.delete(scope) : next.add(scope);
    setSelected(next);
  };

  return <>
    <PageHeader eyebrow="Permissions" title="Sources & consent" text="Connections are explicit, granular, and revocable. This prototype never asks for a Blackboard password and does not contact Blackboard." />
    <div className="source-card">
      <div className="source-top">
        <div className="source-logo">B</div>
        <div><h2>Blackboard</h2><p>Synthetic REST-shaped data for prototype testing</p></div>
        <span className={source.connected ? "pill good" : "pill"}>{source.connected ? "Connected" : "Not connected"}</span>
      </div>
      <div className="consent-box">
        <h3>Allow this connector to read</h3>
        {(Object.keys(scopeLabels) as ConsentScope[]).map((scope) => <label className="check-row" key={scope}>
          <input type="checkbox" checked={selected.has(scope)} onChange={() => toggle(scope)} />
          <span><strong>{scopeLabels[scope]}</strong><small>Used only to build the local semester model.</small></span>
        </label>)}
      </div>
      <div className="source-meta">
        <span><b>Last sync</b>{fmtDate(source.lastSyncedAt)}</span>
        <span><b>Storage</b>Local SQLite only</span>
        <span><b>Authentication</b>Mocked; future OAuth broker</span>
      </div>
      <div className="button-row">
        <button className="primary" onClick={() => run(
          () => window.studentAssistant.updateConsent({ sourceId: source.id, connected: true, scopes: [...selected] }),
          () => "Blackboard permissions saved locally."
        )}>{source.connected ? "Save permissions" : "Allow & connect"}</button>
        <button className="secondary" disabled={!source.connected} onClick={() => run(() => window.studentAssistant.syncMockBlackboard(), (r: any) => `Imported synthetic Blackboard data for ${r.importedCourses} courses.`)}>Sync mock Blackboard</button>
        {source.connected && <button className="danger-ghost" onClick={() => run(() => window.studentAssistant.disconnectSource(source.id), () => "Blackboard disconnected. Existing local data is now excluded from active views.")}>Disconnect</button>}
      </div>
      <div className="delete-zone">
        <div><strong>Delete imported Blackboard data</strong><p>Removes normalized courses, assignments, announcements, and stored raw API objects from this prototype.</p></div>
        <button className="danger" onClick={() => run(() => window.studentAssistant.deleteSourceData(source.id), () => "Imported Blackboard data deleted from the local database.")}>Delete local data</button>
      </div>
    </div>
  </>;
}

function Knowledge({ snapshot }: any) {
  const perCourse = useMemo(() => snapshot.courses.map((course: any) => ({
    course,
    assignments: snapshot.assignments.filter((a: any) => a.courseId === course.id),
    announcements: snapshot.announcements.filter((a: any) => a.courseId === course.id)
  })), [snapshot]);

  return <>
    <PageHeader eyebrow="Open student model" title="What I know about your semester" text="This is a human-readable rendering of structured local data. A student should be able to inspect what the assistant believes and where it came from." />
    <div className="knowledge-grid">
      {perCourse.length === 0 ? <Empty title="The model is empty" text="No connected source has contributed course information yet." /> : perCourse.map(({ course, assignments, announcements }: any) => <div className="course-card" key={course.id}>
        <span className="course-chip">{course.courseCode}</span><h2>{course.title}</h2><p>{course.description}</p>
        <div className="knowledge-facts"><span><b>{assignments.length}</b> assignments</span><span><b>{announcements.length}</b> announcements</span></div>
        {assignments.slice(0, 3).map((a: any) => <div className="fact" key={a.id}><strong>{a.title}</strong><span>Due {fmtDate(a.dueAt)}</span><small>Source: Blackboard</small></div>)}
      </div>)}
    </div>
  </>;
}

function NotificationHistory({ snapshot, run }: any) {
  return <>
    <PageHeader eyebrow="Proactivity" title="Notification history" text={`The main Electron process checks simple rules every ${snapshot.meta.backgroundCheckSeconds} seconds in prototype mode. The real product would use a less frequent schedule and richer rules.`} actions={<>
      <button className="secondary" onClick={() => run(() => window.studentAssistant.sendTestNotification(), () => "Test notification sent.")}>Send test notification</button>
      <button className="primary" onClick={() => run(() => window.studentAssistant.runHelpCheck(), (r: any) => r.message)}>Run help check</button>
    </>} />
    <div className="panel">
      {snapshot.notifications.length === 0 ? <Empty title="No notifications yet" text="Use the test button, or import assignments and run the help check." /> : snapshot.notifications.map((n: any) => <div className="notification-row" key={n.id}>
        <div className="notification-icon">!</div>
        <div className="notification-copy"><div><span className="pill">{n.kind}</span><small>{fmtDate(n.createdAt)}</small></div><strong>{n.title}</strong><p>{n.body}</p><details><summary>Why was this sent?</summary><p>{n.reason}</p></details></div>
      </div>)}
    </div>
  </>;
}

function Privacy({ snapshot, run, onPreview }: any) {
  const update = (key: any, value: any) => run(() => window.studentAssistant.updateSetting({ key, value }), () => "Setting saved locally.");
  return <>
    <PageHeader eyebrow="Data control" title="Privacy & settings" text="The prototype treats privacy as something the student can inspect and control, not only a policy document." />
    <section className="two-col privacy-cols">
      <div className="panel">
        <h2>Background behavior</h2>
        <SettingToggle label="Native notifications" detail="Allow the app to display operating-system notifications." checked={snapshot.settings.notificationsEnabled} onChange={(v: boolean) => update("notificationsEnabled", v)} />
        <SettingToggle label="Background help checks" detail="Evaluate prototype nudge rules while the window is hidden in the system tray." checked={snapshot.settings.backgroundChecksEnabled} onChange={(v: boolean) => update("backgroundChecksEnabled", v)} />
        <SettingToggle label="Start at login" detail={snapshot.meta.packaged ? "Launch quietly when the student signs in." : "Stored now; applied automatically after the app is packaged."} checked={snapshot.settings.startAtLogin} onChange={(v: boolean) => update("startAtLogin", v)} />
        <div className="quiet-grid"><label>Quiet hours start<input type="time" value={snapshot.settings.quietStart} onChange={(e) => update("quietStart", e.target.value)} /></label><label>Quiet hours end<input type="time" value={snapshot.settings.quietEnd} onChange={(e) => update("quietEnd", e.target.value)} /></label></div>
      </div>
      <div className="panel">
        <h2>Local storage</h2>
        <p className="muted">The application database lives in Electron's per-user application-data directory.</p>
        <code className="path-code">{snapshot.meta.databasePath}</code>
        <div className="info-list"><span><b>Student files uploaded?</b>No</span><span><b>Real Blackboard contacted?</b>No</span><span><b>Real LLM contacted?</b>No</span></div>
      </div>
    </section>

    <div className="panel egress-panel">
      <div className="panel-title"><div><h2>Egress filter demonstration</h2><p className="muted">Preview the minimum fields that a future model request might be allowed to send. This button does not call an API.</p></div><button className="primary" onClick={onPreview}>Simulate AI request</button></div>
      {snapshot.egressLog.length === 0 ? <Empty title="No egress entries" text="Nothing has been simulated or sent from this prototype." /> : <table><thead><tr><th>Purpose</th><th>Allowed fields</th><th>Model</th><th>Time</th></tr></thead><tbody>{snapshot.egressLog.map((e: any) => <tr key={e.id}><td>{e.purpose}</td><td>{e.fields.join(", ")}</td><td><span className="pill good">{e.model}</span></td><td>{fmtDate(e.createdAt)}</td></tr>)}</tbody></table>}
    </div>
  </>;
}

function SettingToggle({ label, detail, checked, onChange }: any) {
  return <label className="setting-row"><span><strong>{label}</strong><small>{detail}</small></span><input className="toggle" type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /></label>;
}

function Empty({ title, text }: any) {
  return <div className="empty"><strong>{title}</strong><p>{text}</p></div>;
}

function SourceModal({ detail, onClose }: { detail: SourceDetail; onClose: () => void }) {
  return <div className="modal-backdrop" onMouseDown={onClose}><div className="modal" onMouseDown={(e) => e.stopPropagation()}>
    <div className="modal-header"><div><div className="eyebrow">Provenance</div><h2>{detail.assignment.title}</h2></div><button className="close" onClick={onClose}>×</button></div>
    <div className="provenance-grid"><span><b>Source</b>{detail.source.displayName}</span><span><b>Course</b>{detail.assignment.courseCode}</span><span><b>Blackboard object ID</b>{detail.assignment.externalId}</span><span><b>Retrieved</b>{fmtDate(detail.retrievedAt)}</span><span className="wide"><b>REST endpoint represented by this fixture</b><code>{detail.endpoint}</code></span></div>
    <h3>Original API-shaped object</h3><pre>{JSON.stringify(detail.rawJson, null, 2)}</pre>
    <p className="modal-note">The normalizer turned this source-specific Blackboard object into the common Assignment record used by the rest of the app.</p>
  </div></div>;
}

function EgressModal({ detail, onClose }: { detail: EgressSimulationResult; onClose: () => void }) {
  return <div className="modal-backdrop" onMouseDown={onClose}><div className="modal" onMouseDown={(e) => e.stopPropagation()}>
    <div className="modal-header"><div><div className="eyebrow">Egress preview</div><h2>What would leave the laptop?</h2></div><button className="close" onClick={onClose}>×</button></div>
    <p>{detail.message}</p><h3>Allow-listed fields</h3><div className="tag-row">{detail.fields.map((f) => <span className="pill good" key={f}>{f}</span>)}</div><h3>Payload preview</h3><pre>{JSON.stringify(detail.payload, null, 2)}</pre>
  </div></div>;
}

export default App;
