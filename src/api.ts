import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AuthoringSkillStatus,
  FeatureCatalog,
  FeatureServiceEvent,
} from "./features/types";
import type {
  AppSettings,
  KernelInfo,
  NativeTerminalOutput,
  NativeTerminalStatus,
  RpcEnvelope,
} from "./types";

export const desktopApi = {
  getSettings: () => invoke<AppSettings>("get_settings"),
  saveSettings: (settings: AppSettings) => invoke<AppSettings>("save_settings", { settings }),
  startKernel: (executable?: string, cwd?: string) =>
    invoke<KernelInfo>("start_kernel", { executable: executable || null, cwd: cwd || null }),
  stopKernel: () => invoke<void>("stop_kernel"),
  kernelStatus: () => invoke<KernelInfo>("kernel_status"),
  send: <T = unknown>(command: Record<string, unknown>) => invoke<T>("bridge_send", { command }),
  startNativeTerminal: (
    initialInput: string,
    columns: number,
    rows: number,
  ) =>
    invoke<NativeTerminalStatus>("native_terminal_start", {
      initialInput,
      columns,
      rows,
    }),
  submitNativeTerminal: (initialInput: string) =>
    invoke<NativeTerminalStatus>("native_terminal_submit", { initialInput }),
  writeNativeTerminal: (data: string) =>
    invoke<void>("native_terminal_write", { data }),
  resizeNativeTerminal: (columns: number, rows: number) =>
    invoke<void>("native_terminal_resize", { columns, rows }),
  stopNativeTerminal: () =>
    invoke<NativeTerminalStatus>("native_terminal_stop"),
  nativeTerminalStatus: () =>
    invoke<NativeTerminalStatus>("native_terminal_status"),
  listFeatures: (projectRoot?: string) =>
    invoke<FeatureCatalog>("list_features", { projectRoot: projectRoot || null }),
  installStarterFeature: (starterId: string, projectRoot?: string) =>
    invoke<FeatureCatalog>("install_starter_feature", {
      starterId,
      projectRoot: projectRoot || null,
    }),
  authoringSkillStatus: () =>
    invoke<AuthoringSkillStatus>("authoring_skill_status"),
  installAuthoringSkill: () =>
    invoke<AuthoringSkillStatus>("install_authoring_skill"),
  removeAuthoringSkill: () =>
    invoke<AuthoringSkillStatus>("remove_authoring_skill"),
  loadFeatureUi: (featureId: string, projectRoot?: string) =>
    invoke<string>("load_feature_ui", { featureId, projectRoot: projectRoot || null }),
  requestFeatureService: <T = unknown>(
    featureId: string,
    method: string,
    params: unknown,
    projectRoot?: string,
  ) =>
    invoke<T>("feature_service_request", {
      featureId,
      method,
      params: params ?? null,
      projectRoot: projectRoot || null,
    }),
  getFeatureStorage: <T = unknown>(featureId: string, key: string) =>
    invoke<T | null>("feature_storage_get", { featureId, key }),
  setFeatureStorage: (featureId: string, key: string, value: unknown) =>
    invoke<void>("feature_storage_set", { featureId, key, value }),
  deleteFeatureStorage: (featureId: string, key: string) =>
    invoke<boolean>("feature_storage_delete", { featureId, key }),
  stopFeatureService: (featureId: string, projectRoot?: string) =>
    invoke<void>("stop_feature_service", { featureId, projectRoot: projectRoot || null }),
  onPiEvent: (handler: (event: RpcEnvelope) => void): Promise<UnlistenFn> =>
    listen<RpcEnvelope>("pi-bridge-event", (event) => handler(event.payload)),
  onKernelStatus: (handler: (status: KernelInfo) => void): Promise<UnlistenFn> =>
    listen<KernelInfo>("pi-kernel-status", (event) => handler(event.payload)),
  onNativeTerminalOutput: (
    handler: (output: NativeTerminalOutput) => void,
  ): Promise<UnlistenFn> =>
    listen<NativeTerminalOutput>("pi-native-terminal-output", (event) =>
      handler(event.payload),
    ),
  onNativeTerminalStatus: (
    handler: (status: NativeTerminalStatus) => void,
  ): Promise<UnlistenFn> =>
    listen<NativeTerminalStatus>("pi-native-terminal-status", (event) =>
      handler(event.payload),
    ),
  onFeatureServiceEvent: (
    handler: (event: FeatureServiceEvent) => void,
  ): Promise<UnlistenFn> =>
    listen<FeatureServiceEvent>("pi-feature-service-event", (event) =>
      handler(event.payload),
    ),
};
