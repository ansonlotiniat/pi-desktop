import { createConnection } from "node:net";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
  SessionManager,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";

const PROTOCOL_VERSION = 1;
const INTERNAL_SWITCH_COMMAND = "__pi_desktop_switch";
const TOOL_ACCESS_MODES = new Set(["pi-default", "ask"]);
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const APPROVAL_PREVIEW_LIMIT = 6000;
const ALL_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

function truncateApprovalText(value, limit = APPROVAL_PREVIEW_LIMIT) {
  const text = String(value ?? "");
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[Preview truncated]`;
}

function approvalInput(event) {
  const input = event?.input && typeof event.input === "object" ? event.input : {};
  if (event.toolName === "bash") {
    return {
      command: truncateApprovalText(input.command),
      ...(typeof input.timeout === "number" ? { timeout: input.timeout } : {}),
    };
  }
  if (event.toolName === "write") {
    const content = String(input.content ?? "");
    return {
      path: String(input.path ?? ""),
      contentPreview: truncateApprovalText(content, 2400),
      contentLength: content.length,
    };
  }
  if (event.toolName === "edit") {
    return {
      path: String(input.path ?? ""),
      oldTextPreview: truncateApprovalText(input.oldText, 1800),
      newTextPreview: truncateApprovalText(input.newText, 1800),
    };
  }
  try {
    return { preview: truncateApprovalText(JSON.stringify(input, null, 2)) };
  } catch {
    return { preview: "Tool arguments could not be displayed." };
  }
}

function approvalSummary(event) {
  if (event.toolName === "bash") {
    return truncateApprovalText(event.input?.command, 300);
  }
  const path = event.input?.path;
  if (typeof path === "string" && path.trim()) return path;
  return `Run ${event.toolName}`;
}

function asText(message) {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .map((block) => block?.text ?? block?.thinking ?? "")
    .join("");
}

function activeMessages(ctx) {
  return ctx.sessionManager
    .buildContextEntries()
    .flatMap((entry) => sessionEntryToContextMessages(entry));
}

function stateSnapshot(pi, ctx) {
  const messages = activeMessages(ctx);
  return {
    model: ctx.model ?? null,
    thinkingLevel: pi.getThinkingLevel(),
    isStreaming: !ctx.isIdle(),
    isCompacting: false,
    sessionFile: ctx.sessionManager.getSessionFile(),
    sessionId: ctx.sessionManager.getSessionId(),
    sessionName: ctx.sessionManager.getSessionName(),
    messageCount: messages.length,
    pendingMessageCount: ctx.hasPendingMessages() ? 1 : 0,
    cwd: ctx.cwd,
  };
}

function thinkingLevels(ctx) {
  return ctx.model ? getSupportedThinkingLevels(ctx.model) : ALL_THINKING_LEVELS;
}

function sessionStats(ctx) {
  const messages = activeMessages(ctx);
  const totals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  };
  let userMessages = 0;
  let assistantMessages = 0;
  let toolCalls = 0;
  let toolResults = 0;
  let cost = 0;

  for (const message of messages) {
    if (message?.role === "user") userMessages += 1;
    if (message?.role === "assistant") {
      assistantMessages += 1;
      if (Array.isArray(message.content)) {
        toolCalls += message.content.filter((block) => block?.type === "toolCall").length;
      }
      const usage = message.usage;
      if (usage && typeof usage === "object") {
        for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"]) {
          if (typeof usage[key] === "number") totals[key] += usage[key];
        }
        if (typeof usage.cost?.total === "number") cost += usage.cost.total;
      }
    }
    if (message?.role === "toolResult") toolResults += 1;
  }

  return {
    sessionFile: ctx.sessionManager.getSessionFile(),
    sessionId: ctx.sessionManager.getSessionId(),
    userMessages,
    assistantMessages,
    toolCalls,
    toolResults,
    totalMessages: messages.length,
    tokens: totals,
    cost,
    contextUsage: ctx.getContextUsage(),
  };
}

function sessionSummary(session) {
  return {
    path: session.path,
    id: session.id,
    cwd: session.cwd,
    name: session.name,
    parentSessionPath: session.parentSessionPath,
    created: session.created instanceof Date
      ? session.created.toISOString()
      : String(session.created),
    modified: session.modified instanceof Date
      ? session.modified.toISOString()
      : String(session.modified),
    messageCount: session.messageCount,
    firstMessage: session.firstMessage,
  };
}

export default function piDesktopBridge(pi) {
  const socketPath = process.env.PI_DESKTOP_BRIDGE_SOCKET;
  if (!socketPath) return;

  let socket;
  let reconnectTimer;
  let active = false;
  let currentContext;
  let inputBuffer = Buffer.alloc(0);
  let socketReady = false;
  let switchSequence = 0;
  let approvalSequence = 0;
  let toolAccessMode = TOOL_ACCESS_MODES.has(process.env.PI_DESKTOP_TOOL_ACCESS_MODE)
    ? process.env.PI_DESKTOP_TOOL_ACCESS_MODE
    : "pi-default";
  const listedSessions = new Map();
  const pendingSwitches = new Map();
  const pendingApprovals = new Map();

  pi.registerCommand(INTERNAL_SWITCH_COMMAND, {
    description: "Pi Desktop internal session switch",
    handler: async (args, ctx) => {
      const token = args.trim();
      const sessionPath = pendingSwitches.get(token);
      pendingSwitches.delete(token);
      if (!sessionPath) {
        emit("bridge_error", { message: "The Desktop session switch expired." });
        return;
      }
      try {
        await ctx.switchSession(sessionPath);
      } catch (error) {
        emit("bridge_error", {
          operation: "switch_session",
          sessionPath,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  });

  const write = (value) => {
    if (!socketReady || !socket?.writable) return false;
    socket.write(`${JSON.stringify(value)}\n`);
    return true;
  };

  const emit = (type, fields = {}) => write({ type, ...fields });

  const respond = (request, success, data, error) =>
    write({
      id: request.id,
      type: "response",
      command: request.type,
      success,
      ...(success ? { data } : { error }),
    });

  const unsupported = (request, nativeCommand) =>
    respond(
      request,
      false,
      undefined,
      `Pi Desktop leaves this operation to native Pi TUI. Run ${nativeCommand}.`,
    );

  const settlePendingApprovals = (decision = "deny") => {
    for (const approval of pendingApprovals.values()) approval.resolve(decision);
    pendingApprovals.clear();
  };

  const requestToolPermission = (event, ctx) =>
    new Promise((resolve) => {
      approvalSequence += 1;
      const requestId = `tool-${Date.now().toString(36)}-${approvalSequence.toString(36)}`;
      const finish = (decision) => {
        const approval = pendingApprovals.get(requestId);
        if (!approval) return;
        pendingApprovals.delete(requestId);
        if (approval.abort && ctx.signal) {
          ctx.signal.removeEventListener("abort", approval.abort);
        }
        resolve(decision === "allow" ? "allow" : "deny");
      };
      const abort = () => finish("deny");
      pendingApprovals.set(requestId, { resolve: finish, abort });
      if (ctx.signal) ctx.signal.addEventListener("abort", abort, { once: true });
      const delivered = emit("tool_permission_request", {
        requestId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        cwd: ctx.cwd,
        summary: approvalSummary(event),
        input: approvalInput(event),
      });
      if (!delivered) finish("deny");
    });

  const handleRequest = async (request) => {
    const ctx = currentContext;
    if (!ctx) {
      respond(request, false, undefined, "Pi session bridge is not ready.");
      return;
    }

    try {
      switch (request.type) {
        case "get_tool_access":
          respond(request, true, {
            mode: toolAccessMode,
            modes: ["pi-default", "ask"],
            mechanism: "extension-tool-call",
          });
          return;
        case "set_tool_access": {
          const mode = String(request.mode ?? "");
          if (!TOOL_ACCESS_MODES.has(mode)) {
            throw new Error(`Unsupported tool access mode '${mode}'.`);
          }
          if (pendingApprovals.size > 0) {
            throw new Error("Answer the pending tool request before changing access mode.");
          }
          toolAccessMode = mode;
          process.env.PI_DESKTOP_TOOL_ACCESS_MODE = mode;
          emit("tool_access_changed", { mode });
          respond(request, true, { mode });
          return;
        }
        case "resolve_tool_permission": {
          const requestId = String(request.requestId ?? "");
          const decision = request.decision === "allow" ? "allow" : "deny";
          const approval = pendingApprovals.get(requestId);
          if (!approval) {
            throw new Error("That tool request is no longer waiting for approval.");
          }
          approval.resolve(decision);
          respond(request, true, { requestId, decision });
          return;
        }
        case "get_state":
          respond(request, true, stateSnapshot(pi, ctx));
          return;
        case "get_messages":
          respond(request, true, { messages: activeMessages(ctx) });
          return;
        case "get_available_models":
          respond(request, true, { models: ctx.modelRegistry.getAvailable() });
          return;
        case "get_available_thinking_levels":
          respond(request, true, { levels: thinkingLevels(ctx) });
          return;
        case "get_session_stats":
          respond(request, true, sessionStats(ctx));
          return;
        case "get_commands":
          respond(request, true, {
            commands: pi
              .getCommands()
              .filter((command) => command.name !== INTERNAL_SWITCH_COMMAND),
          });
          return;
        case "list_sessions": {
          const sessions = await SessionManager.listAll();
          listedSessions.clear();
          for (const session of sessions) listedSessions.set(session.path, session);
          respond(request, true, { sessions: sessions.map(sessionSummary) });
          return;
        }
        case "prepare_switch_session": {
          if (!ctx.isIdle()) {
            throw new Error("Wait for Pi to finish before switching conversations.");
          }
          const sessionPath = String(request.sessionPath ?? "").trim();
          if (!sessionPath) throw new Error("A Pi session path is required.");
          if (sessionPath === ctx.sessionManager.getSessionFile()) {
            respond(request, true, { alreadyCurrent: true });
            return;
          }
          if (!listedSessions.has(sessionPath)) {
            const sessions = await SessionManager.listAll();
            listedSessions.clear();
            for (const session of sessions) listedSessions.set(session.path, session);
          }
          const session = listedSessions.get(sessionPath);
          if (!session) throw new Error("That Pi conversation no longer exists.");
          if (!session.cwd) {
            throw new Error(
              "This older Pi conversation has no working-directory metadata and cannot be switched from Desktop.",
            );
          }
          switchSequence += 1;
          const token = `${Date.now().toString(36)}-${switchSequence.toString(36)}`;
          pendingSwitches.clear();
          pendingSwitches.set(token, sessionPath);
          respond(request, true, {
            command: `/${INTERNAL_SWITCH_COMMAND} ${token}`,
            session: sessionSummary(session),
          });
          return;
        }
        case "get_fork_messages": {
          const messages = ctx.sessionManager
            .getBranch()
            .filter((entry) => entry?.type === "message" && entry.message?.role === "user")
            .map((entry) => ({ entryId: entry.id, text: asText(entry.message) }));
          respond(request, true, { messages });
          return;
        }
        case "prompt":
          pi.sendUserMessage(String(request.message ?? ""), {
            expandPromptTemplates: true,
          });
          respond(request, true, undefined);
          return;
        case "steer":
          pi.sendUserMessage(String(request.message ?? ""), {
            deliverAs: "steer",
            expandPromptTemplates: true,
          });
          respond(request, true, undefined);
          return;
        case "follow_up":
          pi.sendUserMessage(String(request.message ?? ""), {
            deliverAs: "followUp",
            expandPromptTemplates: true,
          });
          respond(request, true, undefined);
          return;
        case "abort":
          ctx.abort();
          respond(request, true, undefined);
          return;
        case "set_model": {
          const model = ctx.modelRegistry.find(String(request.provider), String(request.modelId));
          if (!model) throw new Error("Requested model is not available in this Pi session.");
          if (!(await pi.setModel(model))) {
            throw new Error("Pi could not authenticate the requested model.");
          }
          respond(request, true, model);
          return;
        }
        case "set_thinking_level":
          pi.setThinkingLevel(String(request.level));
          respond(request, true, undefined);
          return;
        case "set_session_name":
          pi.setSessionName(String(request.name ?? ""));
          respond(request, true, undefined);
          return;
        case "new_session":
          unsupported(request, "/new");
          return;
        case "switch_session":
          unsupported(request, "/resume");
          return;
        case "fork":
          unsupported(request, "/fork");
          return;
        case "clone":
          unsupported(request, "/clone");
          return;
        case "export_html":
          unsupported(request, "/export");
          return;
        default:
          respond(request, false, undefined, `Unsupported Desktop bridge command: ${request.type}`);
      }
    } catch (error) {
      respond(request, false, undefined, error instanceof Error ? error.message : String(error));
    }
  };

  const consume = (chunk) => {
    inputBuffer = Buffer.concat([inputBuffer, chunk]);
    for (;;) {
      const newline = inputBuffer.indexOf(0x0a);
      if (newline < 0) return;
      const record = inputBuffer.subarray(0, newline);
      inputBuffer = inputBuffer.subarray(newline + 1);
      if (record.length === 0) continue;
      try {
        const request = JSON.parse(record.toString("utf8"));
        if (request && typeof request === "object" && typeof request.type === "string") {
          void handleRequest(request);
        }
      } catch (error) {
        emit("bridge_error", {
          message: `Invalid Desktop bridge request: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  };

  const connect = () => {
    if (!active || socket) return;
    const candidate = createConnection(socketPath);
    socket = candidate;
    candidate.on("connect", () => {
      inputBuffer = Buffer.alloc(0);
      candidate.write(`${JSON.stringify({
        type: "bridge_ready",
        protocolVersion: PROTOCOL_VERSION,
        capabilities: [
          "state",
          "messages",
          "models",
          "thinking",
          "commands",
          "sessions",
          "prompt",
          "steer",
          "follow_up",
          "abort",
          "events",
          "tool_permission_gate",
        ],
        toolAccess: {
          mode: toolAccessMode,
          modes: ["pi-default", "ask"],
          mechanism: "extension-tool-call",
        },
        state: stateSnapshot(pi, currentContext),
      })}\n`);
      socketReady = true;
    });
    candidate.on("data", consume);
    candidate.on("error", () => undefined);
    candidate.on("close", () => {
      settlePendingApprovals("deny");
      if (socket === candidate) {
        socket = undefined;
        socketReady = false;
      }
      if (active) reconnectTimer = setTimeout(connect, 150);
    });
  };

  pi.on("session_start", (event, ctx) => {
    currentContext = ctx;
    active = true;
    connect();
    emit("session_start", {
      reason: event.reason,
      previousSessionFile: event.previousSessionFile,
      state: stateSnapshot(pi, ctx),
    });
  });

  pi.on("session_shutdown", (event) => {
    emit("session_shutdown", {
      reason: event.reason,
      targetSessionFile: event.targetSessionFile,
    });
    active = false;
    settlePendingApprovals("deny");
    currentContext = undefined;
    clearTimeout(reconnectTimer);
    socket?.end();
    socket = undefined;
  });

  pi.on("tool_call", async (event, ctx) => {
    if (toolAccessMode !== "ask" || READ_ONLY_TOOLS.has(event.toolName)) {
      return undefined;
    }
    const decision = await requestToolPermission(event, ctx);
    if (decision === "allow") return undefined;
    return { block: true, reason: "Blocked by the user in Pi Desktop." };
  });

  for (const type of [
    "agent_start",
    "agent_end",
    "agent_settled",
    "turn_start",
    "turn_end",
    "message_start",
    "message_update",
    "message_end",
    "tool_execution_start",
    "tool_execution_update",
    "tool_execution_end",
    "session_info_changed",
    "session_compact",
    "session_tree",
    "model_select",
    "thinking_level_select",
  ]) {
    pi.on(type, (event) => write(event));
  }

  pi.on("session_before_compact", (event) => {
    emit("compaction_start", { reason: event.reason });
  });
}
