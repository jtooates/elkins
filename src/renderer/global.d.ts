import type {
  AppSnapshot,
  ConsentUpdate,
  EgressSimulationResult,
  HelpCheckResult,
  SettingUpdate,
  SourceDetail
} from "../shared/types";

declare global {
  interface Window {
    studentAssistant: {
      getSnapshot(): Promise<AppSnapshot>;
      updateConsent(update: ConsentUpdate): Promise<unknown>;
      disconnectSource(sourceId: string): Promise<void>;
      deleteSourceData(sourceId: string): Promise<void>;
      syncMockBlackboard(): Promise<{ importedCourses: number; syncedAt: string }>;
      getAssignmentSource(assignmentId: string): Promise<SourceDetail>;
      runHelpCheck(): Promise<HelpCheckResult>;
      sendTestNotification(): Promise<unknown>;
      simulateEgress(): Promise<EgressSimulationResult>;
      updateSetting(update: SettingUpdate): Promise<unknown>;
      showWindow(): Promise<void>;
      hideWindow(): Promise<void>;
      onDataChanged(callback: () => void): () => void;
    };
  }
}

export {};
