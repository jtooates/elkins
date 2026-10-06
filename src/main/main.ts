import path from "path";
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  Tray
} from "electron";
import { AppDatabase } from "./database";
import { MockBlackboardConnector } from "./blackboard";
import { HelpEngine } from "./helpEngine";
import { ConsentUpdate, SettingUpdate } from "../shared/types";

const BACKGROUND_CHECK_SECONDS = 60;

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let database: AppDatabase;
let blackboard: MockBlackboardConnector;
let helpEngine: HelpEngine;
let backgroundTimer: NodeJS.Timeout | null = null;

// Prevent multiple copies of the app from running.
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
}

// If the user clicks the app again, show the existing window.
app.on("second-instance", () => {
  showWindow();
});

function resourcePath(...parts: string[]) {
  return app.isPackaged
    ? path.join(process.resourcesPath, "resources", ...parts)
    : path.join(__dirname, "../../../resources", ...parts);
}

function notifyRenderer() {
  mainWindow?.webContents.send("app:dataChanged");
}

function showWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 920,
    minHeight: 620,
    show: false,
    backgroundColor: "#f4f6f8",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    mainWindow.loadURL(devUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../../renderer/index.html"));
  }

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
}

function createTray() {
  if (tray) return;

  let icon = nativeImage.createFromPath(resourcePath("tray.png"));
  if (icon.isEmpty()) icon = nativeImage.createEmpty();
  tray = new Tray(icon.resize({ width: 18, height: 18 }));
  tray.setToolTip("Student Assistant Prototype");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open Student Assistant", click: showWindow },
    { type: "separator" },
    {
      label: "Run help check now",
      click: () => {
        helpEngine.run("manual");
        notifyRenderer();
      }
    },
    {
      label: "Send test notification",
      click: () => {
        helpEngine.sendTestNotification();
        notifyRenderer();
      }
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]));
  tray.on("double-click", showWindow);
}

function startBackgroundChecks() {
  if (backgroundTimer) clearInterval(backgroundTimer);
  backgroundTimer = setInterval(() => {
    try {
      const result = helpEngine.run("timer");
      if (result.created) notifyRenderer();
    } catch (error) {
      console.error("Background help check failed", error);
    }
  }, BACKGROUND_CHECK_SECONDS * 1000);
}

function registerIpc() {
  ipcMain.handle("app:getSnapshot", () => database.getSnapshot({
    databasePath: path.join(app.getPath("userData"), "student-assistant.db"),
    prototypeMode: true,
    backgroundCheckSeconds: BACKGROUND_CHECK_SECONDS,
    packaged: app.isPackaged
  }));

  ipcMain.handle("source:updateConsent", (_event, update: ConsentUpdate) => {
    database.updateConsent(update);
    notifyRenderer();
    return database.getSource(update.sourceId);
  });

  ipcMain.handle("source:disconnect", (_event, sourceId: string) => {
    database.disconnectSource(sourceId);
    notifyRenderer();
  });

  ipcMain.handle("source:deleteData", (_event, sourceId: string) => {
    database.deleteSourceData(sourceId);
    notifyRenderer();
  });

  ipcMain.handle("blackboard:syncMock", () => {
    const result = blackboard.sync();
    notifyRenderer();
    return result;
  });

  ipcMain.handle("assignment:getSource", (_event, assignmentId: string) => database.getAssignmentSource(assignmentId));

  ipcMain.handle("help:runCheck", () => {
    const result = helpEngine.run("manual");
    notifyRenderer();
    return result;
  });

  ipcMain.handle("help:testNotification", () => {
    const result = helpEngine.sendTestNotification();
    notifyRenderer();
    return result;
  });

  ipcMain.handle("privacy:simulateEgress", () => {
    const next = database.getActiveAssignments().find((a) => a.dueAt);
    if (!next) throw new Error("Import Blackboard data first so there is an assignment to demonstrate.");

    // This is intentionally a minimal, allow-listed payload. No raw Blackboard JSON,
    // student name, email, ID, files, or entire course is included.
    const payload = {
      task: "phrase_deadline_nudge",
      assignment: {
        course: next.courseCode,
        title: next.title,
        dueAt: next.dueAt
      },
      instruction: "Write one short, neutral nudge with a concrete next action."
    };
    const fields = ["task", "assignment.course", "assignment.title", "assignment.dueAt", "instruction"];
    database.insertEgressLog({
      purpose: "prototype_nudge_wording",
      fields,
      payloadPreview: payload,
      model: "SIMULATION_ONLY_NO_API_CALL",
      createdAt: new Date().toISOString()
    });
    notifyRenderer();
    return {
      payload,
      fields,
      message: "No network call was made. This only demonstrates what an egress filter could allow through."
    };
  });

  ipcMain.handle("settings:update", (_event, update: SettingUpdate) => {
    database.setSetting(update.key, update.value);
    if (update.key === "startAtLogin" && app.isPackaged) {
      app.setLoginItemSettings({ openAtLogin: Boolean(update.value) });
    }
    notifyRenderer();
    return database.getSettings();
  });

  ipcMain.handle("window:show", showWindow);
  ipcMain.handle("window:hide", () => mainWindow?.hide());
}

app.whenReady().then(() => {
  if (process.platform === "win32") {
    app.setAppUserModelId("edu.umbc.elkins.studentassistant");
  }

  database = new AppDatabase(path.join(app.getPath("userData"), "student-assistant.db"));
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: database.getSettings().startAtLogin });
  }
  blackboard = new MockBlackboardConnector(database, resourcePath("mock-blackboard", "mock-api-dump.json"));
  helpEngine = new HelpEngine(database, notifyRenderer, showWindow);

  registerIpc();
  createWindow();
  createTray();
  startBackgroundChecks();

  app.on("activate", () => {
    if (!mainWindow) createWindow();
    showWindow();
  });
});

app.on("before-quit", () => {
  isQuitting = true;
  if (backgroundTimer) clearInterval(backgroundTimer);
  database?.close();
});

app.on("window-all-closed", () => {
  // Intentionally do nothing. The tray process keeps the app alive on all platforms.
});
