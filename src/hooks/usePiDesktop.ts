import { useCallback, useEffect, useRef, useState } from "react";
import { desktopApi } from "../api";
import type {
  AgentMessage,
  AppSettings,
  ContentBlock,
  KernelInfo,
  PiModel,
  PiSlashCommand,
  PiSessionInfo,
  PiState,
  RpcEnvelope,
  ToolAccessMode,
  ToolAccessState,
  ToolPermissionRequest,
} from "../types";

export interface MessageFeedItem {
  id: string;
  kind: "message";
  message: AgentMessage;
  streaming?: boolean;
  optimistic?: boolean;
}

export interface ToolFeedItem {
  id: string;
  kind: "tool";
  toolCallId: string;
  name: string;
  args?: unknown;
  result?: unknown;
  status: "approval" | "running" | "done" | "error";
}

export interface EventFeedItem {
  id: string;
  kind: "event";
  event: RpcEnvelope;
}

export type FeedItem = MessageFeedItem | ToolFeedItem | EventFeedItem;

export interface RpcLogEntry {
  id: string;
  receivedAt: number;
  event: RpcEnvelope;
}

export interface SessionStats {
  sessionFile?: string;
  sessionId?: string;
  userMessages?: number;
  assistantMessages?: number;
  toolCalls?: number;
  totalMessages?: number;
  tokens?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
  cost?: number;
  contextUsage?: {
    tokens?: number | null;
    contextWindow?: number;
    percent?: number | null;
  };
}

export interface QueueState {
  steering: string[];
  followUp: string[];
}

export type ComposerMode = "steer" | "followUp";

const EMPTY_SETTINGS: AppSettings = {
  kernelPath: "",
  defaultCwd: "",
  providers: [],
};

const EMPTY_KERNEL: KernelInfo = { status: "disconnected" };

const PREVIEW_NAME =
  new URLSearchParams(window.location.search).get("preview") ?? "";
const PREVIEW_MODE =
  import.meta.env.DEV &&
  ["conversation", "terminal", "permission"].includes(PREVIEW_NAME);
const PERMISSION_PREVIEW = PREVIEW_MODE && PREVIEW_NAME === "permission";

const PREVIEW_MODEL: PiModel = {
  id: "gpt-5.6-sol",
  name: "GPT-5.6 Sol",
  provider: "openai",
  reasoning: true,
  contextWindow: 272000,
};

const PREVIEW_SESSIONS: PiSessionInfo[] = [
  {
    path: "/Users/anson/.pi/agent/sessions/project/retry-worker.jsonl",
    id: "preview-session",
    cwd: "/Users/anson/project",
    name: "Retry worker",
    created: "2026-08-12T10:00:00.000Z",
    modified: "2026-08-12T12:00:00.000Z",
    messageCount: 2,
    firstMessage: "Implement exponential backoff for the worker loop",
  },
  {
    path: "/Users/anson/.pi/agent/sessions/project/api-review.jsonl",
    id: "preview-api-review",
    cwd: "/Users/anson/project",
    name: "API review",
    created: "2026-08-11T08:00:00.000Z",
    modified: "2026-08-11T09:30:00.000Z",
    messageCount: 8,
    firstMessage: "Review the API client changes",
  },
  {
    path: "/Users/anson/.pi/agent/sessions/website/header.jsonl",
    id: "preview-website-header",
    cwd: "/Users/anson/website",
    created: "2026-08-10T08:00:00.000Z",
    modified: "2026-08-10T10:00:00.000Z",
    messageCount: 4,
    firstMessage: "Fix the responsive site header",
  },
];

const PREVIEW_FEED: FeedItem[] = [
  {
    id: "preview-user",
    kind: "message",
    message: {
      role: "user",
      content:
        "Can you implement a basic retry mechanism with exponential backoff in Python for the main worker loop?",
    },
  },
  {
    id: "preview-assistant",
    kind: "message",
    message: {
      role: "assistant",
      content: [
        {
          type: "text",
          text:
            "I’ll create a reusable retry decorator with exponential backoff and jitter, then apply it around the worker function so transient failures recover without changing the main loop.\n\n```python\nimport random\nimport time\nfrom functools import wraps\n\ndef with_exponential_backoff(max_retries=3, base_delay=1):\n    def decorator(func):\n        @wraps(func)\n        def wrapper(*args, **kwargs):\n            for retry in range(max_retries + 1):\n                try:\n                    return func(*args, **kwargs)\n                except Exception:\n                    if retry == max_retries:\n                        raise\n                    delay = base_delay * (2 ** retry)\n                    time.sleep(delay + random.uniform(0, delay * 0.2))\n        return wrapper\n    return decorator\n```",
        },
      ],
    },
  },
];

const KNOWN_EVENT_TYPES = new Set([
  "response",
  "agent_start",
  "agent_end",
  "agent_settled",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "bash_execution_update",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "queue_update",
  "compaction_start",
  "compaction_end",
  "auto_retry_start",
  "auto_retry_end",
  "summarization_retry_scheduled",
  "summarization_retry_attempt_start",
  "summarization_retry_finished",
  "extension_error",
  "bridge_ready",
  "bridge_error",
  "session_start",
  "session_shutdown",
  "session_info_changed",
  "session_compact",
  "session_tree",
  "model_select",
  "thinking_level_select",
  "tool_access_changed",
  "tool_permission_request",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === "string"
    ? (value[key] as string)
    : undefined;
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (isRecord(error) && typeof error.message === "string") return error.message;
  return "An unexpected desktop error occurred.";
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function waitForResidentTerminalToStop(): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const status = await desktopApi.nativeTerminalStatus();
    if (status.phase === "inactive" || status.phase === "error") return;
    await pause(50);
  }
  throw new Error("Pi did not stop in time to switch workspaces.");
}

function rpcError(envelope: RpcEnvelope): string {
  if (typeof envelope.error === "string") return envelope.error;
  if (envelope.error?.message) return envelope.error.message;
  return `${envelope.command ?? "Pi bridge command"} failed.`;
}

function messageText(message: AgentMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((block) => block.text ?? block.thinking ?? "")
    .join("");
}

function messageBlocks(message: AgentMessage): ContentBlock[] {
  if (Array.isArray(message.content)) return [...message.content];
  if (typeof message.content === "string") {
    return [{ type: "text", text: message.content }];
  }
  return [];
}

function findLastMatchingIndex<T>(
  values: T[],
  predicate: (value: T) => boolean,
): number {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index])) return index;
  }
  return -1;
}

function applyMessageDelta(
  message: AgentMessage,
  rawDelta: unknown,
): AgentMessage {
  if (!isRecord(rawDelta) || typeof rawDelta.type !== "string") return message;

  const index =
    typeof rawDelta.contentIndex === "number" ? rawDelta.contentIndex : 0;
  const blocks = messageBlocks(message);
  while (blocks.length <= index) blocks.push({ type: "text", text: "" });

  const current = blocks[index] ?? { type: "text", text: "" };
  const delta = typeof rawDelta.delta === "string" ? rawDelta.delta : "";

  switch (rawDelta.type) {
    case "text_start":
      blocks[index] = { type: "text", text: "" };
      break;
    case "text_delta":
      blocks[index] = {
        ...current,
        type: "text",
        text: `${current.text ?? ""}${delta}`,
      };
      break;
    case "text_end":
      blocks[index] = {
        ...current,
        type: "text",
        text:
          typeof rawDelta.content === "string"
            ? rawDelta.content
            : current.text ?? "",
      };
      break;
    case "thinking_start":
      blocks[index] = { type: "thinking", thinking: "" };
      break;
    case "thinking_delta":
      blocks[index] = {
        ...current,
        type: "thinking",
        thinking: `${current.thinking ?? current.text ?? ""}${delta}`,
      };
      break;
    case "thinking_end":
      blocks[index] = {
        ...current,
        type: "thinking",
        thinking:
          typeof rawDelta.content === "string"
            ? rawDelta.content
            : current.thinking ?? current.text ?? "",
      };
      break;
    case "toolcall_start":
      blocks[index] = {
        type: "toolCall",
        id: stringField(rawDelta, "id"),
        name: stringField(rawDelta, "name") ?? "tool",
        arguments: "",
      };
      break;
    case "toolcall_delta":
      blocks[index] = {
        ...current,
        type: "toolCall",
        arguments: `${typeof current.arguments === "string" ? current.arguments : ""}${delta}`,
      };
      break;
    case "toolcall_end": {
      const toolCall = isRecord(rawDelta.toolCall) ? rawDelta.toolCall : rawDelta;
      blocks[index] = {
        type: "toolCall",
        id: stringField(toolCall, "id"),
        name: stringField(toolCall, "name") ?? current.name ?? "tool",
        arguments: toolCall.arguments ?? current.arguments,
      };
      break;
    }
    default:
      break;
  }

  return { ...message, content: blocks };
}

export function usePiDesktop() {
  const [settings, setSettings] = useState<AppSettings>(() =>
    PREVIEW_MODE
      ? { ...EMPTY_SETTINGS, defaultCwd: "/Users/anson/project" }
      : EMPTY_SETTINGS,
  );
  const [kernel, setKernel] = useState<KernelInfo>(() =>
    PREVIEW_MODE
      ? {
          status: "connected",
          executable: "pi",
          cwd: "/Users/anson/project",
        }
      : EMPTY_KERNEL,
  );
  const [piState, setPiState] = useState<PiState>(() =>
    PREVIEW_MODE
      ? {
          model: PREVIEW_MODEL,
          thinkingLevel: "high",
          sessionId: "preview-session",
          sessionFile: PREVIEW_SESSIONS[0].path,
          sessionName: "Retry worker",
          cwd: "/Users/anson/project",
          messageCount: 2,
          isStreaming: false,
        }
      : {},
  );
  const [models, setModels] = useState<PiModel[]>(() =>
    PREVIEW_MODE ? [PREVIEW_MODEL] : [],
  );
  const [thinkingLevels, setThinkingLevels] = useState<string[]>(() =>
    PREVIEW_MODE ? ["off", "low", "medium", "high"] : ["off"],
  );
  const [feed, setFeed] = useState<FeedItem[]>(() =>
    PREVIEW_MODE ? PREVIEW_FEED : [],
  );
  const [rpcLog, setRpcLog] = useState<RpcLogEntry[]>([]);
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [queue, setQueue] = useState<QueueState>({
    steering: [],
    followUp: [],
  });
  const [initializing, setInitializing] = useState(!PREVIEW_MODE);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toolAccess, setToolAccess] = useState<ToolAccessState>(() => ({
    mode: PERMISSION_PREVIEW ? "ask" : "pi-default",
    modes: ["pi-default", "ask"],
    mechanism: "extension-tool-call",
  }));
  const [toolPermissionRequests, setToolPermissionRequests] = useState<
    ToolPermissionRequest[]
  >(() =>
    PERMISSION_PREVIEW
      ? [
          {
            requestId: "preview-tool-request",
            toolCallId: "preview-tool-call",
            toolName: "bash",
            cwd: "/Users/anson/project",
            summary: "rg -n \"TODO|FIXME\" src tests",
            input: { command: 'rg -n "TODO|FIXME" src tests' },
          },
        ]
      : [],
  );

  const sequenceRef = useRef(0);
  const activeMessageIdRef = useRef<string | null>(null);
  const activeSessionKeyRef = useRef<string | null>(null);

  const nextId = useCallback((prefix: string) => {
    sequenceRef.current += 1;
    return `${prefix}-${Date.now()}-${sequenceRef.current}`;
  }, []);

  const sendRpc = useCallback(
    async <T,>(command: Record<string, unknown>): Promise<T> => {
      const envelope = await desktopApi.send<RpcEnvelope>({
        ...command,
        id: nextId("rpc"),
      });
      if (envelope.success === false) throw new Error(rpcError(envelope));
      return envelope.data as T;
    },
    [nextId],
  );

  const refreshWorkspace = useCallback(async () => {
    setRefreshing(true);
    const [
      stateResult,
      messagesResult,
      modelsResult,
      levelsResult,
      statsResult,
      toolAccessResult,
    ] =
      await Promise.allSettled([
        sendRpc<PiState>({ type: "get_state" }),
        sendRpc<{ messages?: AgentMessage[] }>({ type: "get_messages" }),
        sendRpc<{ models?: PiModel[] }>({ type: "get_available_models" }),
        sendRpc<{ levels?: string[] }>({
          type: "get_available_thinking_levels",
        }),
        sendRpc<SessionStats>({ type: "get_session_stats" }),
        sendRpc<ToolAccessState>({ type: "get_tool_access" }),
      ]);

    if (stateResult.status === "fulfilled") {
      activeSessionKeyRef.current =
        stateResult.value.sessionId ?? stateResult.value.sessionFile ?? null;
      setPiState(stateResult.value);
    } else {
      setError(getErrorMessage(stateResult.reason));
    }

    if (messagesResult.status === "fulfilled") {
      const messages = messagesResult.value.messages ?? [];
      setFeed(
        messages.map((message, index) => ({
          id: `history-${index}`,
          kind: "message" as const,
          message,
        })),
      );
    }

    if (modelsResult.status === "fulfilled") {
      setModels(modelsResult.value.models ?? []);
    }

    if (levelsResult.status === "fulfilled") {
      setThinkingLevels(
        levelsResult.value.levels?.length ? levelsResult.value.levels : ["off"],
      );
    }

    if (statsResult.status === "fulfilled") setStats(statsResult.value);
    if (toolAccessResult.status === "fulfilled") {
      setToolAccess(toolAccessResult.value);
    }
    setRefreshing(false);
  }, [sendRpc]);

  const appendRpcLog = useCallback(
    (event: RpcEnvelope) => {
      const entry: RpcLogEntry = {
        id: nextId("event-log"),
        receivedAt: Date.now(),
        event,
      };
      setRpcLog((current) => [...current.slice(-79), entry]);
    },
    [nextId],
  );

  const handleMessageStart = useCallback(
    (event: RpcEnvelope) => {
      if (!isRecord(event.message)) return;
      const message = event.message as AgentMessage;
      const role = message.role ?? "assistant";

      if (role === "user") {
        const text = messageText(message);
        setFeed((current) => {
          const matchIndex = findLastMatchingIndex(
            current,
            (item) =>
              item.kind === "message" &&
              item.optimistic === true &&
              item.message.role === "user" &&
              messageText(item.message) === text,
          );
          if (matchIndex < 0) {
            return [
              ...current,
              { id: nextId("message"), kind: "message", message },
            ];
          }
          return current.map((item, index) =>
            index === matchIndex && item.kind === "message"
              ? { ...item, message, optimistic: false }
              : item,
          );
        });
        return;
      }

      const id = nextId("message");
      if (role === "assistant") activeMessageIdRef.current = id;
      setFeed((current) => [
        ...current,
        { id, kind: "message", message, streaming: role === "assistant" },
      ]);
    },
    [nextId],
  );

  const handleMessageUpdate = useCallback(
    (event: RpcEnvelope) => {
      let id = activeMessageIdRef.current;
      if (!id) {
        id = nextId("message");
        activeMessageIdRef.current = id;
        setFeed((current) => [
          ...current,
          {
            id: id as string,
            kind: "message",
            message: { role: "assistant", content: [] },
            streaming: true,
          },
        ]);
      }

      const targetId = id;
      setFeed((current) =>
        current.map((item) =>
          item.kind === "message" && item.id === targetId
            ? {
                ...item,
                message: applyMessageDelta(
                  item.message,
                  event.assistantMessageEvent,
                ),
                streaming: true,
              }
            : item,
        ),
      );
    },
    [nextId],
  );

  const handleMessageEnd = useCallback(
    (event: RpcEnvelope) => {
      if (!isRecord(event.message)) return;
      const message = event.message as AgentMessage;
      const role = message.role ?? "assistant";
      const activeId = activeMessageIdRef.current;

      if (role === "assistant" && activeId) {
        setFeed((current) =>
          current.map((item) =>
            item.kind === "message" && item.id === activeId
              ? { ...item, message, streaming: false }
              : item,
          ),
        );
        activeMessageIdRef.current = null;
        return;
      }

      const text = messageText(message);
      setFeed((current) => {
        const matchIndex = findLastMatchingIndex(
          current,
          (item) =>
            item.kind === "message" &&
            item.message.role === role &&
            messageText(item.message) === text,
        );
        if (matchIndex >= 0) {
          return current.map((item, index) =>
            index === matchIndex && item.kind === "message"
              ? { ...item, message, streaming: false, optimistic: false }
              : item,
          );
        }
        return [
          ...current,
          { id: nextId("message"), kind: "message", message },
        ];
      });
    },
    [nextId],
  );

  const handleRpcEvent = useCallback(
    (event: RpcEnvelope) => {
      appendRpcLog(event);

      switch (event.type) {
        case "bridge_ready":
        case "session_start":
          if (isRecord(event.toolAccess)) {
            const mode = stringField(event.toolAccess, "mode");
            if (mode === "pi-default" || mode === "ask") {
              setToolAccess({
                mode,
                modes: ["pi-default", "ask"],
                mechanism: "extension-tool-call",
              });
            }
          }
          if (isRecord(event.state)) {
            const nextState = event.state as PiState;
            const nextSessionKey =
              nextState.sessionId ?? nextState.sessionFile ?? null;
            const previousSessionKey = activeSessionKeyRef.current;
            activeSessionKeyRef.current = nextSessionKey;
            setPiState(nextState);
            if (
              previousSessionKey !== null &&
              nextSessionKey !== null &&
              previousSessionKey !== nextSessionKey
            ) {
              activeMessageIdRef.current = null;
              setFeed([]);
              setQueue({ steering: [], followUp: [] });
              setStats(null);
              void refreshWorkspace();
            }
          }
          break;
        case "tool_access_changed": {
          const mode = stringField(event, "mode");
          if (mode === "pi-default" || mode === "ask") {
            setToolAccess((current) => ({ ...current, mode }));
          }
          break;
        }
        case "tool_permission_request": {
          const requestId = stringField(event, "requestId");
          const toolCallId = stringField(event, "toolCallId");
          const toolName = stringField(event, "toolName");
          const cwd = stringField(event, "cwd");
          if (!requestId || !toolCallId || !toolName || !cwd) break;
          const request: ToolPermissionRequest = {
            requestId,
            toolCallId,
            toolName,
            cwd,
            summary: stringField(event, "summary") ?? `Run ${toolName}`,
            input: isRecord(event.input) ? event.input : {},
          };
          setToolPermissionRequests((current) => [
            ...current.filter((item) => item.requestId !== requestId),
            request,
          ]);
          setFeed((current) =>
            current.map((item) =>
              item.kind === "tool" && item.toolCallId === toolCallId
                ? { ...item, status: "approval" }
                : item,
            ),
          );
          break;
        }
        case "session_info_changed":
          setPiState((current) => ({
            ...current,
            sessionName:
              typeof event.name === "string" ? event.name : undefined,
          }));
          break;
        case "model_select":
          if (isRecord(event.model)) {
            setPiState((current) => ({
              ...current,
              model: event.model as PiModel,
            }));
          }
          break;
        case "thinking_level_select":
          if (typeof event.level === "string") {
            setPiState((current) => ({
              ...current,
              thinkingLevel: event.level as string,
            }));
          }
          break;
        case "session_compact":
          setPiState((current) => ({ ...current, isCompacting: false }));
          void refreshWorkspace();
          break;
        case "session_tree":
          void refreshWorkspace();
          break;
        case "bridge_error":
          setError(stringField(event, "message") ?? "Pi Desktop bridge failed.");
          break;
        case "agent_start":
          setPiState((current) => ({ ...current, isStreaming: true }));
          break;
        case "agent_settled":
          setPiState((current) => ({ ...current, isStreaming: false }));
          break;
        case "message_start":
          handleMessageStart(event);
          break;
        case "message_update":
          handleMessageUpdate(event);
          break;
        case "message_end":
          handleMessageEnd(event);
          break;
        case "tool_execution_start": {
          const toolCallId = stringField(event, "toolCallId") ?? nextId("tool");
          setFeed((current) => [
            ...current,
            {
              id: `tool-${toolCallId}`,
              kind: "tool",
              toolCallId,
              name: stringField(event, "toolName") ?? "tool",
              args: event.args,
              status: "running",
            },
          ]);
          break;
        }
        case "tool_execution_update": {
          const toolCallId = stringField(event, "toolCallId");
          if (!toolCallId) break;
          setFeed((current) =>
            current.map((item) =>
              item.kind === "tool" && item.toolCallId === toolCallId
                ? { ...item, result: event.partialResult }
                : item,
            ),
          );
          break;
        }
        case "tool_execution_end": {
          const toolCallId = stringField(event, "toolCallId");
          if (!toolCallId) break;
          setFeed((current) =>
            current.map((item) =>
              item.kind === "tool" && item.toolCallId === toolCallId
                ? {
                    ...item,
                    result: event.result,
                    status: event.isError === true ? "error" : "done",
                  }
                : item,
            ),
          );
          setToolPermissionRequests((current) =>
            current.filter((item) => item.toolCallId !== toolCallId),
          );
          break;
        }
        case "queue_update":
          setQueue({
            steering: Array.isArray(event.steering)
              ? event.steering.filter(
                  (item): item is string => typeof item === "string",
                )
              : [],
            followUp: Array.isArray(event.followUp)
              ? event.followUp.filter(
                  (item): item is string => typeof item === "string",
                )
              : [],
          });
          break;
        case "compaction_start":
          setPiState((current) => ({ ...current, isCompacting: true }));
          break;
        case "compaction_end":
          setPiState((current) => ({ ...current, isCompacting: false }));
          break;
        case "extension_error":
          setError(stringField(event, "message") ?? "A Pi extension failed.");
          break;
        default:
          if (!KNOWN_EVENT_TYPES.has(event.type)) {
            setFeed((current) => [
              ...current,
              { id: nextId("event"), kind: "event", event },
            ]);
          }
          break;
      }
    },
    [
      appendRpcLog,
      handleMessageEnd,
      handleMessageStart,
      handleMessageUpdate,
      nextId,
      refreshWorkspace,
    ],
  );

  useEffect(() => {
    if (PREVIEW_MODE) return;
    let disposed = false;

    async function initialize() {
      const [settingsResult, kernelResult] = await Promise.allSettled([
        desktopApi.getSettings(),
        desktopApi.kernelStatus(),
      ]);

      if (disposed) return;
      if (settingsResult.status === "fulfilled") {
        setSettings(settingsResult.value);
      } else {
        setError(getErrorMessage(settingsResult.reason));
      }

      if (kernelResult.status === "fulfilled") {
        setKernel(kernelResult.value);
        if (kernelResult.value.status === "connected") {
          await refreshWorkspace();
        }
      } else {
        setError(getErrorMessage(kernelResult.reason));
      }

      if (!disposed) setInitializing(false);
    }

    void initialize();
    return () => {
      disposed = true;
    };
  }, [refreshWorkspace]);

  useEffect(() => {
    if (PREVIEW_MODE) return;
    let disposed = false;
    let stopRpc: (() => void) | undefined;
    let stopKernel: (() => void) | undefined;

    void desktopApi.onPiEvent(handleRpcEvent).then((unlisten) => {
      if (disposed) unlisten();
      else stopRpc = unlisten;
    });

    void desktopApi.onKernelStatus((status) => {
      setKernel(status);
      if (status.status === "connected") void refreshWorkspace();
      if (status.status === "disconnected" || status.status === "error") {
        setPiState((current) => ({ ...current, isStreaming: false }));
      }
    }).then((unlisten) => {
      if (disposed) unlisten();
      else stopKernel = unlisten;
    });

    return () => {
      disposed = true;
      stopRpc?.();
      stopKernel?.();
    };
  }, [handleRpcEvent, refreshWorkspace]);

  const connect = useCallback(async () => {
    setError(null);
    setKernel((current) => ({ ...current, status: "connecting", error: undefined }));
    try {
      const status = await desktopApi.startKernel(
        settings.kernelPath || undefined,
        settings.defaultCwd || undefined,
      );
      setKernel(status);
      if (status.status === "connected") await refreshWorkspace();
    } catch (caught) {
      const message = getErrorMessage(caught);
      setKernel({ status: "error", error: message });
      setError(message);
      throw caught;
    }
  }, [refreshWorkspace, settings.defaultCwd, settings.kernelPath]);

  const disconnect = useCallback(async () => {
    setError(null);
    try {
      await desktopApi.stopKernel();
      setKernel(EMPTY_KERNEL);
      setPiState({});
      activeSessionKeyRef.current = null;
      setFeed([]);
      setModels([]);
      setStats(null);
    } catch (caught) {
      setError(getErrorMessage(caught));
      throw caught;
    }
  }, []);

  const saveSettings = useCallback(async (nextSettings: AppSettings) => {
    const saved = await desktopApi.saveSettings(nextSettings);
    setSettings(saved);
    return saved;
  }, []);

  const switchWorkspace = useCallback(
    async (cwd: string) => {
      const target = cwd.trim();
      if (!target) throw new Error("Choose a workspace folder first.");
      if (
        target === (piState.cwd ?? kernel.cwd) &&
        kernel.status === "connected"
      ) {
        return kernel;
      }

      setError(null);
      const nextSettings = { ...settings, defaultCwd: target };

      if (PREVIEW_MODE) {
        const sessionId = `preview-workspace-${Date.now()}`;
        setSettings(nextSettings);
        setKernel((current) => ({
          ...current,
          status: "connected",
          cwd: target,
          error: undefined,
        }));
        activeSessionKeyRef.current = sessionId;
        activeMessageIdRef.current = null;
        setPiState((current) => ({
          ...current,
          sessionId,
          sessionFile: undefined,
          sessionName: undefined,
          cwd: target,
          messageCount: 0,
          isStreaming: false,
        }));
        setFeed([]);
        setQueue({ steering: [], followUp: [] });
        setStats(null);
        return { ...kernel, status: "connected" as const, cwd: target };
      }

      try {
        const saved = await desktopApi.saveSettings(nextSettings);
        setSettings(saved);

        if (
          kernel.status === "connected" ||
          kernel.status === "connecting" ||
          kernel.status === "error"
        ) {
          await desktopApi.stopKernel();
          await waitForResidentTerminalToStop();
        }

        activeSessionKeyRef.current = null;
        activeMessageIdRef.current = null;
        setPiState({});
        setFeed([]);
        setQueue({ steering: [], followUp: [] });
        setModels([]);
        setStats(null);
        setKernel((current) => ({
          ...current,
          status: "connecting",
          cwd: target,
          error: undefined,
        }));

        const status = await desktopApi.startKernel(
          saved.kernelPath || undefined,
          target,
        );
        setKernel(status);
        if (status.status === "connected") await refreshWorkspace();
        return status;
      } catch (caught) {
        const message = getErrorMessage(caught);
        setKernel((current) => ({
          ...current,
          status: "error",
          cwd: target,
          error: message,
        }));
        setError(message);
        throw caught;
      }
    },
    [kernel, piState.cwd, refreshWorkspace, settings],
  );

  const sendMessage = useCallback(
    async (text: string, mode: ComposerMode) => {
      const message = text.trim();
      if (!message) return;
      const optimisticId = nextId("local-message");
      setFeed((current) => [
        ...current,
        {
          id: optimisticId,
          kind: "message",
          message: { role: "user", content: message, timestamp: Date.now() },
          optimistic: true,
        },
      ]);

      const commandType = piState.isStreaming
        ? mode === "steer"
          ? "steer"
          : "follow_up"
        : "prompt";

      try {
        await sendRpc<void>({ type: commandType, message });
        if (commandType === "prompt") {
          setPiState((current) => ({ ...current, isStreaming: true }));
        }
      } catch (caught) {
        setFeed((current) =>
          current.map((item) =>
            item.kind === "message" && item.id === optimisticId
              ? {
                  ...item,
                  message: { ...item.message, isError: true },
                  optimistic: false,
                }
              : item,
          ),
        );
        setError(getErrorMessage(caught));
        throw caught;
      }
    },
    [nextId, piState.isStreaming, sendRpc],
  );

  const abort = useCallback(async () => {
    try {
      await sendRpc<void>({ type: "abort" });
    } catch (caught) {
      setError(getErrorMessage(caught));
      throw caught;
    }
  }, [sendRpc]);

  const replaceSession = useCallback(
    async <T extends { cancelled?: boolean }>(command: Record<string, unknown>) => {
      setError(null);
      try {
        if (piState.isStreaming) await sendRpc<void>({ type: "abort" });
        const result = await sendRpc<T>(command);
        if (result.cancelled !== true) {
          activeMessageIdRef.current = null;
          setFeed([]);
          setQueue({ steering: [], followUp: [] });
          await refreshWorkspace();
        }
        return result;
      } catch (caught) {
        setError(getErrorMessage(caught));
        throw caught;
      }
    },
    [piState.isStreaming, refreshWorkspace, sendRpc],
  );

  const newSession = useCallback(
    () => replaceSession<{ cancelled?: boolean }>({ type: "new_session" }),
    [replaceSession],
  );

  const createResidentSession = useCallback(async () => {
    if (!PREVIEW_MODE) {
      await desktopApi.submitNativeTerminal("/new");
      return;
    }
    const sessionId = `preview-session-${Date.now()}`;
    activeSessionKeyRef.current = sessionId;
    activeMessageIdRef.current = null;
    setPiState((current) => ({
      ...current,
      sessionFile: undefined,
      sessionId,
      sessionName: undefined,
      messageCount: 0,
      isStreaming: false,
    }));
    setFeed([]);
    setQueue({ steering: [], followUp: [] });
    setStats(null);
  }, []);

  const switchSession = useCallback(
    async (sessionPath: string) => {
      const path = sessionPath.trim();
      if (!path) throw new Error("A Pi session path is required.");
      if (path === piState.sessionFile) {
        return { cancelled: false, alreadyCurrent: true };
      }
      if (PREVIEW_MODE) {
        const session = PREVIEW_SESSIONS.find(
          (candidate) => candidate.path === path,
        );
        if (!session) throw new Error("That Pi conversation no longer exists.");
        activeMessageIdRef.current = null;
        setFeed([]);
        setQueue({ steering: [], followUp: [] });
        activeSessionKeyRef.current = session.id;
        setPiState((current) => ({
          ...current,
          sessionFile: session.path,
          sessionId: session.id,
          sessionName: session.name,
          cwd: session.cwd,
          messageCount: session.messageCount,
          isStreaming: false,
        }));
        return { cancelled: false, alreadyCurrent: false };
      }
      const prepared = await sendRpc<{
        alreadyCurrent?: boolean;
        command?: string;
        session?: PiSessionInfo;
      }>({
        type: "prepare_switch_session",
        sessionPath: path,
      });
      if (prepared.alreadyCurrent) {
        return { cancelled: false, alreadyCurrent: true };
      }
      if (!prepared.command) {
        throw new Error("Pi did not provide a session-switch command.");
      }
      await desktopApi.submitNativeTerminal(prepared.command);
      return { cancelled: false, alreadyCurrent: false };
    },
    [piState.sessionFile, sendRpc],
  );

  const listSessions = useCallback(async () => {
    if (PREVIEW_MODE) return PREVIEW_SESSIONS;
    const result = await sendRpc<{ sessions?: PiSessionInfo[] }>({
      type: "list_sessions",
    });
    return result.sessions ?? [];
  }, [sendRpc]);

  const getForkMessages = useCallback(async () => {
    const result = await sendRpc<{
      messages?: Array<{ entryId: string; text: string }>;
    }>({ type: "get_fork_messages" });
    return result.messages ?? [];
  }, [sendRpc]);

  const getCommands = useCallback(async () => {
    if (PREVIEW_MODE) {
      return [
        {
          name: "review",
          description: "Review the current changes",
          source: "extension",
        },
        {
          name: "skill:code-review",
          description: "Review code with the project workflow",
          source: "skill",
        },
        {
          name: "release-notes",
          description: "Draft release notes",
          source: "prompt",
        },
      ] satisfies PiSlashCommand[];
    }
    const result = await sendRpc<{ commands?: PiSlashCommand[] }>({
      type: "get_commands",
    });
    return result.commands ?? [];
  }, [sendRpc]);

  const forkSession = useCallback(
    async (entryId: string) => {
      const id = entryId.trim();
      if (!id) throw new Error("A Pi session entry ID is required.");
      return replaceSession<{ cancelled?: boolean; text?: string }>({
        type: "fork",
        entryId: id,
      });
    },
    [replaceSession],
  );

  const cloneSession = useCallback(
    () => replaceSession<{ cancelled?: boolean }>({ type: "clone" }),
    [replaceSession],
  );

  const setSessionName = useCallback(
    async (name: string) => {
      await sendRpc<void>({ type: "set_session_name", name: name.trim() });
      setPiState((current) => ({
        ...current,
        sessionName: name.trim() || undefined,
      }));
    },
    [sendRpc],
  );

  const exportSession = useCallback(
    async (outputPath?: string) => {
      const result = await sendRpc<{ path: string }>({
        type: "export_html",
        ...(outputPath?.trim() ? { outputPath: outputPath.trim() } : {}),
      });
      return result.path;
    },
    [sendRpc],
  );

  const selectModel = useCallback(
    async (provider: string, modelId: string) => {
      try {
        const model = await sendRpc<PiModel>({
          type: "set_model",
          provider,
          modelId,
        });
        setPiState((current) => ({ ...current, model }));
        const levels = await sendRpc<{ levels?: string[] }>({
          type: "get_available_thinking_levels",
        });
        setThinkingLevels(levels.levels?.length ? levels.levels : ["off"]);
      } catch (caught) {
        setError(getErrorMessage(caught));
        throw caught;
      }
    },
    [sendRpc],
  );

  const selectThinkingLevel = useCallback(
    async (level: string) => {
      try {
        await sendRpc<void>({ type: "set_thinking_level", level });
        setPiState((current) => ({ ...current, thinkingLevel: level }));
      } catch (caught) {
        setError(getErrorMessage(caught));
        throw caught;
      }
    },
    [sendRpc],
  );

  const selectToolAccess = useCallback(
    async (mode: ToolAccessMode) => {
      try {
        const next = await sendRpc<ToolAccessState>({
          type: "set_tool_access",
          mode,
        });
        setToolAccess(next);
      } catch (caught) {
        setError(getErrorMessage(caught));
        throw caught;
      }
    },
    [sendRpc],
  );

  const resolveToolPermission = useCallback(
    async (requestId: string, decision: "allow" | "deny") => {
      const request = toolPermissionRequests.find(
        (item) => item.requestId === requestId,
      );
      try {
        await sendRpc({
          type: "resolve_tool_permission",
          requestId,
          decision,
        });
        setToolPermissionRequests((current) =>
          current.filter((item) => item.requestId !== requestId),
        );
        if (decision === "allow" && request) {
          setFeed((current) =>
            current.map((item) =>
              item.kind === "tool" && item.toolCallId === request.toolCallId
                ? { ...item, status: "running" }
                : item,
            ),
          );
        }
      } catch (caught) {
        setError(getErrorMessage(caught));
        setToolPermissionRequests((current) =>
          current.filter((item) => item.requestId !== requestId),
        );
        throw caught;
      }
    },
    [sendRpc, toolPermissionRequests],
  );

  return {
    settings,
    kernel,
    piState,
    models,
    thinkingLevels,
    feed,
    rpcLog,
    stats,
    queue,
    initializing,
    refreshing,
    error,
    toolAccess,
    toolPermissionRequests,
    clearError: () => setError(null),
    connect,
    disconnect,
    saveSettings,
    switchWorkspace,
    sendMessage,
    abort,
    newSession,
    createResidentSession,
    switchSession,
    listSessions,
    getCommands,
    getForkMessages,
    forkSession,
    cloneSession,
    setSessionName,
    exportSession,
    selectModel,
    selectThinkingLevel,
    selectToolAccess,
    resolveToolPermission,
    refreshWorkspace,
  };
}
