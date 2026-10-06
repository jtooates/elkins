# Student Assistant Prototype

A local-first Electron + React + TypeScript + SQLite prototype for testing the architecture discussed in the Elkins student-support project.

## What this prototype demonstrates

- **Desktop app, not a website.** React is only the UI renderer inside Electron.
- **System tray behavior.** Closing the window hides it; the Electron main process remains alive.
- **Native notifications.** Use the test button or the simple background help rule.
- **Background checks.** In prototype mode the main process evaluates the help rule every 60 seconds.
- **Synthetic Blackboard connector.** No UMBC or Blackboard account is contacted.
- **API-shaped Blackboard fixtures.** The mock dump represents memberships, courses, content, gradebook columns, announcements, and calendar items.
- **Normalization.** Blackboard-specific records become common `Course`, `Assignment`, and `Announcement` records in SQLite.
- **Raw + normalized storage.** Raw source records are retained locally for provenance/debugging; the UI uses normalized tables.
- **Sources & consent.** The student explicitly chooses what a connector may read and can revoke it later.
- **Disconnect vs. delete.** Disconnecting excludes a source from active views; deletion removes its imported local data.
- **View Source.** Every assignment can show the original Blackboard-shaped object and represented REST endpoint.
- **What I Know.** A simple inspectable view of the current local semester model.
- **Privacy / egress demo.** A simulated egress filter logs the exact allow-listed fields that *would* be sent to a model. No API call is made.
- **Start-at-login setting.** Stored in development; applied with Electron's login item setting after packaging.

## Prerequisites

Install Node.js 22 or newer.

## Run from source

```bash
npm install
npm start
```

`npm install` is only a developer workflow. A normal student would eventually receive an installer built from Electron.

If `better-sqlite3` reports a native-module / `NODE_MODULE_VERSION` mismatch on Windows:

```powershell
npm run rebuild
npm start
```

## First test walkthrough

1. Open **Sources & consent**.
2. Leave all four permissions selected and click **Allow & connect**.
3. Click **Sync mock Blackboard**.
4. Open **Assignments** and verify the imported courses and deadlines.
5. Click **View source** beside an assignment to see provenance and the original API-shaped JSON object.
6. Open **What I know** to inspect the normalized local model.
7. Open **Notification history** and click **Send test notification**.
8. Close the window with the X. The application should remain in the system tray.
9. Use the tray menu to send another notification or reopen the app.
10. Click **Run help check**. Because the synthetic dataset includes assignments due shortly after October 5, 2026, the deadline-risk rule should create a nudge when tested around that date.
11. Open **Privacy & settings** and click **Simulate AI request**. Inspect the payload and egress log; no network request is performed.
12. Return to **Sources & consent**, disconnect Blackboard, and verify its data disappears from active views. Reconnect to restore visibility, or use **Delete local data** to remove imported records.

## Important code locations

```text
src/main/main.ts            Electron process, system tray, IPC, background timer
src/main/database.ts        SQLite schema and queries
src/main/blackboard.ts      Mock Blackboard connector + normalization
src/main/helpEngine.ts      Small deterministic prototype nudge rule
src/main/preload.ts         Narrow renderer-to-main API
src/renderer/App.tsx        React prototype screens
src/renderer/styles.css     UI styling
src/shared/types.ts         Shared normalized representation
resources/mock-blackboard/
  mock-api-dump.json        Fully populated synthetic Blackboard REST-shaped fixture
```

## Normalization idea

The mock data intentionally resembles several distinct Blackboard concepts:

```text
Course object
Content object
Gradebook column
Calendar item
Announcement
        |
        v
Blackboard connector / normalizer
        |
        v
Course | Assignment | Announcement
        |
        v
SQLite + the rest of the application
```

The rest of the app therefore does not need to understand Blackboard-specific response shapes. A future Blackboard REST connector, Canvas connector, ICS importer, or emergency scraper can normalize into the same internal representation.

## Prototype nudge rule

The help engine is intentionally deterministic. It does **not** ask an LLM whether it should interrupt the student.

Current rule:

1. Source must still be connected.
2. Notifications must be enabled.
3. For automatic checks, background checks must be enabled and it must be outside quiet hours.
4. Find an assignment due in the next 7 days.
5. Do not repeat a deadline-risk nudge for the same assignment within 12 hours.
6. Send a specific notification naming the course and assignment and suggesting a concrete next step.

Later this is where you can add subtask slippage, collision detection, changed Blackboard announcements, folder activity, message budgets, and social-science-based intervention rules.

## Packaging for a student

On Windows, after the prototype is stable:

```powershell
npm run dist:win
```

Electron Builder will create an NSIS installer under `release/`. Students would run the installer; they would **not** install Node, run `npm install`, or use VS Code.

Code signing and auto-update are not configured in this prototype because they require real signing/publishing infrastructure.

## About the Blackboard fixture

`mock-api-dump.json` is **synthetic**. It does not claim to be an export from UMBC. It is modeled after documented Blackboard Learn REST patterns: `results` collections, course objects, course contents, gradebook columns with `grading.due`, announcements, and GradebookColumn calendar items.

When real Blackboard access becomes available, replace the fixture-reading code inside `MockBlackboardConnector` with HTTP calls from the real connector. Keep the normalized database interface unchanged.
