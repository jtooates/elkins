import { useEffect, useState } from "react";
import type { FieldConflict, ContentClaim } from "../../shared/types";

type Run = (fn: () => Promise<unknown>, success?: () => string) => Promise<unknown>;

function formatClaim(claim: ContentClaim, field: string) {
  if (field !== "due_at" && field !== "date") return claim.value;
  if (field === "date" && /^\d{4}-\d{2}-\d{2}$/.test(claim.value)) {
    return claim.value;
  }
  const date = new Date(claim.value);
  if (Number.isNaN(date.getTime())) return claim.value;
  return date.toLocaleString("en-US", {
    timeZone: "America/New_York", dateStyle: "medium",
    ...(field === "due_at" ? { timeStyle: "short" as const } : {})
  }) + " Eastern";
}

function easternDeadline(date: string) {
  const time = new Date(`${date}T12:00:00Z`);
  const text = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", timeZoneName: "shortOffset"
  }).formatToParts(time).find(p => p.type === "timeZoneName")?.value ?? "GMT-5";
  const h = Number(text.replace("GMT", "")) || -5;
  return `${date}T23:59:00${h < 0 ? "-" : "+"}${String(Math.abs(h)).padStart(2, "0")}:00`;
}

function ConflictCard({ conflict, run }: { conflict: FieldConflict; run: Run }) {
  const [selection, setSelection] = useState("");
  const [date, setDate] = useState("");
  const [other, setOther] = useState("");
  useEffect(() => {
    setSelection(conflict.choice?.manualValue ? "manual" :
      conflict.choice?.selectedClaimId ?? "");
    setDate(conflict.choice?.manualValue?.slice(0, 10) ?? "");
    setOther(conflict.choice?.manualValue ?? "");
  }, [conflict.itemId, conflict.field, conflict.choice?.updatedAt]);

  const save = () => {
    if (selection === "manual") {
      const value = conflict.field === "due_at" ?
        (date ? easternDeadline(date) : "") : other.trim();
      if (!value) return;
      return run(() => window.studentAssistant.resolveConflict({
        itemId: conflict.itemId, field: conflict.field, manualValue: value
      }), () => "Personal correction saved. Original evidence was preserved.");
    }
    if (!selection) return;
    return run(() => window.studentAssistant.resolveConflict({
      itemId: conflict.itemId, field: conflict.field, selectedClaimId: selection
    }), () => "Source choice saved locally.");
  };

  return <section className="panel conflict-card">
    <div className="panel-title">
      <div>
        <span className="course-chip">{conflict.courseCode}</span>
        <h2>{conflict.itemTitle} — {conflict.field.replaceAll("_", " ")}</h2>
      </div>
      <span className={conflict.status === "resolved" ? "pill good" : "pill warning"}>
        {conflict.status === "resolved" ? "Student choice saved" :
          conflict.status === "changed" ? "Source changed — review again" : "Review required"}
      </span>
    </div>
    <p className="muted">Multiple source statements disagree. Choose which claim to trust, or record a personal correction.</p>
    <div className="claim-options">
      {conflict.claims.map(claim => <label className="claim-choice" key={claim.id}>
        <input type="radio" name={`${conflict.itemId}:${conflict.field}`}
          checked={selection === claim.id} onChange={() => setSelection(claim.id)} />
        <span>
          <strong>{formatClaim(claim, conflict.field)}</strong>
          <small>{claim.sourceLabel} · {claim.locator}</small>
          <small className="claim-evidence">{claim.evidence}</small>
          {claim.sourceUrl && <small className="claim-url">{claim.sourceUrl}</small>}
        </span>
      </label>)}
      <label className="claim-choice">
        <input type="radio" name={`${conflict.itemId}:${conflict.field}`}
          checked={selection === "manual"} onChange={() => setSelection("manual")} />
        <span><strong>Use my own correction</strong><small>Only changes this student's local view</small></span>
      </label>
      {selection === "manual" && <div className="manual-correction">
        {conflict.field === "due_at" ? <>
          <label>Correct due date (11:59 PM Eastern for this course)</label>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} />
        </> : <>
          <label>Correct value</label>
          <input value={other} onChange={e => setOther(e.target.value)} />
        </>}
      </div>}
    </div>
    <div className="button-row">
      <button className="primary" disabled={!selection ||
        (selection === "manual" && !(conflict.field === "due_at" ? date : other.trim()))}
        onClick={save}>Save decision</button>
      {conflict.choice && <button className="secondary" onClick={() =>
        run(() => window.studentAssistant.resolveConflict({
          itemId: conflict.itemId, field: conflict.field
        }), () => "Choice cleared; conflicting dates again require review.")}>Reset decision</button>}
    </div>
    {conflict.status === "resolved" && conflict.effectiveValue &&
      <p className="resolution-note">Assistant currently uses: {formatClaim({
        ...conflict.claims[0], value: conflict.effectiveValue
      }, conflict.field)}</p>}
  </section>;
}

export default function ConflictReview({ conflicts, run }:
  { conflicts: FieldConflict[]; run: Run }) {
  const pending = conflicts.filter(c => c.status !== "resolved").length;
  return <>
    <header className="page-header"><div>
      <div className="eyebrow">Source verification</div><h1>Conflicts & corrections</h1>
      <p>Conflicts are saved with their original evidence. The student can decide which date the assistant should use.</p>
    </div></header>
    <section className="stat-grid">
      <div className="stat"><span>Conflicting fields</span><strong>{conflicts.length}</strong><small>Across connected sources</small></div>
      <div className="stat"><span>Need review</span><strong>{pending}</strong><small>Uncertain values are not used for reminders</small></div>
    </section>
    {conflicts.length === 0 ? <div className="panel"><h2>No conflicts visible</h2>
      <p>Connect the public course website, grant courses and assignments consent, then import the fixture or live website.</p>
    </div> : conflicts.map(conflict => <ConflictCard key={`${conflict.itemId}:${conflict.field}`}
      conflict={conflict} run={run} />)}
  </>;
}
