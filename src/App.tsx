import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  ArrowClockwise,
  ArrowUp,
  CaretDown,
  CaretRight,
  Chats,
  FolderOpen,
  GearSix,
  MagnifyingGlass,
  Plus,
  PuzzlePiece,
  PushPinSimple,
  ShieldCheck,
  ShieldWarning,
  SidebarSimple,
  SlidersHorizontal,
  Stop,
  X,
} from "@phosphor-icons/react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import "./App.css";
import { desktopApi } from "./api";
import { NativePiTerminal } from "./components/NativePiTerminal";
import { MessageContent, safeJson } from "./components/RichContent";
import { SettingsDialog } from "./components/SettingsDialog";
import { FeatureFrame } from "./features/FeatureFrame";
import { FeatureManager } from "./features/FeatureManager";
import type { FeatureDescriptor, FeatureHostContext } from "./features/types";
import { useFeatureCatalog } from "./features/useFeatureCatalog";
import { useAuthoringSkill } from "./features/useAuthoringSkill";
import {
  usePiDesktop,
  type ComposerMode,
  type EventFeedItem,
  type FeedItem,
  type MessageFeedItem,
  type ToolFeedItem,
} from "./hooks/usePiDesktop";
import type {
  PiModel,
  PiSessionInfo,
  PiSlashCommand,
  ToolAccessMode,
  ToolPermissionRequest,
} from "./types";

type ActiveSurface =
  | { type: "feature"; featureId: string }
  | { type: "manager" }
  | null;

interface NativeTerminalRequest {
  initialInput: string;
  closeOnAgentStart?: boolean;
}

type ComposerCommandSource = PiSlashCommand["source"] | "builtin";

interface ComposerCommand {
  name: string;
  description: string;
  source: ComposerCommandSource;
}

interface SlashToken {
  start: number;
  end: number;
  query: string;
}

interface ConversationSession {
  key: string;
  id?: string;
  path?: string;
  cwd: string;
  name?: string;
  firstMessage?: string;
  modified: number;
  messageCount: number;
  current: boolean;
}

interface SessionGroup {
  cwd: string;
  sessions: ConversationSession[];
}

const BUILTIN_PI_COMMANDS: readonly ComposerCommand[] = [
  { name: "settings", description: "Open settings menu", source: "builtin" },
  { name: "model", description: "Select model", source: "builtin" },
  { name: "scoped-models", description: "Choose models for keyboard cycling", source: "builtin" },
  { name: "export", description: "Export this session", source: "builtin" },
  { name: "import", description: "Import and resume a JSONL session", source: "builtin" },
  { name: "share", description: "Share this session as a secret gist", source: "builtin" },
  { name: "copy", description: "Copy the last Pi message", source: "builtin" },
  { name: "name", description: "Set the session name", source: "builtin" },
  { name: "session", description: "Show session information", source: "builtin" },
  { name: "changelog", description: "Show Pi changelog entries", source: "builtin" },
  { name: "hotkeys", description: "Show Pi keyboard shortcuts", source: "builtin" },
  { name: "fork", description: "Fork from an earlier user message", source: "builtin" },
  { name: "clone", description: "Clone the current session position", source: "builtin" },
  { name: "tree", description: "Navigate the session tree", source: "builtin" },
  { name: "trust", description: "Save the project trust decision", source: "builtin" },
  { name: "login", description: "Configure provider authentication", source: "builtin" },
  { name: "logout", description: "Remove provider authentication", source: "builtin" },
  { name: "new", description: "Start a new session", source: "builtin" },
  { name: "compact", description: "Compact the session context", source: "builtin" },
  { name: "resume", description: "Browse Pi conversation history", source: "builtin" },
  { name: "reload", description: "Reload Pi resources", source: "builtin" },
  { name: "quit", description: "Quit Pi", source: "builtin" },
];

const COMMAND_SOURCE_LABELS: Record<ComposerCommandSource, string> = {
  builtin: "Pi",
  extension: "Extension",
  prompt: "Prompt",
  skill: "Skill",
};

const PREVIEW_NAME = new URLSearchParams(window.location.search).get("preview");
const UI_PREVIEW =
  import.meta.env.DEV &&
  ["conversation", "terminal", "permission"].includes(PREVIEW_NAME ?? "");
const TERMINAL_PREVIEW = UI_PREVIEW && PREVIEW_NAME === "terminal";
const TERMINAL_PREVIEW_DELAY_MS = TERMINAL_PREVIEW
  ? Math.max(
      0,
      Number(
        new URLSearchParams(window.location.search).get("previewDelay") ?? 420,
      ) || 420,
    )
  : 420;

function opensNativePiTerminal(value: string): boolean {
  const input = value.trim();
  return input.startsWith("/") && !input.includes("\n");
}

function slashCommandNameFromInput(value: string): string | null {
  return value.trim().match(/^\/([^\s/]+)/)?.[1]?.toLowerCase() ?? null;
}

function slashTokenAtCursor(value: string, cursor: number): SlashToken | null {
  const safeCursor = Math.min(Math.max(cursor, 0), value.length);
  const beforeCursor = value.slice(0, safeCursor);
  const start = beforeCursor.lastIndexOf("/");
  if (start < 0) return null;

  const previous = start > 0 ? value[start - 1] : "";
  if (previous && !/[\s([{]/.test(previous)) return null;

  const query = value.slice(start + 1, safeCursor);
  if (/\s/.test(query)) return null;

  let end = safeCursor;
  while (end < value.length && !/\s/.test(value[end])) end += 1;
  return { start, end, query: query.toLowerCase() };
}

function commandMatchScore(command: ComposerCommand, query: string): number {
  if (!query) return command.source === "builtin" ? 0 : 1;
  const name = command.name.toLowerCase();
  const description = command.description.toLowerCase();
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.split(":").some((part) => part.startsWith(query))) return 2;
  if (name.includes(query)) return 3;
  if (description.includes(query)) return 4;
  return Number.POSITIVE_INFINITY;
}

function normalizeInlineSkillInvocation(
  value: string,
  commands: readonly ComposerCommand[],
): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("/") || trimmed.includes("\n")) return trimmed;

  const knownSkills = new Set(
    commands
      .filter((command) => command.source === "skill")
      .map((command) => command.name.toLowerCase()),
  );
  for (const match of trimmed.matchAll(/\/skill:[^\s]+/gi)) {
    const token = match[0];
    const start = match.index ?? 0;
    const previous = start > 0 ? trimmed[start - 1] : "";
    const commandName = token.slice(1).toLowerCase();
    if (
      (previous && !/[\s([{]/.test(previous)) ||
      !knownSkills.has(commandName)
    ) {
      continue;
    }
    const before = trimmed.slice(0, start).trim();
    const after = trimmed.slice(start + token.length).trim();
    const argumentsText = [before, after].filter(Boolean).join(" ");
    return `${token}${argumentsText ? ` ${argumentsText}` : ""}`;
  }
  return trimmed;
}

function basename(path?: string): string {
  if (!path) return "";
  return path.replace(/\/$/, "").split("/").pop() ?? path;
}

function timestamp(value?: string): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sessionTitle(session: ConversationSession): string {
  return session.name?.trim() || session.firstMessage?.trim() || "Untitled conversation";
}

function formatSessionDate(value: number): string {
  if (!value) return "Unknown date";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(value);
}

function stateSessionKey(state: {
  sessionId?: string;
  sessionFile?: string;
}): string | null {
  return state.sessionId ?? state.sessionFile ?? null;
}

function formatNumber(value?: number | null): string {
  if (value === undefined || value === null) return "-";
  return new Intl.NumberFormat(undefined, { notation: "compact" }).format(value);
}

function formatCost(value?: number): string {
  if (value === undefined) return "-";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value < 0.01 ? 4 : 2,
  }).format(value);
}

function modelValue(model: PiModel): string {
  return `${encodeURIComponent(model.provider)}::${encodeURIComponent(model.id)}`;
}

function decodeModelValue(value: string): [string, string] | null {
  const separator = value.indexOf("::");
  if (separator < 0) return null;
  return [
    decodeURIComponent(value.slice(0, separator)),
    decodeURIComponent(value.slice(separator + 2)),
  ];
}

function FeatureGlyph({ feature }: { feature?: FeatureDescriptor }) {
  const icon = feature?.icon?.trim();
  if (icon && Array.from(icon).length <= 2 && !/^[\w.-]+$/.test(icon)) {
    return <span className="feature-emoji" aria-hidden="true">{icon}</span>;
  }
  return <PuzzlePiece size={15} weight="regular" aria-hidden="true" />;
}

function permissionCommand(request: ToolPermissionRequest): string {
  const command = request.input.command;
  if (typeof command === "string" && command.trim()) return command;
  const path = request.input.path;
  if (typeof path === "string" && path.trim()) return path;
  const preview = request.input.preview;
  if (typeof preview === "string" && preview.trim()) return preview;
  return request.summary;
}

function toolPermissionTitle(toolName: string): string {
  if (toolName === "bash") return "Pi wants to run a command";
  if (toolName === "write") return "Pi wants to write a file";
  if (toolName === "edit") return "Pi wants to edit a file";
  return `Pi wants to use ${toolName}`;
}

function ToolPermissionCard({
  request,
  working,
  onResolve,
}: {
  request: ToolPermissionRequest;
  working: boolean;
  onResolve: (decision: "allow" | "deny") => void;
}) {
  return (
    <section
      className="tool-permission-card"
      role="dialog"
      aria-modal="false"
      aria-labelledby={`tool-permission-${request.requestId}`}
    >
      <div className="tool-permission-heading">
        <ShieldWarning size={19} weight="fill" aria-hidden="true" />
        <div>
          <strong id={`tool-permission-${request.requestId}`}>
            {toolPermissionTitle(request.toolName)}
          </strong>
          <span>{request.cwd}</span>
        </div>
      </div>
      <pre><code>{permissionCommand(request)}</code></pre>
      {request.toolName !== "bash" && Object.keys(request.input).length > 1 && (
        <details>
          <summary>Show tool arguments</summary>
          <pre><code>{safeJson(request.input)}</code></pre>
        </details>
      )}
      <div className="tool-permission-actions">
        <span>Execution is paused until you decide.</span>
        <button
          type="button"
          className="text-button"
          disabled={working}
          onClick={() => onResolve("deny")}
        >
          Deny
        </button>
        <button
          type="button"
          className="permission-allow-button"
          disabled={working}
          onClick={() => onResolve("allow")}
        >
          {working ? "Applying..." : "Allow once"}
        </button>
      </div>
    </section>
  );
}

function MessageItem({ item }: { item: MessageFeedItem }) {
  const role = item.message.role ?? "assistant";
  const isUser = role === "user";
  const isToolResult = role === "toolResult";
  const hasError =
    item.message.isError === true ||
    item.message.stopReason === "error" ||
    (typeof item.message.errorMessage === "string" &&
      item.message.errorMessage.trim().length > 0);

  return (
    <article
      className={`message-row role-${isUser ? "user" : isToolResult ? "tool-result" : role} ${
        item.optimistic ? "is-optimistic" : ""
      } ${hasError ? "has-error" : ""}`}
    >
      <header className="message-meta">
        <span>{isUser ? "You" : isToolResult ? item.message.toolName || "Tool" : role === "assistant" ? "Pi" : role}</span>
        {item.optimistic && <span>Sending</span>}
        {hasError && <span>Failed</span>}
      </header>
      <div className="message-content">
        <MessageContent message={item.message} waiting={item.streaming} />
        {item.streaming && <span className="stream-caret" aria-label="Streaming" />}
      </div>
    </article>
  );
}

function ToolItem({ item }: { item: ToolFeedItem }) {
  const statusLabel =
    item.status === "approval"
      ? "Waiting for approval"
      : item.status === "running"
        ? "Running"
        : item.status === "error"
          ? "Failed"
          : "Done";
  return (
    <details className={`tool-run status-${item.status}`} open={item.status !== "done"}>
      <summary>
        <span className="tool-status-mark" aria-hidden="true">
          {item.status === "approval"
            ? "?"
            : item.status === "running"
              ? "..."
              : item.status === "error"
                ? "!"
                : "OK"}
        </span>
        <span className="tool-run-name">{item.name}</span>
        <span className="tool-run-status">{statusLabel}</span>
      </summary>
      <div className="tool-run-body">
        {item.args !== undefined && (
          <div>
            <span className="detail-label">Input</span>
            <pre>{safeJson(item.args)}</pre>
          </div>
        )}
        {item.result !== undefined && (
          <div>
            <span className="detail-label">Output</span>
            <pre>{safeJson(item.result)}</pre>
          </div>
        )}
      </div>
    </details>
  );
}

function UnknownEventItem({ item }: { item: EventFeedItem }) {
  return (
    <details className="unknown-event-row">
      <summary>
        <span>Extension event</span>
        <code>{item.event.type}</code>
      </summary>
      <pre>{safeJson(item.event)}</pre>
    </details>
  );
}

function FeedEntry({ item }: { item: FeedItem }) {
  if (item.kind === "message") return <MessageItem item={item} />;
  if (item.kind === "tool") return <ToolItem item={item} />;
  return <UnknownEventItem item={item} />;
}

function ConversationSkeleton() {
  return (
    <div className="conversation-skeleton" aria-label="Loading conversation">
      <div className="skeleton-line wide" />
      <div className="skeleton-line medium" />
      <div className="skeleton-block" />
      <div className="skeleton-line short" />
    </div>
  );
}

interface SessionDirectoryGroupProps {
  group: SessionGroup;
  collapsed: boolean;
  compact?: boolean;
  disabled: boolean;
  switchingPath: string | null;
  onToggle: (cwd: string) => void;
  onSelect: (session: ConversationSession) => void;
}

function SessionDirectoryGroup({
  group,
  collapsed,
  compact = false,
  disabled,
  switchingPath,
  onToggle,
  onSelect,
}: SessionDirectoryGroupProps) {
  const directoryId = `session-directory-${compact ? "sidebar" : "history"}-${encodeURIComponent(group.cwd)}`;
  return (
    <section
      className={`session-directory ${compact ? "is-compact" : "is-history"}`}
      data-workspace={group.cwd}
    >
      <button
        className="session-directory-heading"
        type="button"
        aria-expanded={!collapsed}
        aria-controls={directoryId}
        title={group.cwd}
        onClick={() => onToggle(group.cwd)}
      >
        {collapsed ? (
          <CaretRight size={13} weight="bold" aria-hidden="true" />
        ) : (
          <CaretDown size={13} weight="bold" aria-hidden="true" />
        )}
        <FolderOpen size={15} weight="regular" aria-hidden="true" />
        <div>
          <strong>{basename(group.cwd) || group.cwd}</strong>
          <span>{group.cwd}</span>
        </div>
        <span className="session-directory-count">{group.sessions.length}</span>
      </button>
      <div
        className={`session-directory-items ${collapsed ? "is-collapsed" : ""}`}
        id={directoryId}
        aria-hidden={collapsed}
      >
        <div className="session-directory-items-inner">
          {group.sessions.map((session) => {
            const switching =
              Boolean(session.path) && session.path === switchingPath;
            return (
              <button
                className={`session-item ${session.current ? "is-active" : ""}`}
                type="button"
                key={session.key}
                disabled={
                  switchingPath !== null || (!session.current && disabled)
                }
                tabIndex={collapsed ? -1 : undefined}
                aria-current={session.current ? "page" : undefined}
                aria-busy={switching}
                data-session-path={session.path}
                data-session-current={session.current}
                onClick={() => onSelect(session)}
                title={session.current ? "Current Pi conversation" : "Open this Pi conversation"}
              >
                <span className="session-name">{sessionTitle(session)}</span>
                <span className="session-detail">
                  {switching
                    ? "Opening…"
                    : session.current
                      ? `Current · ${session.messageCount} messages`
                      : compact
                        ? `${session.messageCount} messages`
                        : `${formatSessionDate(session.modified)} · ${session.messageCount} messages`}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function App() {
  const desktop = usePiDesktop();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<"context" | "events">("context");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarPinned, setSidebarPinned] = useState(
    () => window.localStorage.getItem("pi-desktop.sidebar-pinned") === "true",
  );
  const [historySessions, setHistorySessions] = useState<PiSessionInfo[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyQuery, setHistoryQuery] = useState("");
  const [collapsedDirectories, setCollapsedDirectories] = useState<Set<string>>(
    () => {
      try {
        const saved = JSON.parse(
          window.localStorage.getItem("pi-desktop.collapsed-directories") ?? "[]",
        );
        return new Set(Array.isArray(saved) ? saved.filter((item) => typeof item === "string") : []);
      } catch {
        return new Set();
      }
    },
  );
  const [historySearchCollapsedDirectories, setHistorySearchCollapsedDirectories] =
    useState<Set<string>>(() => new Set());
  const [creatingSession, setCreatingSession] = useState(false);
  const [switchingSessionPath, setSwitchingSessionPath] = useState<string | null>(null);
  const [workspaceSwitching, setWorkspaceSwitching] = useState(false);
  const [activeSurface, setActiveSurface] = useState<ActiveSurface>(null);
  const [composer, setComposer] = useState("");
  const [composerCursor, setComposerCursor] = useState(0);
  const [composerFocused, setComposerFocused] = useState(false);
  const [commandMenuDismissed, setCommandMenuDismissed] = useState(false);
  const [activeCommandIndex, setActiveCommandIndex] = useState(0);
  const [kernelCommands, setKernelCommands] = useState<PiSlashCommand[]>([]);
  const [composerMode, setComposerMode] = useState<ComposerMode>("steer");
  const [submitting, setSubmitting] = useState(false);
  const [nativeTerminal, setNativeTerminal] =
    useState<NativeTerminalRequest | null>(null);
  const [nativeTerminalReady, setNativeTerminalReady] = useState(false);
  const [terminalError, setTerminalError] = useState<string | null>(null);
  const [resolvingPermission, setResolvingPermission] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const stickToBottomRef = useRef(true);
  const newSessionPreviousKeyRef = useRef<string | null>(null);
  const newSessionPreviousEventIdRef = useRef<string | null>(null);
  const newSessionTimerRef = useRef<number | null>(null);
  const newSessionPendingRef = useRef(false);
  const sessionSwitchTimerRef = useRef<number | null>(null);
  const sessionSwitchPendingRef = useRef(false);
  const sessionSwitchPreviousEventIdRef = useRef<string | null>(null);

  const connected = desktop.kernel.status === "connected";
  const streaming = desktop.piState.isStreaming === true;
  const projectRoot =
    desktop.piState.cwd ||
    desktop.kernel.cwd ||
    desktop.settings.defaultCwd ||
    undefined;
  const currentSessionCwd = projectRoot || "";
  const currentSessionKey = stateSessionKey(desktop.piState);
  const featureHost = useFeatureCatalog(projectRoot);
  const authoringSkill = useAuthoringSkill(activeSurface?.type === "manager");
  const currentHistorySession = historySessions.find(
    (session) =>
      (desktop.piState.sessionFile &&
        session.path === desktop.piState.sessionFile) ||
      (desktop.piState.sessionId && session.id === desktop.piState.sessionId),
  );
  const currentSessionName =
    desktop.piState.sessionName ||
    currentHistorySession?.name ||
    currentHistorySession?.firstMessage ||
    basename(currentSessionCwd) ||
    "New session";
  const currentModel = desktop.piState.model ?? null;
  const currentModelValue = currentModel ? modelValue(currentModel) : "";
  const pendingCount = desktop.queue.steering.length + desktop.queue.followUp.length;
  const activeToolPermission = desktop.toolPermissionRequests[0] ?? null;
  const feedMessageCount = useMemo(
    () => desktop.feed.filter((item) => item.kind === "message").length,
    [desktop.feed],
  );
  const sidebarVisible = sidebarPinned || sidebarOpen;
  const visibleError = terminalError ?? desktop.error;
  const activeFeature =
    activeSurface?.type === "feature"
      ? featureHost.catalog.features.find(
          (feature) => feature.id === activeSurface.featureId,
        ) ?? null
      : null;
  const activeStarterUpdate = activeFeature
    ? featureHost.catalog.starters.find(
        (starter) =>
          starter.id === activeFeature.id && starter.updateAvailable,
      ) ?? null
    : null;
  const featureContext: FeatureHostContext | null = activeFeature
    ? {
        apiVersion: 1,
        feature: {
          id: activeFeature.id,
          name: activeFeature.name,
          source: activeFeature.source,
          version: activeFeature.version,
          publisher: activeFeature.publisher,
        },
        workspace: { cwd: projectRoot ?? "" },
        pi: {
          kernel: desktop.kernel,
          state: desktop.piState,
        },
        theme: { colorScheme: "dark" },
      }
    : null;

  const conversations = useMemo<ConversationSession[]>(() => {
    let foundCurrent = false;
    const listed: ConversationSession[] = historySessions.map((session) => {
      const current = Boolean(
        connected &&
          ((desktop.piState.sessionFile &&
            session.path === desktop.piState.sessionFile) ||
            (desktop.piState.sessionId && session.id === desktop.piState.sessionId)),
      );
      if (current) foundCurrent = true;
      return {
        key: session.path,
        id: session.id,
        path: session.path,
        cwd: current ? currentSessionCwd || session.cwd : session.cwd,
        name: current ? desktop.piState.sessionName ?? session.name : session.name,
        firstMessage: session.firstMessage,
        modified: timestamp(session.modified),
        messageCount: current
          ? Math.max(desktop.piState.messageCount ?? 0, feedMessageCount)
          : session.messageCount,
        current,
      };
    });

    if (connected && currentSessionKey && currentSessionCwd && !foundCurrent) {
      listed.unshift({
        key: `current:${currentSessionKey}`,
        id: desktop.piState.sessionId,
        path: desktop.piState.sessionFile,
        cwd: currentSessionCwd,
        name: desktop.piState.sessionName,
        modified: Date.now(),
        messageCount: Math.max(
          desktop.piState.messageCount ?? 0,
          feedMessageCount,
        ),
        current: true,
      });
    }
    return listed;
  }, [
    connected,
    currentSessionCwd,
    currentSessionKey,
    desktop.piState.messageCount,
    desktop.piState.sessionFile,
    desktop.piState.sessionId,
    desktop.piState.sessionName,
    feedMessageCount,
    historySessions,
  ]);

  const groupSessions = useCallback((sessions: ConversationSession[]) => {
    const groups = new Map<string, ConversationSession[]>();
    for (const session of sessions) {
      if (!session.cwd) continue;
      const group = groups.get(session.cwd) ?? [];
      group.push(session);
      groups.set(session.cwd, group);
    }
    return [...groups.entries()]
      .map(([cwd, group]) => ({
        cwd,
        sessions: [...group].sort(
          (left, right) =>
            Number(right.current) - Number(left.current) ||
            right.modified - left.modified,
        ),
      }))
      .sort(
        (left, right) =>
          Number(right.sessions.some((session) => session.current)) -
            Number(left.sessions.some((session) => session.current)) ||
          (right.sessions[0]?.modified ?? 0) -
            (left.sessions[0]?.modified ?? 0),
      );
  }, []);

  const sessionGroups = useMemo(
    () => groupSessions(conversations),
    [conversations, groupSessions],
  );

  const historySessionGroups = useMemo(() => {
    const query = historyQuery.trim().toLowerCase();
    if (!query) return sessionGroups;
    return groupSessions(
      conversations.filter((session) =>
        [sessionTitle(session), session.firstMessage ?? "", session.cwd]
          .join("\n")
          .toLowerCase()
          .includes(query),
      ),
    );
  }, [conversations, groupSessions, historyQuery, sessionGroups]);

  const sessionTransitioning =
    creatingSession || switchingSessionPath !== null || workspaceSwitching;

  const visibleModels = useMemo(
    () =>
      [...desktop.models].sort((left, right) =>
        `${left.provider}/${left.name ?? left.id}`.localeCompare(
          `${right.provider}/${right.name ?? right.id}`,
        ),
      ),
    [desktop.models],
  );

  const composerCommands = useMemo<ComposerCommand[]>(() => {
    const seen = new Set<string>();
    return [
      ...BUILTIN_PI_COMMANDS,
      ...kernelCommands.map((command) => ({
        name: command.name,
        description: command.description?.trim() || "Pi command",
        source: command.source,
      })),
    ].filter((command) => {
      const key = command.name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [kernelCommands]);

  const activeSlashToken = useMemo(
    () => slashTokenAtCursor(composer, composerCursor),
    [composer, composerCursor],
  );

  const commandCandidates = useMemo(() => {
    if (!activeSlashToken) return [];
    const isInline = composer.slice(0, activeSlashToken.start).trim().length > 0;
    return composerCommands
      .filter((command) => !isInline || command.source === "skill")
      .map((command, order) => ({
        command,
        order,
        score: commandMatchScore(command, activeSlashToken.query),
      }))
      .filter((candidate) => Number.isFinite(candidate.score))
      .sort(
        (left, right) => left.score - right.score || left.order - right.order,
      )
      .slice(0, 60)
      .map((candidate) => candidate.command);
  }, [activeSlashToken, composer, composerCommands]);

  const inlineSlashMenu =
    activeSlashToken !== null &&
    composer.slice(0, activeSlashToken.start).trim().length > 0;

  const commandMenuVisible =
    composerFocused && activeSlashToken !== null && !commandMenuDismissed;

  const refreshHistory = useCallback(async () => {
    if (!connected) return;
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      setHistorySessions(await desktop.listSessions());
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : String(error));
    } finally {
      setHistoryLoading(false);
    }
  }, [connected, desktop.listSessions]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, 42), 160)}px`;
  }, [composer]);

  useEffect(() => {
    if (!connected) {
      setKernelCommands([]);
      return;
    }
    let disposed = false;
    void desktop
      .getCommands()
      .then((commands) => {
        if (!disposed) setKernelCommands(commands);
      })
      .catch(() => {
        if (!disposed) setKernelCommands([]);
      });
    return () => {
      disposed = true;
    };
  }, [connected, desktop.getCommands, desktop.piState.sessionId]);

  useEffect(() => {
    setActiveCommandIndex(0);
  }, [activeSlashToken?.query]);

  useEffect(() => {
    if (!commandMenuVisible || commandCandidates.length === 0) return;
    const boundedIndex = Math.min(
      activeCommandIndex,
      commandCandidates.length - 1,
    );
    if (boundedIndex !== activeCommandIndex) {
      setActiveCommandIndex(boundedIndex);
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      document
        .getElementById(`composer-command-${boundedIndex}`)
        ?.scrollIntoView({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeCommandIndex, commandCandidates.length, commandMenuVisible]);

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      const container = scrollRef.current;
      if (container) container.scrollTop = container.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [desktop.feed]);

  useEffect(() => {
    if (!settingsOpen) return;
    setSidebarOpen(false);
  }, [settingsOpen]);

  useEffect(() => {
    if (!historyOpen) return;
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape" || switchingSessionPath !== null) return;
      event.preventDefault();
      setHistoryOpen(false);
      focusComposer();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [historyOpen, switchingSessionPath]);

  useEffect(() => {
    window.localStorage.setItem(
      "pi-desktop.sidebar-pinned",
      String(sidebarPinned),
    );
  }, [sidebarPinned]);

  useEffect(() => {
    window.localStorage.setItem(
      "pi-desktop.collapsed-directories",
      JSON.stringify([...collapsedDirectories]),
    );
  }, [collapsedDirectories]);

  useEffect(() => {
    setHistorySearchCollapsedDirectories(new Set());
  }, [historyQuery]);

  useEffect(() => {
    if (!connected) {
      setHistorySessions([]);
      setHistoryOpen(false);
      return;
    }
    void refreshHistory();
  }, [
    connected,
    desktop.kernel.cwd,
    desktop.piState.sessionId,
    refreshHistory,
  ]);

  useEffect(() => {
    if (!creatingSession || !newSessionPendingRef.current) return;
    const markerIndex = newSessionPreviousEventIdRef.current
      ? desktop.rpcLog.findIndex(
          (entry) => entry.id === newSessionPreviousEventIdRef.current,
        )
      : -1;
    const transitioned = desktop.rpcLog.slice(markerIndex + 1).some(
      (entry) =>
        (entry.event.type === "session_start" ||
          entry.event.type === "bridge_ready"),
    );
    const changed =
      currentSessionKey !== null &&
      currentSessionKey !== newSessionPreviousKeyRef.current;
    if (!transitioned && !changed) return;

    newSessionPendingRef.current = false;
    if (newSessionTimerRef.current !== null) {
      window.clearTimeout(newSessionTimerRef.current);
      newSessionTimerRef.current = null;
    }
    setCreatingSession(false);
    setActiveSurface(null);
    focusComposer();
  }, [creatingSession, currentSessionKey, desktop.rpcLog]);

  useEffect(() => {
    if (!switchingSessionPath || !sessionSwitchPendingRef.current) return;
    const markerIndex = sessionSwitchPreviousEventIdRef.current
      ? desktop.rpcLog.findIndex(
          (entry) => entry.id === sessionSwitchPreviousEventIdRef.current,
        )
      : -1;
    const failure = desktop.rpcLog.slice(markerIndex + 1).find(
      (entry) =>
        entry.event.type === "bridge_error" &&
        entry.event.operation === "switch_session" &&
        entry.event.sessionPath === switchingSessionPath,
    );
    if (failure) {
      sessionSwitchPendingRef.current = false;
      if (sessionSwitchTimerRef.current !== null) {
        window.clearTimeout(sessionSwitchTimerRef.current);
        sessionSwitchTimerRef.current = null;
      }
      setSwitchingSessionPath(null);
      setHistoryError(
        typeof failure.event.message === "string"
          ? failure.event.message
          : "Pi could not open that conversation.",
      );
      return;
    }
    if (desktop.piState.sessionFile !== switchingSessionPath) return;

    sessionSwitchPendingRef.current = false;
    if (sessionSwitchTimerRef.current !== null) {
      window.clearTimeout(sessionSwitchTimerRef.current);
      sessionSwitchTimerRef.current = null;
    }
    setSwitchingSessionPath(null);
    setHistoryOpen(false);
    setActiveSurface(null);
    void refreshHistory();
    focusComposer();
  }, [
    desktop.piState.sessionFile,
    desktop.rpcLog,
    refreshHistory,
    switchingSessionPath,
  ]);

  useEffect(
    () => () => {
      if (newSessionTimerRef.current !== null) {
        window.clearTimeout(newSessionTimerRef.current);
      }
      if (sessionSwitchTimerRef.current !== null) {
        window.clearTimeout(sessionSwitchTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (!TERMINAL_PREVIEW) return;
    const timer = window.setTimeout(() => {
      setNativeTerminal({ initialInput: "/model" });
    }, TERMINAL_PREVIEW_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (
      activeSurface?.type === "feature" &&
      !featureHost.loading &&
      !featureHost.catalog.features.some(
        (feature) => feature.id === activeSurface.featureId,
      )
    ) {
      setActiveSurface({ type: "manager" });
    }
  }, [activeSurface, featureHost.catalog.features, featureHost.loading]);

  function updateStickiness() {
    const container = scrollRef.current;
    if (!container) return;
    stickToBottomRef.current =
      container.scrollHeight - container.scrollTop - container.clientHeight < 120;
  }

  function focusComposer() {
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  }

  async function submitMessage() {
    if (!composer.trim() || submitting || !connected || sessionTransitioning) return;
    const text = composer.trim();
    const piInput = normalizeInlineSkillInvocation(text, composerCommands);
    if (opensNativePiTerminal(piInput)) {
      const commandName = slashCommandNameFromInput(piInput);
      if (commandName === "resume") {
        const query = piInput.slice("/resume".length).trim();
        setComposer("");
        setComposerCursor(0);
        setHistoryQuery(query);
        openHistoryBrowser();
        return;
      }
      if (commandName === "new" && piInput === "/new") {
        setComposer("");
        setComposerCursor(0);
        startNewSession();
        return;
      }
      const command = commandName
        ? composerCommands.find(
            (candidate) => candidate.name.toLowerCase() === commandName,
          )
        : undefined;
      setTerminalError(null);
      setComposer("");
      setComposerCursor(0);
      setNativeTerminal({
        initialInput: piInput,
        closeOnAgentStart:
          commandName?.startsWith("skill:") === true ||
          command?.source === "skill" ||
          command?.source === "prompt",
      });
      return;
    }
    setSubmitting(true);
    try {
      await desktop.sendMessage(text, composerMode);
      setComposer("");
      stickToBottomRef.current = true;
    } catch {
      // The failed optimistic message and contextual error are rendered by the hook.
    } finally {
      setSubmitting(false);
      textareaRef.current?.focus();
    }
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (commandMenuVisible && commandCandidates.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveCommandIndex(
          (current) => (current + 1) % commandCandidates.length,
        );
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveCommandIndex(
          (current) =>
            (current - 1 + commandCandidates.length) %
            commandCandidates.length,
        );
        return;
      }
      if (
        (event.key === "Enter" || event.key === "Tab") &&
        !event.shiftKey &&
        !event.nativeEvent.isComposing
      ) {
        event.preventDefault();
        selectComposerCommand(
          commandCandidates[
            Math.min(activeCommandIndex, commandCandidates.length - 1)
          ],
        );
        return;
      }
    }
    if (commandMenuVisible && event.key === "Escape") {
      event.preventDefault();
      setCommandMenuDismissed(true);
      return;
    }
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      void submitMessage();
    }
  }

  function onComposerChange(value: string, cursor: number) {
    setComposer(value);
    setComposerCursor(cursor);
    setCommandMenuDismissed(false);
  }

  function selectComposerCommand(command: ComposerCommand) {
    const token = slashTokenAtCursor(composer, composerCursor);
    if (!token) return;

    const suffix = composer.slice(token.end);
    const insertion = `/${command.name}`;
    const separator = suffix.startsWith(" ") ? "" : " ";
    const nextComposer =
      composer.slice(0, token.start) + insertion + separator + suffix;
    const nextCursor =
      token.start + insertion.length + (separator ? 1 : suffix.startsWith(" ") ? 1 : 0);

    setComposer(nextComposer);
    setComposerCursor(nextCursor);
    setCommandMenuDismissed(true);
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      textarea?.focus();
      textarea?.setSelectionRange(nextCursor, nextCursor);
    });
  }

  function connect() {
    if (!nativeTerminalReady || workspaceSwitching) return;
    void desktop.connect().catch(() => undefined);
  }

  function closeSidebarAfterNavigation() {
    if (!sidebarPinned) setSidebarOpen(false);
  }

  function startNewSession() {
    if (sessionTransitioning || !connected || streaming || nativeTerminal !== null) return;
    setTerminalError(null);
    setActiveSurface(null);
    setHistoryOpen(false);
    closeSidebarAfterNavigation();
    newSessionPreviousKeyRef.current = currentSessionKey;
    newSessionPreviousEventIdRef.current =
      desktop.rpcLog[desktop.rpcLog.length - 1]?.id ?? null;
    newSessionPendingRef.current = true;
    setCreatingSession(true);
    newSessionTimerRef.current = window.setTimeout(() => {
      if (!newSessionPendingRef.current) return;
      newSessionPendingRef.current = false;
      newSessionTimerRef.current = null;
      setCreatingSession(false);
      setTerminalError(
        "Pi did not confirm the new session. The current conversation was left unchanged.",
      );
    }, 10_000);
    void desktop.createResidentSession().catch((error: unknown) => {
      newSessionPendingRef.current = false;
      if (newSessionTimerRef.current !== null) {
        window.clearTimeout(newSessionTimerRef.current);
        newSessionTimerRef.current = null;
      }
      setCreatingSession(false);
      setTerminalError(error instanceof Error ? error.message : String(error));
    });
  }

  function openHistoryBrowser() {
    if (!connected || streaming || nativeTerminal !== null || sessionTransitioning) return;
    setTerminalError(null);
    setActiveSurface(null);
    setHistoryOpen(true);
    void refreshHistory();
    closeSidebarAfterNavigation();
  }

  function toggleSessionDirectory(cwd: string) {
    setCollapsedDirectories((current) => {
      const next = new Set(current);
      if (next.has(cwd)) next.delete(cwd);
      else next.add(cwd);
      return next;
    });
  }

  function toggleHistoryDirectory(cwd: string) {
    if (!historyQuery.trim()) {
      toggleSessionDirectory(cwd);
      return;
    }
    setHistorySearchCollapsedDirectories((current) => {
      const next = new Set(current);
      if (next.has(cwd)) next.delete(cwd);
      else next.add(cwd);
      return next;
    });
  }

  function selectConversation(session: ConversationSession) {
    if (session.current) {
      returnToChat();
      return;
    }
    if (
      !session.path ||
      !connected ||
      streaming ||
      nativeTerminal !== null ||
      sessionTransitioning
    ) {
      return;
    }

    setHistoryError(null);
    setTerminalError(null);
    closeSidebarAfterNavigation();
    sessionSwitchPreviousEventIdRef.current =
      desktop.rpcLog[desktop.rpcLog.length - 1]?.id ?? null;
    sessionSwitchPendingRef.current = true;
    setSwitchingSessionPath(session.path);
    sessionSwitchTimerRef.current = window.setTimeout(() => {
      if (!sessionSwitchPendingRef.current) return;
      sessionSwitchPendingRef.current = false;
      sessionSwitchTimerRef.current = null;
      setSwitchingSessionPath(null);
      setHistoryError(
        "Pi did not confirm the conversation switch. The current conversation was left unchanged.",
      );
    }, 12_000);

    void desktop
      .switchSession(session.path)
      .then((result) => {
        if (!result.alreadyCurrent || !sessionSwitchPendingRef.current) return;
        sessionSwitchPendingRef.current = false;
        if (sessionSwitchTimerRef.current !== null) {
          window.clearTimeout(sessionSwitchTimerRef.current);
          sessionSwitchTimerRef.current = null;
        }
        setSwitchingSessionPath(null);
        setHistoryOpen(false);
        setActiveSurface(null);
        focusComposer();
      })
      .catch((error: unknown) => {
        sessionSwitchPendingRef.current = false;
        if (sessionSwitchTimerRef.current !== null) {
          window.clearTimeout(sessionSwitchTimerRef.current);
          sessionSwitchTimerRef.current = null;
        }
        setSwitchingSessionPath(null);
        setHistoryError(error instanceof Error ? error.message : String(error));
      });
  }

  async function chooseWorkspace() {
    if (streaming || nativeTerminal !== null || sessionTransitioning) return;
    let selected: string | string[] | null;
    try {
      selected = UI_PREVIEW
        ? projectRoot === "/Users/anson/website"
          ? "/Users/anson/project"
          : "/Users/anson/website"
        : await openDialog({
            directory: true,
            multiple: false,
            title: "Choose Pi workspace",
            defaultPath: projectRoot,
          });
    } catch (error) {
      setTerminalError(error instanceof Error ? error.message : String(error));
      return;
    }
    const selectedPath = Array.isArray(selected) ? selected[0] : selected;
    if (!selectedPath || selectedPath === projectRoot) return;

    setWorkspaceSwitching(true);
    setTerminalError(null);
    setHistoryError(null);
    setHistoryOpen(false);
    setActiveSurface(null);
    setInspectorOpen(false);
    closeSidebarAfterNavigation();
    try {
      await desktop.switchWorkspace(selectedPath);
      await refreshHistory();
      focusComposer();
    } catch (error) {
      setTerminalError(error instanceof Error ? error.message : String(error));
    } finally {
      setWorkspaceSwitching(false);
    }
  }

  function openFeature(featureId: string) {
    if (featureHost.loading || nativeTerminal !== null || sessionTransitioning) return;
    setHistoryOpen(false);
    setActiveSurface({ type: "feature", featureId });
    setInspectorOpen(false);
    closeSidebarAfterNavigation();
  }

  function openFeatureManager() {
    if (nativeTerminal !== null || sessionTransitioning) return;
    setHistoryOpen(false);
    setActiveSurface({ type: "manager" });
    setInspectorOpen(false);
    closeSidebarAfterNavigation();
  }

  function returnToChat() {
    setHistoryOpen(false);
    setActiveSurface(null);
    closeSidebarAfterNavigation();
    focusComposer();
  }

  function toggleSidebarPinned() {
    if (sidebarPinned) {
      setSidebarPinned(false);
      setSidebarOpen(false);
      return;
    }
    setSidebarPinned(true);
    setSidebarOpen(false);
  }

  function toggleSidebar() {
    if (sidebarPinned) {
      setSidebarPinned(false);
      setSidebarOpen(false);
      return;
    }
    setSidebarOpen((open) => !open);
  }

  function reloadActiveFeature() {
    if (!activeFeature) {
      featureHost.reload();
      return;
    }
    void desktopApi
      .stopFeatureService(activeFeature.id, projectRoot)
      .catch(() => undefined)
      .finally(featureHost.reload);
  }

  function resolveToolPermission(decision: "allow" | "deny") {
    if (!activeToolPermission || resolvingPermission) return;
    const requestId = activeToolPermission.requestId;
    setResolvingPermission(requestId);
    void desktop
      .resolveToolPermission(requestId, decision)
      .catch(() => undefined)
      .finally(() => setResolvingPermission(null));
  }

  const appClass = `app-frame ${sidebarPinned ? "has-sidebar-pinned" : ""}`;

  return (
    <div className={appClass}>
      <div className="titlebar" data-tauri-drag-region>
        <span className="titlebar-name" data-tauri-drag-region>Pi</span>
        <div className="titlebar-status" data-tauri-drag-region>
          <span
            className={`status-dot status-${desktop.kernel.status}`}
            aria-hidden="true"
            data-tauri-drag-region
          />
          <span data-tauri-drag-region>
            {currentModel?.name ?? currentModel?.id ?? "No model"}
          </span>
        </div>
      </div>

      <div className={`workspace ${sidebarPinned ? "has-sidebar-pinned" : ""}`}>
        <button
          className={`panel-backdrop ${
            (sidebarOpen && !sidebarPinned) || inspectorOpen ? "is-visible" : ""
          }`}
          type="button"
          aria-label="Close panel"
          onClick={() => {
            setSidebarOpen(false);
            setInspectorOpen(false);
          }}
        />

        <aside
          className={`session-sidebar ${sidebarVisible ? "is-open" : ""} ${
            sidebarPinned ? "is-pinned" : ""
          }`}
        >
          <div className="sidebar-toolbar">
            <button
              className="new-session-button"
              type="button"
              disabled={
                !connected ||
                desktop.refreshing ||
                sessionTransitioning ||
                streaming ||
                nativeTerminal !== null
              }
              onClick={startNewSession}
            >
              <Plus size={14} weight="regular" aria-hidden="true" />
              {creatingSession ? "Starting…" : "New session"}
            </button>
            <button
              className={`sidebar-pin-button ${sidebarPinned ? "is-active" : ""}`}
              type="button"
              aria-label={sidebarPinned ? "Unpin sidebar" : "Pin sidebar"}
              aria-pressed={sidebarPinned}
              onClick={toggleSidebarPinned}
            >
              <PushPinSimple
                size={15}
                weight={sidebarPinned ? "fill" : "regular"}
                aria-hidden="true"
              />
            </button>
          </div>

          <button
            className="workspace-picker-button"
            type="button"
            disabled={streaming || nativeTerminal !== null || sessionTransitioning}
            onClick={() => void chooseWorkspace()}
            title={projectRoot || "Choose a Pi workspace"}
          >
            <FolderOpen size={16} weight="regular" aria-hidden="true" />
            <span className="workspace-picker-copy">
              <strong>{workspaceSwitching ? "Switching…" : basename(projectRoot) || "Choose workspace"}</strong>
              <span>{projectRoot || "Select a folder for Pi"}</span>
            </span>
            <span className="workspace-picker-action">Change</span>
          </button>

          <nav className="session-list" aria-label="Workspace navigation">
            <div className="sidebar-label">Conversations</div>
            {connected && sessionGroups.length > 0 ? (
              <div className="session-groups">
                {sessionGroups.map((group) => (
                  <SessionDirectoryGroup
                    key={group.cwd}
                    group={group}
                    compact
                    collapsed={collapsedDirectories.has(group.cwd)}
                    disabled={
                      streaming || nativeTerminal !== null || sessionTransitioning
                    }
                    switchingPath={switchingSessionPath}
                    onToggle={toggleSessionDirectory}
                    onSelect={selectConversation}
                  />
                ))}
                <button
                  className="browse-sessions-button"
                  type="button"
                  disabled={
                    streaming || nativeTerminal !== null || sessionTransitioning
                  }
                  onClick={openHistoryBrowser}
                >
                  <Chats size={14} weight="regular" aria-hidden="true" />
                  <span>Browse Pi history</span>
                  {historyLoading && <span className="inline-status">Loading…</span>}
                </button>
              </div>
            ) : (
              <div className="sidebar-empty">
                {connected
                  ? "Waiting for Pi session details…"
                  : "Connect Pi to start a session."}
              </div>
            )}

            <div className="sidebar-feature-group">
              <div className="sidebar-label">
                <span>Features</span>
                {featureHost.loading && <span className="sidebar-label-status">Scanning</span>}
              </div>
              {featureHost.catalog.features.map((feature) => {
                const updateAvailable = featureHost.catalog.starters.some(
                  (starter) =>
                    starter.id === feature.id && starter.updateAvailable,
                );
                return (
                  <button
                    key={feature.id}
                    className={`feature-nav-item ${
                      activeSurface?.type === "feature" &&
                      activeSurface.featureId === feature.id
                        ? "is-active"
                        : ""
                    }`}
                    type="button"
                    disabled={
                      featureHost.loading ||
                      nativeTerminal !== null ||
                      sessionTransitioning
                    }
                    onClick={() => openFeature(feature.id)}
                  >
                    <FeatureGlyph feature={feature} />
                    <span>{feature.name}</span>
                    {updateAvailable && (
                      <span className="feature-update-badge">Update</span>
                    )}
                  </button>
                );
              })}
              <button
                className={`feature-nav-item ${
                  activeSurface?.type === "manager" ? "is-active" : ""
                }`}
                type="button"
                disabled={nativeTerminal !== null || sessionTransitioning}
                onClick={openFeatureManager}
              >
                <FeatureGlyph />
                <span>Plugins</span>
                {featureHost.catalog.errors.length > 0 && (
                  <span className="feature-error-badge">
                    {featureHost.catalog.errors.length}
                  </span>
                )}
              </button>
            </div>
          </nav>

          <div className="sidebar-footer">
            <div className="kernel-summary">
              <span
                className={`status-dot status-${desktop.kernel.status}`}
                aria-hidden="true"
              />
              <div>
                <strong>
                  {desktop.kernel.status === "connected"
                    ? "Pi connected"
                    : desktop.kernel.status === "connecting"
                      ? "Connecting"
                      : desktop.kernel.status === "error"
                        ? "Connection error"
                        : "Pi offline"}
                </strong>
                <span>
                  {desktop.kernel.version || basename(desktop.kernel.executable) || "Pi kernel"}
                </span>
              </div>
            </div>
            {!connected && (
              <button
                className="sidebar-connect-button"
                type="button"
                onClick={connect}
                disabled={
                  desktop.kernel.status === "connecting" ||
                  workspaceSwitching ||
                  !nativeTerminalReady
                }
              >
                {desktop.kernel.status === "connecting" ? "Connecting..." : "Connect Pi"}
              </button>
            )}
            <button
              className="sidebar-settings-button"
              type="button"
              disabled={workspaceSwitching}
              onClick={() => setSettingsOpen(true)}
            >
              <GearSix size={14} weight="regular" aria-hidden="true" />
              Settings
            </button>
          </div>
        </aside>

        <main className="conversation-column">
          <header className="conversation-header">
            <div className="conversation-identity">
              <button
                className="glyph-button panel-button"
                type="button"
                aria-label={sidebarVisible ? "Close navigation" : "Open navigation"}
                aria-pressed={sidebarVisible}
                onClick={toggleSidebar}
              >
                <SidebarSimple size={17} weight="regular" aria-hidden="true" />
              </button>
              <div>
                <h1>{currentSessionName}</h1>
                <span>
                  {currentSessionCwd || "No working directory"}
                </span>
              </div>
            </div>

            <div className="header-controls">
              <label className="compact-select model-select">
                <span className="visually-hidden">Model</span>
                <select
                  value={currentModelValue}
                  disabled={
                    !connected ||
                    streaming ||
                    sessionTransitioning ||
                    visibleModels.length === 0
                  }
                  onChange={(event) => {
                    const selection = decodeModelValue(event.currentTarget.value);
                    if (selection) {
                      void desktop.selectModel(selection[0], selection[1]).catch(() => undefined);
                    }
                  }}
                  aria-label="Model"
                >
                  {!currentModel && <option value="">Select model</option>}
                  {visibleModels.map((model) => (
                    <option key={`${model.provider}/${model.id}`} value={modelValue(model)}>
                      {model.name ?? model.id} ({model.provider})
                    </option>
                  ))}
                </select>
              </label>

              <label className="compact-select thinking-select">
                <span className="visually-hidden">Thinking level</span>
                <select
                  value={desktop.piState.thinkingLevel ?? "off"}
                  disabled={
                    !connected ||
                    streaming ||
                    sessionTransitioning ||
                    desktop.thinkingLevels.length <= 1
                  }
                  onChange={(event) =>
                    void desktop
                      .selectThinkingLevel(event.currentTarget.value)
                      .catch(() => undefined)
                  }
                  aria-label="Thinking level"
                >
                  {desktop.thinkingLevels.map((level) => (
                    <option key={level} value={level}>
                      Think: {level}
                    </option>
                  ))}
                </select>
              </label>

              <button
                className={`glyph-button inspector-button ${inspectorOpen ? "is-active" : ""}`}
                type="button"
                aria-pressed={inspectorOpen}
                aria-label="Open inspector"
                onClick={() => setInspectorOpen((open) => !open)}
              >
                <SlidersHorizontal size={17} weight="regular" aria-hidden="true" />
              </button>
            </div>
          </header>

          {visibleError && (
            <div className="error-banner" role="alert">
              <span>{visibleError}</span>
              <button
                className="glyph-button"
                type="button"
                aria-label="Dismiss error"
                onClick={() => {
                  if (terminalError) setTerminalError(null);
                  else desktop.clearError();
                }}
              >
                <X size={15} weight="regular" aria-hidden="true" />
              </button>
            </div>
          )}

          <div
            className="conversation-scroll"
            ref={scrollRef}
            onScroll={updateStickiness}
          >
            {workspaceSwitching ? (
              <section className="connection-state" aria-live="polite">
                <div className="pi-mark" aria-hidden="true">pi</div>
                <h2>Switching workspace…</h2>
                <p>Restarting your external Pi in the selected folder.</p>
              </section>
            ) : desktop.initializing || (desktop.refreshing && desktop.feed.length === 0) ? (
              <ConversationSkeleton />
            ) : !connected && !nativeTerminal ? (
              <section className="connection-state">
                <div className="pi-mark" aria-hidden="true">
                  pi
                </div>
                <h2>Connect the Pi kernel</h2>
                <p>Start your installed Pi as the resident kernel and native TUI.</p>
                {desktop.kernel.error && (
                  <div className="connection-error">{desktop.kernel.error}</div>
                )}
                <div className="connection-actions">
                  <button
                    className="primary-button"
                    type="button"
                    onClick={connect}
                    disabled={
                      desktop.kernel.status === "connecting" || !nativeTerminalReady
                      || workspaceSwitching
                    }
                  >
                    {desktop.kernel.status === "connecting" ? "Connecting..." : "Connect Pi"}
                  </button>
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => setSettingsOpen(true)}
                  >
                    <GearSix size={14} weight="regular" aria-hidden="true" />
                    Kernel settings
                  </button>
                </div>
              </section>
            ) : desktop.feed.length === 0 ? (
              <section className="empty-conversation">
                <div className="pi-mark compact" aria-hidden="true">
                  pi
                </div>
                <h2>What should Pi work on?</h2>
                <p>{currentSessionCwd || "Choose a working directory in Settings."}</p>
              </section>
            ) : (
              <div className="conversation-feed">
                {desktop.feed.map((item) => (
                  <FeedEntry key={item.id} item={item} />
                ))}
              </div>
            )}
          </div>

          {connected && nativeTerminal && activeToolPermission && (
            <div className="terminal-permission-overlay">
              <ToolPermissionCard
                request={activeToolPermission}
                working={resolvingPermission === activeToolPermission.requestId}
                onResolve={resolveToolPermission}
              />
            </div>
          )}

          <footer
            className={`composer-region resident-terminal-region ${
              nativeTerminal ? "is-native-terminal" : "is-terminal-parked"
            }`}
          >
            <NativePiTerminal
              active={nativeTerminal !== null}
              initialInput={nativeTerminal?.initialInput ?? ""}
              closeOnAgentStart={nativeTerminal?.closeOnAgentStart}
              preview={UI_PREVIEW}
              onReady={() => setNativeTerminalReady(true)}
              onDone={() => {
                setNativeTerminal(null);
                void desktop
                  .getCommands()
                  .then(setKernelCommands)
                  .catch(() => undefined);
                focusComposer();
              }}
              onError={setTerminalError}
            />
          </footer>

          {connected && !nativeTerminal ? (
            <footer className="composer-region">
              {activeToolPermission && (
                <ToolPermissionCard
                  request={activeToolPermission}
                  working={resolvingPermission === activeToolPermission.requestId}
                  onResolve={resolveToolPermission}
                />
              )}
              {(streaming || pendingCount > 0) && (
                <div className="stream-controls">
                  <div className="segmented-control" aria-label="Queue behavior">
                    <button
                      type="button"
                      className={composerMode === "steer" ? "is-selected" : ""}
                      aria-pressed={composerMode === "steer"}
                      onClick={() => setComposerMode("steer")}
                    >
                      Steer
                    </button>
                    <button
                      type="button"
                      className={composerMode === "followUp" ? "is-selected" : ""}
                      aria-pressed={composerMode === "followUp"}
                      onClick={() => setComposerMode("followUp")}
                    >
                      Follow up
                    </button>
                  </div>
                  <div className="stream-actions">
                    {pendingCount > 0 && <span>{pendingCount} queued</span>}
                    {streaming && (
                      <button
                        className="stop-button"
                        type="button"
                        onClick={() => void desktop.abort().catch(() => undefined)}
                      >
                        <Stop size={12} weight="fill" aria-hidden="true" />
                        Stop
                      </button>
                    )}
                  </div>
                </div>
              )}

              <div
                className={`composer-shell ${commandMenuVisible ? "has-command-menu" : ""}`}
              >
                {commandMenuVisible && (
                  <div
                    className="composer-command-menu"
                    id="composer-command-menu"
                    role="listbox"
                    aria-label={inlineSlashMenu ? "Pi skills" : "Pi commands"}
                  >
                    <div className="composer-command-menu-header">
                      <span>{inlineSlashMenu ? "Pi skills" : "Pi commands"}</span>
                      <span>↑↓ navigate · Enter insert · Esc close</span>
                    </div>
                    <div className="composer-command-list">
                      {commandCandidates.length > 0 ? (
                        commandCandidates.map((command, index) => (
                          <button
                            className={`composer-command-option ${
                              index === activeCommandIndex ? "is-active" : ""
                            }`}
                            id={`composer-command-${index}`}
                            key={`${command.source}:${command.name}`}
                            type="button"
                            role="option"
                            aria-selected={index === activeCommandIndex}
                            onMouseDown={(event) => event.preventDefault()}
                            onPointerMove={() => {
                              if (activeCommandIndex !== index) {
                                setActiveCommandIndex(index);
                              }
                            }}
                            onClick={() => selectComposerCommand(command)}
                          >
                            <code>/{command.name}</code>
                            <span className="composer-command-description">
                              {command.description}
                            </span>
                            <span
                              className={`composer-command-source source-${command.source}`}
                            >
                              {COMMAND_SOURCE_LABELS[command.source]}
                            </span>
                          </button>
                        ))
                      ) : (
                        <div className="composer-command-empty" role="status">
                          {inlineSlashMenu
                            ? "No matching Pi skill"
                            : "No matching Pi command"}
                        </div>
                      )}
                    </div>
                  </div>
                )}
                <div className="composer-input-row">
                  <label
                    className={`tool-access-select tool-access-${desktop.toolAccess.mode}`}
                    title={
                      desktop.toolAccess.mode === "ask"
                        ? "Pause before commands, file changes, and custom tools"
                        : "Use Pi's native behavior. Tools run with your macOS user permissions"
                    }
                  >
                    <ShieldCheck size={16} weight="regular" aria-hidden="true" />
                    <span className="visually-hidden">Tool access</span>
                    <select
                      value={desktop.toolAccess.mode}
                      disabled={
                        streaming ||
                        sessionTransitioning ||
                        desktop.toolPermissionRequests.length > 0
                      }
                      onChange={(event) =>
                        void desktop
                          .selectToolAccess(event.currentTarget.value as ToolAccessMode)
                          .catch(() => undefined)
                      }
                      aria-label="Tool access"
                    >
                      <option value="pi-default">Pi default</option>
                      <option value="ask">Ask before actions</option>
                    </select>
                  </label>
                  <textarea
                    ref={textareaRef}
                    value={composer}
                    onChange={(event) =>
                      onComposerChange(
                        event.currentTarget.value,
                        event.currentTarget.selectionStart,
                      )
                    }
                    onKeyDown={onComposerKeyDown}
                    onFocus={(event) => {
                      setComposerFocused(true);
                      setComposerCursor(event.currentTarget.selectionStart);
                    }}
                    onBlur={() => setComposerFocused(false)}
                    onSelect={(event) => {
                      setComposerCursor(event.currentTarget.selectionStart);
                      setCommandMenuDismissed(false);
                    }}
                    placeholder={streaming ? "Add guidance for Pi" : "Message Pi — type / for commands and skills"}
                    aria-label="Message Pi"
                    aria-controls={commandMenuVisible ? "composer-command-menu" : undefined}
                    aria-expanded={commandMenuVisible}
                    aria-activedescendant={
                      commandMenuVisible && commandCandidates.length > 0
                        ? `composer-command-${Math.min(
                            activeCommandIndex,
                            commandCandidates.length - 1,
                          )}`
                        : undefined
                    }
                    rows={1}
                    spellCheck
                  />
                  <button
                    className="send-button"
                    type="button"
                    aria-label={streaming ? `Queue ${composerMode === "steer" ? "steering" : "follow-up"} message` : "Send message"}
                    disabled={!composer.trim() || submitting || sessionTransitioning}
                    onClick={() => void submitMessage()}
                  >
                    <ArrowUp size={15} weight="bold" aria-hidden="true" />
                  </button>
                </div>
              </div>
            </footer>
          ) : null}

          {activeSurface && (
            <section className="feature-workspace" aria-label="Feature workspace">
              <header className="feature-workspace-header">
                <div className="feature-workspace-identity">
                  <button
                    className="glyph-button"
                    type="button"
                    aria-label={sidebarVisible ? "Close navigation" : "Open navigation"}
                    aria-pressed={sidebarVisible}
                    onClick={toggleSidebar}
                  >
                    <SidebarSimple size={17} weight="regular" aria-hidden="true" />
                  </button>
                  <FeatureGlyph feature={activeFeature ?? undefined} />
                  <div>
                    <strong>{activeFeature?.name ?? "Plugins"}</strong>
                    <span>
                      {activeFeature
                        ? `${activeFeature.source} feature app`
                        : "Local Feature Host"}
                    </span>
                  </div>
                </div>
                <div className="feature-workspace-actions">
                  {activeStarterUpdate && (
                    <button
                      className="text-button feature-update-button"
                      type="button"
                      disabled={featureHost.installingStarter === activeFeature?.id}
                      onClick={() => featureHost.installStarter(activeStarterUpdate.id)}
                    >
                      {featureHost.installingStarter === activeFeature?.id
                        ? "Updating..."
                        : "Update plugin"}
                    </button>
                  )}
                  <button
                    className="glyph-button"
                    type="button"
                    aria-label="Reload feature"
                    onClick={reloadActiveFeature}
                  >
                    <ArrowClockwise size={16} weight="regular" aria-hidden="true" />
                  </button>
                  <button
                    className="glyph-button"
                    type="button"
                    aria-label="Return to chat"
                    onClick={returnToChat}
                  >
                    <X size={16} weight="regular" aria-hidden="true" />
                  </button>
                </div>
              </header>

              <div className="feature-workspace-body">
                {activeSurface.type === "manager" ? (
                  <FeatureManager
                    catalog={featureHost.catalog}
                    loading={featureHost.loading}
                    error={featureHost.error}
                    onReload={featureHost.reload}
                    onOpen={(feature) => openFeature(feature.id)}
                    onInstallStarter={featureHost.installStarter}
                    installingStarter={featureHost.installingStarter}
                    authoringSkill={authoringSkill.status}
                    authoringLoading={authoringSkill.loading}
                    authoringWorking={authoringSkill.working}
                    authoringError={authoringSkill.error}
                    onInstallAuthoring={authoringSkill.install}
                    onRemoveAuthoring={authoringSkill.remove}
                  />
                ) : activeFeature && featureContext ? (
                  <FeatureFrame
                    feature={activeFeature}
                    projectRoot={projectRoot}
                    context={featureContext}
                    revision={featureHost.revision}
                    onReload={reloadActiveFeature}
                    onNavigate={(target) => {
                      if (target === "chat") returnToChat();
                      else openFeatureManager();
                    }}
                  />
                ) : (
                  <div className="feature-frame-state">Loading feature…</div>
                )}
              </div>
            </section>
          )}

          {historyOpen && (
            <section className="history-browser" aria-label="Pi conversation history">
              <header className="history-browser-header">
                <div className="history-browser-identity">
                  <button
                    className="glyph-button"
                    type="button"
                    aria-label={sidebarVisible ? "Close navigation" : "Open navigation"}
                    aria-pressed={sidebarVisible}
                    onClick={toggleSidebar}
                  >
                    <SidebarSimple size={17} weight="regular" aria-hidden="true" />
                  </button>
                  <Chats size={17} weight="regular" aria-hidden="true" />
                  <div>
                    <strong>Pi history</strong>
                    <span>{conversations.length} conversations from Pi</span>
                  </div>
                </div>
                <div className="history-browser-actions">
                  <button
                    className="glyph-button"
                    type="button"
                    aria-label="Refresh Pi history"
                    disabled={historyLoading || sessionTransitioning}
                    onClick={() => void refreshHistory()}
                  >
                    <ArrowClockwise size={16} weight="regular" aria-hidden="true" />
                  </button>
                  <button
                    className="glyph-button"
                    type="button"
                    aria-label="Return to chat"
                    disabled={switchingSessionPath !== null}
                    onClick={returnToChat}
                  >
                    <X size={16} weight="regular" aria-hidden="true" />
                  </button>
                </div>
              </header>

              <div className="history-browser-toolbar">
                <label className="history-search">
                  <MagnifyingGlass size={16} weight="regular" aria-hidden="true" />
                  <input
                    value={historyQuery}
                    onChange={(event) => setHistoryQuery(event.currentTarget.value)}
                    placeholder="Search conversations or folders"
                    aria-label="Search Pi history"
                    autoFocus
                  />
                  {historyQuery && (
                    <button
                      type="button"
                      aria-label="Clear history search"
                      onClick={() => setHistoryQuery("")}
                    >
                      <X size={14} weight="bold" aria-hidden="true" />
                    </button>
                  )}
                </label>
                <span>
                  {historyLoading
                    ? "Reading Pi history…"
                    : `${historySessionGroups.reduce(
                        (total, group) => total + group.sessions.length,
                        0,
                      )} shown`}
                </span>
              </div>

              {historyError && (
                <div className="history-browser-error" role="alert">
                  <span>{historyError}</span>
                  <button type="button" onClick={() => setHistoryError(null)}>
                    <X size={14} weight="bold" aria-hidden="true" />
                    <span className="visually-hidden">Dismiss history error</span>
                  </button>
                </div>
              )}

              <div className="history-browser-scroll">
                {historyLoading && conversations.length === 0 ? (
                  <ConversationSkeleton />
                ) : historySessionGroups.length === 0 ? (
                  <div className="history-browser-empty">
                    <Chats size={22} weight="regular" aria-hidden="true" />
                    <strong>No matching conversations</strong>
                    <span>Try another search.</span>
                  </div>
                ) : (
                  <div className="history-directory-list">
                    {historySessionGroups.map((group) => (
                      <SessionDirectoryGroup
                        key={group.cwd}
                        group={group}
                        collapsed={
                          historyQuery.trim().length > 0
                            ? historySearchCollapsedDirectories.has(group.cwd)
                            : collapsedDirectories.has(group.cwd)
                        }
                        disabled={
                          streaming || nativeTerminal !== null || sessionTransitioning
                        }
                        switchingPath={switchingSessionPath}
                        onToggle={toggleHistoryDirectory}
                        onSelect={selectConversation}
                      />
                    ))}
                  </div>
                )}
              </div>
            </section>
          )}
        </main>

        <aside className={`inspector-panel ${inspectorOpen ? "is-open" : ""}`}>
          <header className="inspector-header">
            <strong>Inspector</strong>
            <button
              className="glyph-button"
              type="button"
              aria-label="Close inspector"
              onClick={() => setInspectorOpen(false)}
            >
              <X size={15} weight="regular" aria-hidden="true" />
            </button>
          </header>
          <div className="inspector-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={inspectorTab === "context"}
              className={inspectorTab === "context" ? "is-selected" : ""}
              onClick={() => setInspectorTab("context")}
            >
              Context
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={inspectorTab === "events"}
              className={inspectorTab === "events" ? "is-selected" : ""}
              onClick={() => setInspectorTab("events")}
            >
              Events
              {desktop.rpcLog.length > 0 && <span>{desktop.rpcLog.length}</span>}
            </button>
          </div>

          <div className="inspector-scroll">
            {inspectorTab === "context" ? (
              <>
                <section className="inspector-section">
                  <h2>Session</h2>
                  <dl className="stat-list">
                    <div>
                      <dt>Messages</dt>
                      <dd>{formatNumber(desktop.stats?.totalMessages ?? desktop.piState.messageCount)}</dd>
                    </div>
                    <div>
                      <dt>Tool calls</dt>
                      <dd>{formatNumber(desktop.stats?.toolCalls)}</dd>
                    </div>
                    <div>
                      <dt>Total tokens</dt>
                      <dd>{formatNumber(desktop.stats?.tokens?.total)}</dd>
                    </div>
                    <div>
                      <dt>Cost</dt>
                      <dd>{formatCost(desktop.stats?.cost)}</dd>
                    </div>
                  </dl>
                </section>

                <section className="inspector-section">
                  <h2>Context</h2>
                  <div className="context-reading">
                    <strong>
                      {desktop.stats?.contextUsage?.percent === null ||
                      desktop.stats?.contextUsage?.percent === undefined
                        ? "-"
                        : `${Math.round(desktop.stats.contextUsage.percent)}%`}
                    </strong>
                    <span>
                      {formatNumber(desktop.stats?.contextUsage?.tokens)} of {formatNumber(desktop.stats?.contextUsage?.contextWindow)} tokens
                    </span>
                  </div>
                  {desktop.piState.isCompacting && (
                    <div className="inline-status">Compacting context...</div>
                  )}
                </section>

                <section className="inspector-section">
                  <h2>Model</h2>
                  {currentModel ? (
                    <dl className="metadata-list">
                      <div>
                        <dt>Provider</dt>
                        <dd>{currentModel.provider}</dd>
                      </div>
                      <div>
                        <dt>Model</dt>
                        <dd>{currentModel.name ?? currentModel.id}</dd>
                      </div>
                      <div>
                        <dt>Thinking</dt>
                        <dd>{desktop.piState.thinkingLevel ?? "off"}</dd>
                      </div>
                    </dl>
                  ) : (
                    <p className="inspector-empty">No model selected.</p>
                  )}
                </section>

                <section className="inspector-section">
                  <h2>Queue</h2>
                  {pendingCount === 0 ? (
                    <p className="inspector-empty">No queued messages.</p>
                  ) : (
                    <div className="queue-list">
                      {desktop.queue.steering.map((message, index) => (
                        <div key={`steer-${index}`}>
                          <span>Steer</span>
                          <p>{message}</p>
                        </div>
                      ))}
                      {desktop.queue.followUp.map((message, index) => (
                        <div key={`follow-${index}`}>
                          <span>Follow up</span>
                          <p>{message}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              </>
            ) : (
              <section className="event-log">
                {desktop.rpcLog.length === 0 ? (
                  <p className="inspector-empty">No Pi events yet.</p>
                ) : (
                  [...desktop.rpcLog].reverse().map((entry) => (
                    <details key={entry.id} className="event-entry">
                      <summary>
                        <code>{entry.event.type}</code>
                        <time>
                          {new Date(entry.receivedAt).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                          })}
                        </time>
                      </summary>
                      <pre>{safeJson(entry.event)}</pre>
                    </details>
                  ))
                )}
              </section>
            )}
          </div>
        </aside>
      </div>

      {settingsOpen && (
        <SettingsDialog
          settings={desktop.settings}
          kernel={desktop.kernel}
          onClose={() => setSettingsOpen(false)}
          onSave={desktop.saveSettings}
          onConnect={desktop.connect}
          onDisconnect={desktop.disconnect}
        />
      )}
    </div>
  );
}

export default App;
