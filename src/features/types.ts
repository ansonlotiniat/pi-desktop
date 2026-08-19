import type { KernelInfo, PiState, RpcEnvelope } from "../types";

export const FEATURE_API_VERSION = 1 as const;
export const FEATURE_MESSAGE_SOURCE = "pi-desktop-feature" as const;
export const HOST_MESSAGE_SOURCE = "pi-desktop-host" as const;

export type FeatureSource = "global" | "project";

export interface FeatureDescriptor {
  apiVersion: number;
  id: string;
  name: string;
  version?: string;
  publisher?: string;
  description?: string;
  icon?: string;
  order: number;
  source: FeatureSource;
  rootPath: string;
  uiEntry: string;
  hasService: boolean;
}

export interface FeatureCatalogError {
  path: string;
  message: string;
}

export interface StarterFeatureDescriptor {
  id: string;
  name: string;
  description: string;
  icon: string;
  version: string;
  publisher: string;
  installed: boolean;
  updateAvailable: boolean;
}

export interface FeatureCatalog {
  features: FeatureDescriptor[];
  starters: StarterFeatureDescriptor[];
  errors: FeatureCatalogError[];
  globalDirectory: string;
  projectDirectory?: string;
}

export interface AuthoringSkillStatus {
  id: string;
  name: string;
  version: string;
  directory: string;
  installed: boolean;
  managed: boolean;
  updateAvailable: boolean;
}

export interface FeatureServiceEvent {
  featureId: string;
  workspace: string;
  event: unknown;
}

export interface FeatureHostContext {
  apiVersion: typeof FEATURE_API_VERSION;
  feature: {
    id: string;
    name: string;
    source: FeatureSource;
    version?: string;
    publisher?: string;
  };
  workspace: {
    cwd: string;
  };
  pi: {
    kernel: KernelInfo;
    state: PiState;
  };
  theme: {
    colorScheme: "dark" | "light";
  };
}

export interface FeatureRequestMessage {
  source: typeof FEATURE_MESSAGE_SOURCE;
  version: typeof FEATURE_API_VERSION;
  featureId: string;
  id: string;
  method: string;
  params?: unknown;
}

export interface FeatureReadyMessage {
  source: typeof FEATURE_MESSAGE_SOURCE;
  version: typeof FEATURE_API_VERSION;
  featureId: string;
  type: "ready";
}

export type FeatureIncomingMessage = FeatureRequestMessage | FeatureReadyMessage;

export interface HostResponseMessage {
  source: typeof HOST_MESSAGE_SOURCE;
  version: typeof FEATURE_API_VERSION;
  featureId: string;
  type: "response";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface HostEventMessage {
  source: typeof HOST_MESSAGE_SOURCE;
  version: typeof FEATURE_API_VERSION;
  featureId: string;
  type: "event";
  event: "host.context" | "service.event" | "pi.event";
  data: FeatureHostContext | RpcEnvelope | unknown;
}
