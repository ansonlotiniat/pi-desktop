import { useState, type ReactNode } from "react";
import type { AgentMessage, ContentBlock } from "../types";

const SECRET_KEY = /api.?key|authorization|password|secret/i;

export function safeJson(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(
      value,
      (key, nestedValue: unknown) =>
        SECRET_KEY.test(key) && typeof nestedValue === "string"
          ? "********"
          : nestedValue,
      2,
    );
  } catch {
    return String(value);
  }
}

function CodeBlock({ code, language }: { code: string; language?: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  return (
    <figure className="code-block">
      <figcaption>
        <span>{language || "code"}</span>
        <button type="button" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy"}
        </button>
      </figcaption>
      <pre>
        <code>{code}</code>
      </pre>
    </figure>
  );
}

function RichText({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  const fence = /```([\w.+-]*)\n?([\s\S]*?)```/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = fence.exec(text)) !== null) {
    if (match.index > cursor) {
      parts.push(
        <span className="prose-text" key={`text-${cursor}`}>
          {text.slice(cursor, match.index)}
        </span>,
      );
    }
    parts.push(
      <CodeBlock
        key={`code-${match.index}`}
        language={match[1]}
        code={match[2].replace(/\n$/, "")}
      />,
    );
    cursor = match.index + match[0].length;
  }

  if (cursor < text.length) {
    parts.push(
      <span className="prose-text" key={`text-${cursor}`}>
        {text.slice(cursor)}
      </span>,
    );
  }

  return <>{parts.length ? parts : <span className="prose-text">{text}</span>}</>;
}

function ToolCallBlock({ block }: { block: ContentBlock }) {
  return (
    <details className="inline-disclosure tool-call-block">
      <summary>
        <span className="tool-glyph" aria-hidden="true">
          $ 
        </span>
        <span>{block.name || "Tool call"}</span>
      </summary>
      {block.arguments !== undefined && (
        <pre>{safeJson(block.arguments)}</pre>
      )}
    </details>
  );
}

function Content({ block }: { block: ContentBlock }) {
  switch (block.type) {
    case "text":
      return <RichText text={block.text ?? ""} />;
    case "thinking":
      return (
        <details className="inline-disclosure thinking-block">
          <summary>Thinking</summary>
          <div className="thinking-copy">
            <RichText text={block.thinking ?? block.text ?? ""} />
          </div>
        </details>
      );
    case "toolCall":
    case "tool_call":
    case "tool_use":
      return <ToolCallBlock block={block} />;
    case "image":
      return <div className="attachment-block">Image attachment</div>;
    default:
      return (
        <details className="inline-disclosure unknown-block">
          <summary>{block.type || "Unknown content"}</summary>
          <pre>{safeJson(block)}</pre>
        </details>
      );
  }
}

function compactErrorMessage(raw: string): string {
  const source = raw.trim();
  if (!source) return "Pi stopped without returning an error message.";

  const htmlIndex = source.search(/<!doctype\s+html|<html(?:\s|>)/i);
  if (htmlIndex >= 0) {
    const prefix = source
      .slice(0, htmlIndex)
      .replace(/[\s:;-]+$/, "")
      .trim();
    const document = new DOMParser().parseFromString(
      source.slice(htmlIndex),
      "text/html",
    );
    document
      .querySelectorAll("script, style, noscript, svg")
      .forEach((element) => element.remove());
    const phrases = Array.from(document.querySelectorAll("h1, h2, h3, p, title"))
      .map((element) => element.textContent?.replace(/\s+/g, " ").trim() ?? "")
      .filter((text, index, all) => text.length > 0 && all.indexOf(text) === index);
    const detail =
      phrases.find((text) => /unable to load|unavailable|try again/i.test(text)) ??
      phrases[0] ??
      "The provider returned an unreadable web error.";
    const label = prefix || "Model provider request failed";
    return `${label}: ${detail}`.slice(0, 500);
  }

  return source.length > 1200 ? `${source.slice(0, 1199)}…` : source;
}

function renderedError(message: AgentMessage): string | null {
  if (typeof message.errorMessage === "string" && message.errorMessage.trim()) {
    return compactErrorMessage(message.errorMessage);
  }
  if (message.stopReason === "error" || message.isError === true) {
    return "Pi stopped without returning an error message.";
  }
  return null;
}

export function MessageContent({
  message,
  waiting = false,
}: {
  message: AgentMessage;
  waiting?: boolean;
}) {
  const error = renderedError(message);

  if (typeof message.content === "string") {
    return (
      <>
        <RichText text={message.content} />
        {error && <span className="message-error">{error}</span>}
      </>
    );
  }

  if (!Array.isArray(message.content) || message.content.length === 0) {
    if (error) return <span className="message-error">{error}</span>;
    return (
      <span className="message-placeholder">
        {waiting ? "Waiting for content" : "Pi returned no content."}
      </span>
    );
  }

  return (
    <>
      {message.content.map((block, index) => (
        <Content key={`${block.type}-${block.id ?? index}`} block={block} />
      ))}
      {error && <span className="message-error">{error}</span>}
    </>
  );
}
