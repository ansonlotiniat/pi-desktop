function installFeatureBridgeRuntime(featureId: string) {
  const FEATURE_SOURCE = "pi-desktop-feature";
  const HOST_SOURCE = "pi-desktop-host";
  const API_VERSION = 1;
  let sequence = 0;
  const pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timeout: number;
    }
  >();
  const listeners = new Map<string, Set<(data: unknown) => void>>();

  function request(method: string, params?: unknown): Promise<unknown> {
    sequence += 1;
    const id = `${featureId}-${Date.now()}-${sequence}`;
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Pi Desktop did not answer '${method}'.`));
      }, 600_000);
      pending.set(id, { resolve, reject, timeout });
      window.parent.postMessage(
        {
          source: FEATURE_SOURCE,
          version: API_VERSION,
          featureId,
          id,
          method,
          params,
        },
        "*",
      );
    });
  }

  function on(eventName: string, listener: (data: unknown) => void): () => void {
    const eventListeners = listeners.get(eventName) ?? new Set();
    eventListeners.add(listener);
    listeners.set(eventName, eventListeners);
    return () => {
      eventListeners.delete(listener);
      if (eventListeners.size === 0) listeners.delete(eventName);
    };
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const message = event.data as Record<string, unknown> | null;
    if (
      !message ||
      message.source !== HOST_SOURCE ||
      message.version !== API_VERSION ||
      message.featureId !== featureId
    ) {
      return;
    }
    if (message.type === "response" && typeof message.id === "string") {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      window.clearTimeout(request.timeout);
      if (message.ok === true) {
        request.resolve(message.result);
      } else {
        request.reject(new Error(typeof message.error === "string" ? message.error : "Host request failed."));
      }
      return;
    }
    if (message.type === "event" && typeof message.event === "string") {
      listeners.get(message.event)?.forEach((listener) => listener(message.data));
      window.dispatchEvent(
        new CustomEvent(`pi-desktop:${message.event}`, { detail: message.data }),
      );
    }
  });

  const api = Object.freeze({
    apiVersion: API_VERSION,
    getContext: () => request("host.getContext"),
    openExternal: (url: string) => request("host.openExternal", { url }),
    navigate: (target: "chat" | "plugins") => request("host.navigate", { target }),
    service: Object.freeze({
      request: (method: string, params?: unknown) =>
        request("service.request", { method, params }),
      onEvent: (listener: (event: unknown) => void) => on("service.event", listener),
    }),
    storage: Object.freeze({
      get: (key: string) => request("storage.get", { key }),
      set: (key: string, value: unknown) => request("storage.set", { key, value }),
      delete: (key: string) => request("storage.delete", { key }),
    }),
    pi: Object.freeze({
      request: (command: Record<string, unknown>) => request("pi.request", { command }),
      prompt: (message: string) =>
        request("pi.request", { command: { type: "prompt", message } }),
      getState: () => request("pi.request", { command: { type: "get_state" } }),
      onEvent: (listener: (event: unknown) => void) => on("pi.event", listener),
    }),
    on,
  });

  Object.defineProperty(window, "piDesktop", {
    value: api,
    configurable: false,
    enumerable: true,
    writable: false,
  });
  window.parent.postMessage(
    {
      source: FEATURE_SOURCE,
      version: API_VERSION,
      featureId,
      type: "ready",
    },
    "*",
  );
}

export function createFeatureDocument(html: string, featureId: string): string {
  const bootstrap = `<script>(${installFeatureBridgeRuntime.toString()})(${JSON.stringify(
    featureId,
  )});</script>`;
  const head = /<head(?:\s[^>]*)?>/i;
  if (head.test(html)) {
    return html.replace(head, (match) => `${match}${bootstrap}`);
  }
  return `${bootstrap}${html}`;
}
