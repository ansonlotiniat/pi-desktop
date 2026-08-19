import { useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { desktopApi } from "../api";
import { createFeatureDocument } from "./featureDocument";
import {
  FEATURE_API_VERSION,
  FEATURE_MESSAGE_SOURCE,
  HOST_MESSAGE_SOURCE,
  type FeatureDescriptor,
  type FeatureHostContext,
  type FeatureIncomingMessage,
  type FeatureRequestMessage,
  type HostEventMessage,
  type HostResponseMessage,
} from "./types";

interface FeatureFrameProps {
  feature: FeatureDescriptor;
  projectRoot?: string;
  context: FeatureHostContext;
  revision: number;
  onReload: () => void;
  onNavigate: (target: "chat" | "plugins") => void;
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  return String(reason);
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function isFeatureMessage(value: unknown, featureId: string): value is FeatureIncomingMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  return (
    message.source === FEATURE_MESSAGE_SOURCE &&
    message.version === FEATURE_API_VERSION &&
    message.featureId === featureId
  );
}

export function FeatureFrame({
  feature,
  projectRoot,
  context,
  revision,
  onReload,
  onNavigate,
}: FeatureFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const onNavigateRef = useRef(onNavigate);
  const [html, setHtml] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    onNavigateRef.current = onNavigate;
  }, [onNavigate]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setReady(false);
    setError(null);
    setHtml(null);
    void desktopApi
      .loadFeatureUi(feature.id, projectRoot)
      .then((source) => {
        if (!cancelled) setHtml(source);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(errorMessage(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [feature.id, projectRoot, revision]);

  const documentHtml = useMemo(
    () => (html === null ? null : createFeatureDocument(html, feature.id)),
    [feature.id, html],
  );

  function post(message: HostEventMessage | HostResponseMessage) {
    iframeRef.current?.contentWindow?.postMessage(message, "*");
  }

  function postEvent(event: HostEventMessage["event"], data: unknown) {
    post({
      source: HOST_MESSAGE_SOURCE,
      version: FEATURE_API_VERSION,
      featureId: feature.id,
      type: "event",
      event,
      data,
    });
  }

  useEffect(() => {
    if (ready) postEvent("host.context", context);
  }, [context, ready]);

  useEffect(() => {
    let disposed = false;
    let removeServiceListener: (() => void) | undefined;
    let removePiListener: (() => void) | undefined;

    void desktopApi.onFeatureServiceEvent((message) => {
      if (
        !disposed &&
        ready &&
        message.featureId === feature.id &&
        (!projectRoot || message.workspace === projectRoot)
      ) {
        postEvent("service.event", message.event);
      }
    }).then((remove) => {
      if (disposed) remove();
      else removeServiceListener = remove;
    });
    void desktopApi.onPiEvent((event) => {
      if (!disposed && ready) postEvent("pi.event", event);
    }).then((remove) => {
      if (disposed) remove();
      else removePiListener = remove;
    });

    return () => {
      disposed = true;
      removeServiceListener?.();
      removePiListener?.();
    };
  }, [feature.id, projectRoot, ready]);

  useEffect(() => {
    async function execute(request: FeatureRequestMessage): Promise<unknown> {
      const params = objectValue(request.params);
      switch (request.method) {
        case "host.getContext":
          return context;
        case "host.openExternal": {
          const url = requiredString(params.url, "URL");
          await openUrl(url);
          return null;
        }
        case "host.navigate": {
          const target = requiredString(params.target, "Navigation target");
          if (target !== "chat" && target !== "plugins") {
            throw new Error(`Unsupported feature navigation target '${target}'.`);
          }
          onNavigateRef.current(target);
          return null;
        }
        case "service.request": {
          const method = requiredString(params.method, "Service method");
          return desktopApi.requestFeatureService(
            feature.id,
            method,
            params.params ?? null,
            projectRoot,
          );
        }
        case "storage.get":
          return desktopApi.getFeatureStorage(
            feature.id,
            requiredString(params.key, "Storage key"),
          );
        case "storage.set":
          await desktopApi.setFeatureStorage(
            feature.id,
            requiredString(params.key, "Storage key"),
            params.value ?? null,
          );
          return null;
        case "storage.delete":
          return desktopApi.deleteFeatureStorage(
            feature.id,
            requiredString(params.key, "Storage key"),
          );
        case "pi.request": {
          const command = objectValue(params.command);
          if (typeof command.type !== "string" || command.type.trim() === "") {
            throw new Error("Pi request must contain a string 'type' field.");
          }
          return desktopApi.send(command);
        }
        default:
          throw new Error(`Unsupported feature host method '${request.method}'.`);
      }
    }

    function onMessage(event: MessageEvent<unknown>) {
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (!isFeatureMessage(event.data, feature.id)) return;
      const message = event.data;
      if ("type" in message && message.type === "ready") {
        setReady(true);
        postEvent("host.context", context);
        return;
      }
      if (!("id" in message) || !("method" in message)) return;
      if (typeof message.id !== "string" || typeof message.method !== "string") return;
      void execute(message)
        .then((result) => {
          post({
            source: HOST_MESSAGE_SOURCE,
            version: FEATURE_API_VERSION,
            featureId: feature.id,
            type: "response",
            id: message.id,
            ok: true,
            result,
          });
        })
        .catch((reason: unknown) => {
          post({
            source: HOST_MESSAGE_SOURCE,
            version: FEATURE_API_VERSION,
            featureId: feature.id,
            type: "response",
            id: message.id,
            ok: false,
            error: errorMessage(reason),
          });
        });
    }

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [context, feature.id, projectRoot]);

  if (loading) {
    return <div className="feature-frame-state">Loading {feature.name}…</div>;
  }
  if (error || documentHtml === null) {
    return (
      <div className="feature-frame-state feature-frame-error" role="alert">
        <strong>{feature.name} could not open.</strong>
        <p>{error ?? "The feature did not provide a UI document."}</p>
        <button type="button" className="secondary-button" onClick={onReload}>
          Reload feature
        </button>
      </div>
    );
  }

  return (
    <iframe
      key={`${feature.id}-${revision}`}
      ref={iframeRef}
      className="feature-frame"
      title={feature.name}
      srcDoc={documentHtml}
      sandbox="allow-scripts allow-forms allow-popups allow-downloads"
      referrerPolicy="no-referrer"
    />
  );
}
