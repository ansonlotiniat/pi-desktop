export {};

declare global {
  interface PiDesktopFeatureContext {
    apiVersion: 1;
    feature: {
      id: string;
      name: string;
      source: "global" | "project";
      version?: string;
      publisher?: string;
    };
    workspace: { cwd: string };
    pi: {
      kernel: Record<string, unknown>;
      state: Record<string, unknown>;
    };
    theme: { colorScheme: "dark" | "light" };
  }

  interface PiDesktopFeatureApi {
    readonly apiVersion: 1;
    getContext(): Promise<PiDesktopFeatureContext>;
    openExternal(url: string): Promise<void>;
    navigate(target: "chat" | "plugins"): Promise<void>;
    service: {
      request<T = unknown>(method: string, params?: unknown): Promise<T>;
      onEvent(listener: (event: unknown) => void): () => void;
    };
    storage: {
      get<T = unknown>(key: string): Promise<T | null>;
      set(key: string, value: unknown): Promise<void>;
      delete(key: string): Promise<boolean>;
    };
    pi: {
      request<T = unknown>(command: Record<string, unknown>): Promise<T>;
      prompt<T = unknown>(message: string): Promise<T>;
      getState<T = unknown>(): Promise<T>;
      onEvent(listener: (event: unknown) => void): () => void;
    };
    on(event: "host.context" | "service.event" | "pi.event", listener: (data: unknown) => void): () => void;
  }

  interface Window {
    readonly piDesktop: PiDesktopFeatureApi;
  }
}
