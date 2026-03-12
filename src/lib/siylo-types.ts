export type SiyloConfig = {
  botToken: string;
  authorizedUsers: string[];
  dashboardPort: number;
  autoConnect: boolean;
  commandPrefix: string;
};

export type SiyloSession = {
  id: string;
  shell: string;
  status: "idle" | "active";
  lastCommand: string;
  createdAt: string;
};

export type SiyloLogEntry = {
  id: string;
  level: "info" | "warn" | "error";
  message: string;
  timestamp: string;
};

export type SiyloState = {
  isConnected: boolean;
  config: SiyloConfig;
  sessions: SiyloSession[];
  logs: SiyloLogEntry[];
};

export type SiyloBridge = {
  getState: () => Promise<SiyloState>;
  start: () => Promise<SiyloState>;
  stop: () => Promise<SiyloState>;
  updateConfig: (partialConfig: Partial<SiyloConfig>) => Promise<SiyloState>;
  simulateSession: (commandText: string) => Promise<SiyloState>;
  openDashboard: () => Promise<void>;
  onStateChanged: (listener: (state: SiyloState) => void) => () => void;
};
