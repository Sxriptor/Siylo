export type SiyloConfig = {
  botToken: string;
  openAIApiKeyConfigured: boolean;
  authorizedUsers: string[];
  dashboardPort: number;
  voiceServerPort: number;
  remoteAccessEnabled: boolean;
  remoteAccessPort: number;
  remoteAccessUsername: string;
  remoteAccessPasswordConfigured: boolean;
  autoConnect: boolean;
  commandPrefix: string;
};

export type SiyloConfigUpdate = Partial<SiyloConfig> & {
  openAIApiKey?: string;
  clearOpenAIApiKey?: boolean;
  remoteAccessPassword?: string;
};

export type SiyloSession = {
  id: string;
  shell: string;
  status: "idle" | "active";
  lastCommand: string;
  createdAt: string;
  pid?: number;
  windowTitle?: string;
};

export type SiyloLogEntry = {
  id: string;
  level: "info" | "warn" | "error";
  message: string;
  timestamp: string;
};

export type SiyloDiscordState = {
  status: "stopped" | "connecting" | "connected" | "error";
  botTag: string;
  lastError: string;
};

export type SiyloVoiceState = {
  status: "stopped" | "starting" | "listening" | "error";
  port: number;
  url: string;
  provider: string;
  lastError: string;
};

export type SiyloRemoteAccessState = {
  status: "stopped" | "starting" | "listening" | "error";
  port: number;
  url: string;
  localUrls: string[];
  username: string;
  authConfigured: boolean;
  lastError: string;
};

export type SiyloUpdateState = {
  status: "idle" | "checking" | "available" | "downloading" | "downloaded" | "error" | "disabled";
  currentVersion: string;
  availableVersion: string;
  progressPercent: number;
  transferredBytes: number;
  totalBytes: number;
  bytesPerSecond: number;
  errorMessage: string;
};

export type SiyloState = {
  isConnected: boolean;
  discord: SiyloDiscordState;
  voice: SiyloVoiceState;
  remoteAccess: SiyloRemoteAccessState;
  update: SiyloUpdateState;
  config: SiyloConfig;
  sessions: SiyloSession[];
  logs: SiyloLogEntry[];
};

export type SiyloBridge = {
  getState: () => Promise<SiyloState>;
  start: () => Promise<SiyloState>;
  stop: () => Promise<SiyloState>;
  checkForUpdates: () => Promise<SiyloState>;
  installUpdate: () => Promise<SiyloState>;
  updateConfig: (partialConfig: SiyloConfigUpdate) => Promise<SiyloState>;
  simulateSession: (commandText: string) => Promise<SiyloState>;
  openDashboard: () => Promise<void>;
  onStateChanged: (listener: (state: SiyloState) => void) => () => void;
};
