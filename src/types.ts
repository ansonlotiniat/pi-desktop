export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

export interface KernelInfo {
  status: ConnectionStatus;
  executable?: string;
  version?: string;
  cwd?: string;
  error?: string;
}

export interface ProviderModel {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
  contextWindow?: number;
  maxTokens?: number;
}

export interface ProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  api: "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";
  authHeader: boolean;
  models: ProviderModel[];
}

export interface AppSettings {
  kernelPath: string;
  defaultCwd: string;
  providers: ProviderConfig[];
}

export interface PiModel {
  id: string;
  name?: string;
  provider: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  [key: string]: unknown;
}

export interface PiSlashCommand {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
  sourceInfo?: {
    path?: string;
    source?: string;
    scope?: "user" | "project" | "temporary";
    origin?: "package" | "top-level";
    baseDir?: string;
    [key: string]: unknown;
  };
}

export interface SessionSummary {
  id?: string;
  sessionId?: string;
  sessionName?: string;
  cwd?: string;
  updatedAt?: string | number;
  messageCount?: number;
  [key: string]: unknown;
}

export interface PiSessionInfo {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  parentSessionPath?: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
}

export interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  arguments?: unknown;
  [key: string]: unknown;
}

export interface AgentMessage {
  role?: "user" | "assistant" | "toolResult" | "system" | string;
  content?: string | ContentBlock[];
  timestamp?: number;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  stopReason?: string;
  errorMessage?: string;
  [key: string]: unknown;
}

export interface RpcEnvelope {
  id?: string;
  type: string;
  command?: string;
  success?: boolean;
  data?: unknown;
  error?: string | { message?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface PiState {
  model?: PiModel | null;
  thinkingLevel?: string;
  isStreaming?: boolean;
  isCompacting?: boolean;
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  cwd?: string;
  messageCount?: number;
  pendingMessageCount?: number;
  [key: string]: unknown;
}

export type ToolAccessMode = "pi-default" | "ask";

export interface ToolAccessState {
  mode: ToolAccessMode;
  modes: ToolAccessMode[];
  mechanism: "extension-tool-call";
}

export interface ToolPermissionRequest {
  requestId: string;
  toolCallId: string;
  toolName: string;
  cwd: string;
  summary: string;
  input: Record<string, unknown>;
}

export type NativeTerminalPhase =
  | "inactive"
  | "starting"
  | "running"
  | "closing"
  | "restarting"
  | "error";

export interface NativeTerminalStatus {
  phase: NativeTerminalPhase;
  generation: number;
  error?: string;
}

export interface NativeTerminalOutput {
  generation: number;
  data: number[];
}
