import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { X } from "@phosphor-icons/react";
import { desktopApi } from "../api";
import type { NativeTerminalPhase, RpcEnvelope } from "../types";

interface NativePiTerminalProps {
  active: boolean;
  initialInput: string;
  closeOnAgentStart?: boolean;
  preview?: boolean;
  onReady: () => void;
  onDone: () => void;
  onError: (message: string) => void;
}

type TerminalPresentation = "parked" | "opening" | "expanded" | "closing";

const OPEN_DURATION_MS = 260;
const OUTPUT_SETTLE_MS = 48;
const OUTPUT_FALLBACK_MS = 600;
const MODEL_KEY_FALLBACK_MS = 700;

const COMPLETION_EVENTS_BY_COMMAND: Readonly<
  Record<string, ReadonlySet<string>>
> = {
  model: new Set(["model_select"]),
  thinking: new Set(["thinking_level_select"]),
  think: new Set(["thinking_level_select"]),
  name: new Set(["session_info_changed"]),
  compact: new Set(["session_compact"]),
  tree: new Set(["session_tree"]),
  new: new Set(["session_start", "bridge_ready"]),
  resume: new Set(["session_start", "bridge_ready"]),
  fork: new Set(["session_start", "bridge_ready"]),
  clone: new Set(["session_start", "bridge_ready"]),
  import: new Set(["session_start", "bridge_ready"]),
  reload: new Set(["session_start", "bridge_ready"]),
};

const KNOWN_COMPLETION_EVENTS = new Set(
  Object.values(COMPLETION_EVENTS_BY_COMMAND).flatMap((events) => [...events]),
);

function slashCommandName(input: string): string | null {
  const match = input.trim().match(/^\/([^\s/]*)/);
  return match?.[1]?.toLowerCase() || null;
}

function eventCompletesSurface(input: string, event: RpcEnvelope): boolean {
  const trimmed = input.trim();
  if (trimmed === "/") return KNOWN_COMPLETION_EVENTS.has(event.type);
  const command = slashCommandName(trimmed);
  return command
    ? COMPLETION_EVENTS_BY_COMMAND[command]?.has(event.type) === true
    : false;
}

function isExplicitModelSurface(input: string): boolean {
  return slashCommandName(input) === "model";
}

export function NativePiTerminal({
  active,
  initialInput,
  closeOnAgentStart = false,
  preview = false,
  onReady,
  onDone,
  onError,
}: NativePiTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const generationRef = useRef<number | null>(null);
  const phaseRef = useRef<NativeTerminalPhase>("inactive");
  const presentationRef = useRef<TerminalPresentation>("parked");
  const animatingRef = useRef(false);
  const awaitingOutputRef = useRef(false);
  const autoCloseArmedRef = useRef(false);
  const inputReadyRef = useRef(false);
  const pendingInputRef = useRef("");
  const activeRef = useRef(active);
  const initialInputRef = useRef(initialInput);
  const closeOnAgentStartRef = useRef(closeOnAgentStart);
  const onReadyRef = useRef(onReady);
  const onDoneRef = useRef(onDone);
  const onErrorRef = useRef(onError);
  const openFrameRef = useRef(0);
  const expandFrameRef = useRef(0);
  const activationTimerRef = useRef<number | null>(null);
  const readyTimerRef = useRef<number | null>(null);
  const fallbackTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const interactionTimerRef = useRef<number | null>(null);
  const [phase, setPhase] = useState<NativeTerminalPhase>("inactive");
  const [presentation, setPresentation] =
    useState<TerminalPresentation>("parked");
  const [terminalReady, setTerminalReady] = useState(false);

  function updatePresentation(next: TerminalPresentation) {
    presentationRef.current = next;
    setPresentation(next);
  }

  function clearTransitionWork() {
    window.cancelAnimationFrame(openFrameRef.current);
    window.cancelAnimationFrame(expandFrameRef.current);
    if (activationTimerRef.current !== null) {
      window.clearTimeout(activationTimerRef.current);
      activationTimerRef.current = null;
    }
    if (readyTimerRef.current !== null) {
      window.clearTimeout(readyTimerRef.current);
      readyTimerRef.current = null;
    }
    if (fallbackTimerRef.current !== null) {
      window.clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    if (interactionTimerRef.current !== null) {
      window.clearTimeout(interactionTimerRef.current);
      interactionTimerRef.current = null;
    }
  }

  useEffect(() => {
    activeRef.current = active;
    initialInputRef.current = initialInput;
    closeOnAgentStartRef.current = closeOnAgentStart;
    onReadyRef.current = onReady;
    onDoneRef.current = onDone;
    onErrorRef.current = onError;
  }, [active, closeOnAgentStart, initialInput, onReady, onDone, onError]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const terminal = new Terminal({
      allowTransparency: false,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily:
        '"SF Mono", "SFMono-Regular", ui-monospace, Menlo, Monaco, Consolas, monospace',
      fontSize: 15,
      fontWeight: "500",
      fontWeightBold: "700",
      letterSpacing: 0.1,
      lineHeight: 1.22,
      minimumContrastRatio: 4.5,
      scrollback: 3000,
      theme: {
        background: "#0d0e0f",
        foreground: "#f0f1ee",
        cursor: "#9bd1a3",
        cursorAccent: "#0d0e0f",
        selectionBackground: "rgba(139, 196, 147, 0.42)",
        black: "#242627",
        red: "#e09590",
        green: "#9bd1a3",
        yellow: "#d0b47d",
        blue: "#93b9d8",
        magenta: "#c2a4d2",
        cyan: "#8bc8c3",
        white: "#dcddd9",
        brightBlack: "#a1a49e",
        brightRed: "#e8aaa5",
        brightGreen: "#addbb2",
        brightYellow: "#dec58f",
        brightBlue: "#a9c9e1",
        brightMagenta: "#d0b6dc",
        brightCyan: "#a2d6d2",
        brightWhite: "#ffffff",
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    let disposed = false;
    let stopOutput: (() => void) | undefined;
    let stopStatus: (() => void) | undefined;
    let stopPiEvents: (() => void) | undefined;
    let resizeFrame = 0;

    const completeSurface = () => {
      if (!autoCloseArmedRef.current || !activeRef.current || disposed) return;
      autoCloseArmedRef.current = false;
      if (interactionTimerRef.current !== null) {
        window.clearTimeout(interactionTimerRef.current);
        interactionTimerRef.current = null;
      }
      closeTerminal();
    };

    const scheduleModelKeyFallback = (delay: number) => {
      if (
        !autoCloseArmedRef.current ||
        !isExplicitModelSurface(initialInputRef.current)
      ) {
        return;
      }
      if (interactionTimerRef.current !== null) {
        window.clearTimeout(interactionTimerRef.current);
      }
      interactionTimerRef.current = window.setTimeout(completeSurface, delay);
    };

    const forwardInput = (data: string) => {
      void desktopApi.writeNativeTerminal(data).catch((error) => {
        if (!disposed && activeRef.current) {
          onErrorRef.current(String(error));
        }
      });
    };

    const revealAfterOutputSettles = () => {
      if (!awaitingOutputRef.current || !activeRef.current || disposed) return;
      if (readyTimerRef.current !== null) {
        window.clearTimeout(readyTimerRef.current);
      }
      readyTimerRef.current = window.setTimeout(() => {
        if (!awaitingOutputRef.current || !activeRef.current || disposed) return;
        awaitingOutputRef.current = false;
        if (fallbackTimerRef.current !== null) {
          window.clearTimeout(fallbackTimerRef.current);
          fallbackTimerRef.current = null;
        }
        setTerminalReady(true);
        terminal.focus();
      }, OUTPUT_SETTLE_MS);
    };

    const fit = () => {
      window.cancelAnimationFrame(resizeFrame);
      resizeFrame = window.requestAnimationFrame(() => {
        if (disposed || !container.isConnected || animatingRef.current) return;
        fitAddon.fit();
        if (!preview && terminal.cols >= 40 && terminal.rows >= 8) {
          void desktopApi
            .resizeNativeTerminal(terminal.cols, terminal.rows)
            .catch(() => undefined);
        }
      });
    };
    const resizeObserver = new ResizeObserver(fit);
    resizeObserver.observe(container);
    const input = terminal.onData((data) => {
      if (data === "\x1b") {
        if (
          !preview &&
          (phaseRef.current === "running" ||
            phaseRef.current === "starting")
        ) {
          forwardInput(data);
        }
        closeTerminal();
        return;
      }
      if (preview) {
        if (data.includes("\r") || data === "\x03") {
          scheduleModelKeyFallback(MODEL_KEY_FALLBACK_MS);
        }
        return;
      }
      if (
        phaseRef.current !== "running" &&
        phaseRef.current !== "starting"
      ) {
        return;
      }
      if (!inputReadyRef.current) {
        pendingInputRef.current += data;
      } else {
        forwardInput(data);
      }
      if (data.includes("\r")) {
        scheduleModelKeyFallback(MODEL_KEY_FALLBACK_MS);
      } else if (data === "\x03") {
        scheduleModelKeyFallback(OUTPUT_SETTLE_MS);
      } else if (interactionTimerRef.current !== null) {
        window.clearTimeout(interactionTimerRef.current);
        interactionTimerRef.current = null;
      }
    });

    async function subscribe() {
      try {
        const unlistenOutput = await desktopApi.onNativeTerminalOutput(
          (output) => {
            if (
              !disposed &&
              (generationRef.current === null ||
                generationRef.current === output.generation)
            ) {
              terminal.write(
                new Uint8Array(output.data),
                revealAfterOutputSettles,
              );
            }
          },
        );
        if (disposed) {
          unlistenOutput();
          return;
        }
        stopOutput = unlistenOutput;

        const unlistenStatus = await desktopApi.onNativeTerminalStatus(
          (status) => {
            if (disposed) return;
            generationRef.current = status.generation;
            phaseRef.current = status.phase;
            setPhase(status.phase);
            if (status.phase === "running") fit();
            if (status.phase === "error" && status.error) {
              onErrorRef.current(status.error);
            }
            if (
              activeRef.current &&
              status.phase === "inactive" &&
              status.generation > 0
            ) {
              onDoneRef.current();
            }
          },
        );
        if (disposed) {
          unlistenStatus();
          return;
        }
        stopStatus = unlistenStatus;

        const unlistenPiEvents = await desktopApi.onPiEvent((event) => {
          if (
            !disposed &&
            autoCloseArmedRef.current &&
            (eventCompletesSurface(initialInputRef.current, event) ||
              (closeOnAgentStartRef.current && event.type === "agent_start"))
          ) {
            completeSurface();
          }
        });
        if (disposed) {
          unlistenPiEvents();
          return;
        }
        stopPiEvents = unlistenPiEvents;

        const status = await desktopApi.nativeTerminalStatus();
        if (!disposed) {
          generationRef.current = status.generation;
          phaseRef.current = status.phase;
          setPhase(status.phase);
          fit();
          onReadyRef.current();
        }
      } catch (error) {
        if (!disposed) onErrorRef.current(String(error));
      }
    }

    if (preview) {
      phaseRef.current = "running";
      setPhase("running");
      fit();
      onReadyRef.current();
    } else {
      void subscribe();
    }

    return () => {
      disposed = true;
      clearTransitionWork();
      window.cancelAnimationFrame(resizeFrame);
      resizeObserver.disconnect();
      input.dispose();
      stopOutput?.();
      stopStatus?.();
      stopPiEvents?.();
      terminalRef.current = null;
      fitAddonRef.current = null;
      terminal.dispose();
    };
  }, [preview]);

  useEffect(() => {
    clearTransitionWork();
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;

    if (!active) {
      animatingRef.current = false;
      awaitingOutputRef.current = false;
      autoCloseArmedRef.current = false;
      inputReadyRef.current = false;
      pendingInputRef.current = "";
      setTerminalReady(false);
      updatePresentation("parked");
      openFrameRef.current = window.requestAnimationFrame(() => {
        fitAddon?.fit();
        if (
          !preview &&
          terminal &&
          terminal.cols >= 40 &&
          terminal.rows >= 8
        ) {
          void desktopApi
            .resizeNativeTerminal(terminal.cols, terminal.rows)
            .catch(() => undefined);
        }
      });
      return;
    }
    if (!terminal || !fitAddon) return;

    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const openDuration = reducedMotion ? 0 : OPEN_DURATION_MS;
    animatingRef.current = true;
    inputReadyRef.current = false;
    pendingInputRef.current = "";
    setTerminalReady(false);
    updatePresentation("opening");
    terminal.focus();

    openFrameRef.current = window.requestAnimationFrame(() => {
      expandFrameRef.current = window.requestAnimationFrame(() => {
        updatePresentation("expanded");
        activationTimerRef.current = window.setTimeout(() => {
          animatingRef.current = false;
          fitAddon.fit();
          if (preview) {
            awaitingOutputRef.current = true;
            autoCloseArmedRef.current = true;
            terminal.reset();
            terminal.write(
              "\x1b[2J\x1b[H" +
                "\r\n" +
                "  \x1b[1;97mSelect model\x1b[0m\r\n" +
                "  \x1b[90mType to filter · ↑↓ move · Enter select · Esc close\x1b[0m\r\n\r\n" +
                "  \x1b[93mOnly showing models from configured providers.\x1b[0m\r\n\r\n" +
                "  \x1b[1;92m› GPT-5.6 Luna\x1b[0m          \x1b[90mopenai-codex  current\x1b[0m\r\n" +
                "    GPT-5.6 Sol Max       \x1b[90mopenai-codex\x1b[0m\r\n" +
                "    GPT-5.6 Sol           \x1b[90mopenai-codex\x1b[0m\r\n" +
                "    GPT-5.6 Terra         \x1b[90mopenai-codex\x1b[0m\r\n" +
                "    GPT-5.4               \x1b[90mopenai-codex\x1b[0m\r\n",
              () => {
                awaitingOutputRef.current = false;
                setTerminalReady(true);
              },
            );
            return;
          }
          awaitingOutputRef.current = true;
          autoCloseArmedRef.current = true;
          void desktopApi
            .startNativeTerminal(
              initialInput,
              Math.max(terminal.cols, 40),
              Math.max(terminal.rows, 8),
            )
            .then((status) => {
              generationRef.current = status.generation;
              phaseRef.current = status.phase;
              setPhase(status.phase);
              inputReadyRef.current = true;
              const pending = pendingInputRef.current;
              pendingInputRef.current = "";
              if (pending) {
                void desktopApi
                  .writeNativeTerminal(pending)
                  .catch((error) => onErrorRef.current(String(error)));
              }
              fallbackTimerRef.current = window.setTimeout(() => {
                if (!awaitingOutputRef.current) return;
                awaitingOutputRef.current = false;
                setTerminalReady(true);
                terminal.focus();
              }, OUTPUT_FALLBACK_MS);
            })
            .catch((error) => {
              awaitingOutputRef.current = false;
              autoCloseArmedRef.current = false;
              inputReadyRef.current = false;
              pendingInputRef.current = "";
              onErrorRef.current(String(error));
            });
        }, openDuration);
      });
    });

    return clearTransitionWork;
  }, [active, initialInput, preview]);

  function closeTerminal() {
    if (presentationRef.current === "closing") return;
    clearTransitionWork();
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    animatingRef.current = true;
    awaitingOutputRef.current = false;
    autoCloseArmedRef.current = false;
    inputReadyRef.current = false;
    pendingInputRef.current = "";
    setTerminalReady(false);
    updatePresentation("closing");
    closeTimerRef.current = window.setTimeout(() => {
      animatingRef.current = false;
      onDoneRef.current();
    }, reducedMotion ? 0 : OPEN_DURATION_MS);
  }

  function dismissTerminal() {
    if (
      !preview &&
      (phaseRef.current === "running" || phaseRef.current === "starting")
    ) {
      void desktopApi.writeNativeTerminal("\x1b").catch((error) => {
        onErrorRef.current(String(error));
      });
    }
    closeTerminal();
  }

  const phaseLabel =
    phase === "starting"
      ? "Starting Pi…"
      : phase === "closing"
        ? "Closing Pi…"
        : presentation === "opening"
          ? `Opening ${initialInput || "Pi TUI"}…`
          : "Native Pi TUI";

  return (
    <section
      className={`native-pi-terminal is-${presentation} ${
        terminalReady ? "is-terminal-ready" : ""
      }`}
      data-presentation={presentation}
      data-terminal-ready={terminalReady}
      aria-label="Native Pi terminal"
      aria-hidden={!active}
    >
      {active && (
        <header className="native-terminal-toolbar">
          <div className="native-terminal-identity">
            <span className="native-terminal-dot" aria-hidden="true" />
            <strong>{phaseLabel}</strong>
            {initialInput && <code>{initialInput}</code>}
          </div>
          <span className="native-terminal-hint">Pi keyboard controls are active</span>
          <button
            className="native-terminal-close"
            type="button"
            aria-label="Return to Pi Desktop"
            disabled={presentation === "closing"}
            onClick={dismissTerminal}
          >
            <X size={16} weight="bold" aria-hidden="true" />
          </button>
        </header>
      )}
      <div className="native-terminal-stage">
        <div className="native-terminal-host" ref={containerRef} />
      </div>
      {active && !terminalReady && (
        <div className="native-terminal-loading" aria-live="polite">
          {phaseLabel}
        </div>
      )}
    </section>
  );
}
