import { contextBridge, ipcRenderer } from "electron";
import { ConsentUpdate, SettingUpdate } from "../shared/types";

contextBridge.exposeInMainWorld("studentAssistant", {
  getSnapshot: () => ipcRenderer.invoke("app:getSnapshot"),
  updateConsent: (update: ConsentUpdate) => ipcRenderer.invoke("source:updateConsent", update),
  disconnectSource: (sourceId: string) => ipcRenderer.invoke("source:disconnect", sourceId),
  deleteSourceData: (sourceId: string) => ipcRenderer.invoke("source:deleteData", sourceId),
  syncMockBlackboard: () => ipcRenderer.invoke("blackboard:syncMock"),
  getAssignmentSource: (assignmentId: string) => ipcRenderer.invoke("assignment:getSource", assignmentId),
  runHelpCheck: () => ipcRenderer.invoke("help:runCheck"),
  sendTestNotification: () => ipcRenderer.invoke("help:testNotification"),
  simulateEgress: () => ipcRenderer.invoke("privacy:simulateEgress"),
  updateSetting: (update: SettingUpdate) => ipcRenderer.invoke("settings:update", update),
  showWindow: () => ipcRenderer.invoke("window:show"),
  hideWindow: () => ipcRenderer.invoke("window:hide"),
  onDataChanged: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("app:dataChanged", listener);
    return () => ipcRenderer.removeListener("app:dataChanged", listener);
  }
});
