"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ThemeToggle from "./ThemeToggle";

type Role = "user" | "assistant";
type AppMode = "quota_saver" | "quality";
type VoicePhase = "idle" | "requesting" | "recording" | "stopping" | "transcribing";
type VoiceTranscriptionMode = "browser" | "backend";

type Message = {
  role: Role;
  content: string;
  ts: string;
};

type SavedConversation = {
  id: string;
  title: string;
  messages: Message[];
  createdAt: string;
  updatedAt: string;
};

type ChatResponse = {
  reply: string;
  used_model?: string | null;
  last_tried_model?: string | null;
  model_errors?: string[];
  mode_detail?: string | null;
  candidate_models?: string[];
  hops_used?: number;
};

type SpeechBuffer = {
  finalSegments: Record<number, string>;
  interimSegments: Record<number, string>;
};

const WAVE_BAR_COUNT = 32;
const MAX_TEXTAREA_PX = 160;
const MAX_RECORDING_MS = 22_000;
const SILENCE_STOP_MS = 1_150;
const CHAT_HISTORY_STORAGE_KEY = "talk_to_ansuk_chat_history_v1";
const MAX_SAVED_CONVERSATIONS = 30;
const DEFAULT_ASSISTANT_GREETING =
  "Hey — I’m Ansuk. Ask me anything interview-style: projects, RL, strengths, growth areas, whatever.";
const FRESH_ASSISTANT_GREETING = "Fresh slate. Hit me with your best interview question.";

const CONFIGURED_API_BASE = normalizeApiBase(process.env.NEXT_PUBLIC_API_BASE_URL || "");
const VOICE_TRANSCRIPTION_MODE = normalizeVoiceTranscriptionMode(process.env.NEXT_PUBLIC_VOICE_TRANSCRIPTION_MODE);
const BROWSER_STT_LANG = process.env.NEXT_PUBLIC_BROWSER_STT_LANG || "en-IN";
const REQUIRE_LOCAL_BROWSER_STT = process.env.NEXT_PUBLIC_BROWSER_STT_PROCESS_LOCALLY === "true";
const AUTO_SEND_VOICE = process.env.NEXT_PUBLIC_AUTO_SEND_VOICE !== "false";

function normalizeApiBase(value: string) {
  return value.trim().replace(/\/+$/, "").replace(/\/api$/i, "");
}

function normalizeVoiceTranscriptionMode(value: unknown): VoiceTranscriptionMode {
  return String(value || "").toLowerCase() === "backend" ? "backend" : "browser";
}

function buildApiUrl(path: string) {
  if (!CONFIGURED_API_BASE) {
    throw new Error(
      "Chat service is not configured. Set NEXT_PUBLIC_API_BASE_URL in the frontend deployment, then redeploy."
    );
  }

  return `${CONFIGURED_API_BASE}${path.startsWith("/") ? path : `/${path}`}`;
}

function stringifyServerMessage(raw: string) {
  const text = raw.trim();
  if (!text) return "";

  try {
    const parsed = JSON.parse(text);
    const detail = parsed?.detail || parsed?.error || parsed?.message;
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail)) return detail.map((item) => item?.msg || JSON.stringify(item)).join("; ");
    if (parsed?.code === "NOT_FOUND" || parsed?.errorCode === "NOT_FOUND") return "Vercel returned NOT_FOUND.";
  } catch {
    // Fall through to text checks below.
  }

  if (/NOT_FOUND/i.test(text) || /page could not be found/i.test(text)) return "Vercel returned NOT_FOUND.";
  if (/<html|<!doctype/i.test(text)) return "The server returned an HTML error page instead of JSON.";
  return text.slice(0, 360);
}

async function responseErrorMessage(response: Response, area: "chat" | "transcription" | "health") {
  const raw = await response.text().catch(() => "");
  const detail = stringifyServerMessage(raw);

  if (response.status === 404) {
    return (
      "Backend route not found. This usually means the frontend is calling the wrong Vercel project/domain. " +
      "Set NEXT_PUBLIC_API_BASE_URL to the backend domain, and confirm that the backend /healthz route returns {\"ok\":true}."
    );
  }

  if (/Missing GEMINI_API_KEYS/i.test(detail)) {
    return "Model service is deployed, but GEMINI_API_KEYS is missing in the environment variables. Please add it to your Vercel dashboard.";
  }

  if (response.status === 413) {
    return "The audio file was too large for the backend. Record a shorter clip and try again.";
  }

  const prefix = area === "chat" ? "Chat request failed" : area === "transcription" ? "Transcription failed" : "Connection check failed";
  return `${prefix} (${response.status}). ${detail || response.statusText || "No useful error message returned."}`;
}

function friendlyRequestError(error: unknown, area: "chat" | "transcription") {
  const message = error instanceof Error ? error.message : String(error || "Request failed");

  if (/Chat service is not configured|Backend URL is not configured/i.test(message)) return message;
  if (/Failed to fetch|NetworkError|Load failed/i.test(message)) {
    return (
      "Could not reach the backend. Check NEXT_PUBLIC_API_BASE_URL in the frontend deployment and CORS_ORIGINS in the backend deployment. " +
      "Also verify that the backend /healthz endpoint opens in the browser."
    );
  }

  return message;
}

function hhmm() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function makeMsg(role: Role, content: string): Message {
  return { role, content, ts: hhmm() };
}

function makeConversationId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `conv_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function cleanConversationTitle(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function conversationTitle(messages: Message[]) {
  const firstUserMessage = messages.find((message) => message.role === "user")?.content || "";
  const title = cleanConversationTitle(firstUserMessage);
  if (!title) return "New conversation";
  return title.length > 62 ? `${title.slice(0, 59)}…` : title;
}

function conversationPreview(messages: Message[]) {
  const lastMeaningfulMessage = [...messages].reverse().find((message) => message.content.trim());
  const preview = cleanConversationTitle(lastMeaningfulMessage?.content || "No messages yet");
  return preview.length > 92 ? `${preview.slice(0, 89)}…` : preview;
}

function hasUserMessage(messages: Message[]) {
  return messages.some((message) => message.role === "user" && message.content.trim());
}

function isValidMessage(value: unknown): value is Message {
  if (!value || typeof value !== "object") return false;

  const candidate = value as Message;
  return (
    (candidate.role === "user" || candidate.role === "assistant") &&
    typeof candidate.content === "string" &&
    typeof candidate.ts === "string"
  );
}

function normalizeStoredConversations(value: unknown): SavedConversation[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => {
      if (!item || typeof item !== "object") return null;

      const candidate = item as Partial<SavedConversation>;
      const messages = Array.isArray(candidate.messages) ? candidate.messages.filter(isValidMessage) : [];
      if (!candidate.id || typeof candidate.id !== "string" || !hasUserMessage(messages)) return null;

      const createdAt = typeof candidate.createdAt === "string" ? candidate.createdAt : new Date().toISOString();
      const updatedAt = typeof candidate.updatedAt === "string" ? candidate.updatedAt : createdAt;

      return {
        id: candidate.id,
        title: typeof candidate.title === "string" && candidate.title.trim() ? candidate.title : conversationTitle(messages),
        messages,
        createdAt,
        updatedAt,
      };
    })
    .filter((item): item is SavedConversation => Boolean(item))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, MAX_SAVED_CONVERSATIONS);
}

function formatConversationTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  const now = new Date();
  const isSameDay = date.toDateString() === now.toDateString();
  if (isSameDay) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function isMobileViewport() {
  return typeof window !== "undefined" && window.matchMedia("(max-width: 840px)").matches;
}

function normalizeAppMode(value: unknown): AppMode {
  return String(value || "").toLowerCase() === "quality" ? "quality" : "quota_saver";
}

function initialWaveLevels() {
  return Array.from({ length: WAVE_BAR_COUNT }, (_, i) => 0.12 + ((i % 5) * 0.018));
}

function buildWaveLevels(rms: number) {
  const level = Math.min(1, Math.max(0.05, rms * 13));
  const now = Date.now() / 170;

  return Array.from({ length: WAVE_BAR_COUNT }, (_, i) => {
    const wave = 0.5 + 0.5 * Math.sin(now + i * 0.55);
    const ripple = 0.5 + 0.5 * Math.sin(now * 0.7 + i * 0.24);
    const mixed = level * (0.35 + wave * 0.45 + ripple * 0.2);
    return Math.max(0.08, Math.min(1, mixed));
  });
}

function parseLinkToken(token: string) {
  const match = token.match(/^\[([^\]]+)]\((https?:\/\/[^)\s]+)\)$/i);
  return match ? { label: match[1], href: match[2] } : null;
}

const SUBSCRIPT_CHARS: Record<string, string> = {
  "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
  "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎",
  a: "ₐ", e: "ₑ", h: "ₕ", i: "ᵢ", j: "ⱼ", k: "ₖ", l: "ₗ", m: "ₘ", n: "ₙ", o: "ₒ", p: "ₚ", r: "ᵣ", s: "ₛ", t: "ₜ", u: "ᵤ", v: "ᵥ", x: "ₓ",
  A: "ₐ", E: "ₑ", H: "ₕ", I: "ᵢ", J: "ⱼ", K: "ₖ", L: "ₗ", M: "ₘ", N: "ₙ", O: "ₒ", P: "ₚ", R: "ᵣ", S: "ₛ", T: "ₜ", U: "ᵤ", V: "ᵥ", X: "ₓ",
};

const SUPERSCRIPT_CHARS: Record<string, string> = {
  "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
  "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾",
  a: "ᵃ", b: "ᵇ", c: "ᶜ", d: "ᵈ", e: "ᵉ", f: "ᶠ", g: "ᵍ", h: "ʰ", i: "ⁱ", j: "ʲ", k: "ᵏ", l: "ˡ", m: "ᵐ", n: "ⁿ", o: "ᵒ", p: "ᵖ", r: "ʳ", s: "ˢ", t: "ᵗ", u: "ᵘ", v: "ᵛ", w: "ʷ", x: "ˣ", y: "ʸ", z: "ᶻ",
  A: "ᴬ", B: "ᴮ", D: "ᴰ", E: "ᴱ", G: "ᴳ", H: "ᴴ", I: "ᴵ", J: "ᴶ", K: "ᴷ", L: "ᴸ", M: "ᴹ", N: "ᴺ", O: "ᴼ", P: "ᴾ", R: "ᴿ", T: "ᵀ", U: "ᵁ", V: "ⱽ", W: "ᵂ",
};

const GREEK_SYMBOLS: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", eta: "η", theta: "θ", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", pi: "π", rho: "ρ", sigma: "σ", tau: "τ", phi: "φ", psi: "ψ", omega: "ω",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Sigma: "Σ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
};

const LATEX_SYMBOL_COMMANDS: Record<string, string> = {
  cdot: "·",
  times: "×",
  le: "≤",
  leq: "≤",
  leqslant: "≤",
  ge: "≥",
  geq: "≥",
  geqslant: "≥",
  neq: "≠",
  ne: "≠",
  approx: "≈",
  sim: "∼",
  equiv: "≡",
  // In this app the model mostly uses \succeq for portfolio-vector
  // non-negativity. Rendering it as ≥ is clearer than the formal partial-order
  // glyph for non-technical readers.
  succeq: "≥",
  preceq: "≤",
  succ: ">",
  prec: "<",
  infty: "∞",
  sum: "∑",
  prod: "∏",
  min: "min",
  max: "max",
  argmin: "argmin",
  argmax: "argmax",
  to: "→",
  mapsto: "↦",
  implies: "⇒",
  Rightarrow: "⇒",
  leftarrow: "←",
  Leftarrow: "⇐",
  iff: "⇔",
  Leftrightarrow: "⇔",
  in: "∈",
  notin: "∉",
  subset: "⊂",
  subseteq: "⊆",
  superset: "⊃",
  superseteq: "⊇",
  cap: "∩",
  cup: "∪",
  emptyset: "∅",
  forall: "∀",
  exists: "∃",
  nabla: "∇",
  partial: "∂",
  top: "ᵀ",
  transpose: "ᵀ",
  lVert: "‖",
  rVert: "‖",
  Vert: "‖",
  vert: "|",
  lbrace: "{",
  rbrace: "}",
  ell: "ℓ",
  ldots: "…",
  cdots: "⋯",
};

function toScript(value: string, table: Record<string, string>) {
  return value.split("").map((ch) => table[ch] || ch).join("");
}

function readLatexGroup(source: string, startIndex: number) {
  if (source[startIndex] !== "{") return null;

  let depth = 0;
  let cursor = startIndex;
  while (cursor < source.length) {
    const ch = source[cursor];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return {
          value: source.slice(startIndex + 1, cursor),
          nextIndex: cursor + 1,
        };
      }
    }
    cursor += 1;
  }

  return null;
}

function readLatexToken(source: string, startIndex: number) {
  const group = readLatexGroup(source, startIndex);
  if (group) return group;

  const remainder = source.slice(startIndex);
  const match = remainder.match(/^([A-Za-z0-9+\-=()]+)/);
  if (match) {
    return {
      value: match[1],
      nextIndex: startIndex + match[1].length,
    };
  }

  if (startIndex < source.length) {
    return {
      value: source[startIndex],
      nextIndex: startIndex + 1,
    };
  }

  return null;
}

function normalizeLatexExpression(source: string): string {
  let output = "";
  let i = 0;

  const pushWithOptionalParens = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return "";
    return /[ +\-=]/.test(trimmed) && !/^\(.+\)$/.test(trimmed) ? `(${trimmed})` : trimmed;
  };

  while (i < source.length) {
    const ch = source[i];

    const bareCommand = source.slice(i).match(/^(frac|tfrac|dfrac|text|mathrm|operatorname|mathbf|mathit|mathtt|boldsymbol|textrm)\s*(?=\{)/);
    if (bareCommand) {
      const command = bareCommand[1];
      i += command.length;
      while (source[i] === " ") i += 1;

      if (command === "frac" || command === "tfrac" || command === "dfrac") {
        const numerator = readLatexGroup(source, i);
        if (!numerator) {
          output += "frac";
          continue;
        }
        i = numerator.nextIndex;
        while (source[i] === " ") i += 1;
        const denominator = readLatexGroup(source, i);
        if (!denominator) {
          output += `${normalizeLatexExpression(numerator.value)}/`;
          continue;
        }
        i = denominator.nextIndex;
        const numText = pushWithOptionalParens(normalizeLatexExpression(numerator.value));
        const denText = pushWithOptionalParens(normalizeLatexExpression(denominator.value));
        output += `${numText}/${denText}`;
        continue;
      }

      const body = readLatexGroup(source, i);
      if (body) {
        output += normalizeLatexExpression(body.value);
        i = body.nextIndex;
      }
      continue;
    }

    const bareSymbolCommand = Object.keys(LATEX_SYMBOL_COMMANDS)
      .sort((a, b) => b.length - a.length)
      .find((name) => {
        if (!source.startsWith(name, i)) return false;
        const before = i === 0 ? "" : source[i - 1];
        const after = source[i + name.length] || "";
        return !/[A-Za-z]/.test(before) && !/[A-Za-z]/.test(after);
      });
    if (bareSymbolCommand) {
      output += LATEX_SYMBOL_COMMANDS[bareSymbolCommand];
      i += bareSymbolCommand.length;
      continue;
    }

    const bareGreekName = Object.keys(GREEK_SYMBOLS)
      .sort((a, b) => b.length - a.length)
      .find((name) => {
        if (!source.startsWith(name, i)) return false;
        const before = i === 0 ? "" : source[i - 1];
        const after = source[i + name.length] || "";
        return !/[A-Za-z]/.test(before) && !/[A-Za-z]/.test(after);
      });
    if (bareGreekName) {
      output += GREEK_SYMBOLS[bareGreekName];
      i += bareGreekName.length;
      continue;
    }

    if (ch === "\\") {
      const next = source[i + 1];
      if (next === "|" || next === "\\") {
        output += next === "|" ? "‖" : "\\";
        i += 2;
        continue;
      }

      const commandMatch = source.slice(i + 1).match(/^([A-Za-z]+)/);
      if (!commandMatch) {
        i += 1;
        continue;
      }

      const command = commandMatch[1];
      i += 1 + command.length;

      if (command === "frac" || command === "tfrac" || command === "dfrac") {
        const numerator = readLatexGroup(source, i);
        if (!numerator) {
          output += "frac";
          continue;
        }
        i = numerator.nextIndex;
        while (source[i] === " ") i += 1;
        const denominator = readLatexGroup(source, i);
        if (!denominator) {
          output += `${normalizeLatexExpression(numerator.value)}/`;
          continue;
        }
        i = denominator.nextIndex;
        const numText = pushWithOptionalParens(normalizeLatexExpression(numerator.value));
        const denText = pushWithOptionalParens(normalizeLatexExpression(denominator.value));
        output += `${numText}/${denText}`;
        continue;
      }

      if (command === "sqrt") {
        const body = readLatexGroup(source, i);
        if (!body) {
          output += "√";
          continue;
        }
        i = body.nextIndex;
        output += `√(${normalizeLatexExpression(body.value)})`;
        continue;
      }

      if (["text", "mathrm", "operatorname", "operatorname*", "mathbf", "mathit", "mathtt", "boldsymbol", "textrm"].includes(command)) {
        const body = readLatexGroup(source, i);
        if (body) {
          output += normalizeLatexExpression(body.value);
          i = body.nextIndex;
        }
        continue;
      }

      if (command === "left" || command === "right") {
        continue;
      }

      const symbol = GREEK_SYMBOLS[command];
      if (symbol) {
        output += symbol;
        continue;
      }

      output += LATEX_SYMBOL_COMMANDS[command] || command;
      continue;
    }

    if (ch === "_") {
      const token = readLatexToken(source, i + 1);
      if (token) {
        output += toScript(normalizeLatexExpression(token.value), SUBSCRIPT_CHARS);
        i = token.nextIndex;
        continue;
      }
    }

    if (ch === "^") {
      const token = readLatexToken(source, i + 1);
      if (token) {
        output += toScript(normalizeLatexExpression(token.value), SUPERSCRIPT_CHARS);
        i = token.nextIndex;
        continue;
      }
    }

    if (ch === "{" || ch === "}") {
      i += 1;
      continue;
    }

    output += ch;
    i += 1;
  }

  return output;
}

function formatMathText(raw: string) {
  let text = raw
    .replace(/\\/g, "\\")
    .replace(/\\,/g, " ")
    .replace(/\\;/g, " ")
    .replace(/\\!/g, "")
    .trim();

  text = normalizeLatexExpression(text)
    .replace(/‖\s+/g, "‖")
    .replace(/\s+‖/g, "‖")
    .replace(/\s*([+\-=])\s*/g, " $1 ")
    .replace(/\s+/g, " ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .replace(/\s+([,.;:])/g, "$1")
    .trim();

  return text;
}

function renderMath(raw: string, display = false) {
  const formatted = formatMathText(raw);
  const className = display
    ? "math-display-text"
    : formatted.length > 28
      ? "math-inline math-inline-long"
      : "math-inline";

  return <span className={className}>{formatted}</span>;
}

function renderInlineMarkdown(text: string): React.ReactNode[] {
  const tokenPattern = /(`[^`\n]+`|\*\*[^*\n]+?\*\*|\*[^*\n]+?\*|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\)|\\\([^\n]+?\\\)|\$[^$\n]+?\$)/g;
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(text)) !== null) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));

    const token = match[0];
    const key = `${match.index}-${token}`;
    const link = parseLinkToken(token);

    if (token.startsWith("`") && token.endsWith("`")) {
      nodes.push(
        <code key={key} className="markdown-inline-code">
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith("**") && token.endsWith("**")) {
      nodes.push(<strong key={key}>{renderInlineMarkdown(token.slice(2, -2))}</strong>);
    } else if (token.startsWith("*") && token.endsWith("*")) {
      nodes.push(<em key={key}>{renderInlineMarkdown(token.slice(1, -1))}</em>);
    } else if (link) {
      nodes.push(
        <a key={key} href={link.href} target="_blank" rel="noreferrer">
          {renderInlineMarkdown(link.label)}
        </a>
      );
    } else if (token.startsWith("\\(") && token.endsWith("\\)")) {
      nodes.push(<React.Fragment key={key}>{renderMath(token.slice(2, -2).trim())}</React.Fragment>);
    } else if (token.startsWith("$") && token.endsWith("$")) {
      nodes.push(<React.Fragment key={key}>{renderMath(token.slice(1, -1).trim())}</React.Fragment>);
    } else {
      nodes.push(token);
    }

    cursor = match.index + token.length;
  }

  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function isTableSeparator(line: string) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function splitTableRow(line: string) {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function renderMarkdownBlocks(markdown: string) {
  const blocks: React.ReactNode[] = [];
  const fencePattern = /```([\w+-]*)?\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let fence: RegExpExecArray | null;
  let blockIndex = 0;

  const pushTextBlocks = (text: string) => {
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    let i = 0;

    const nextKey = (prefix: string) => `${prefix}-${blockIndex++}`;

    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();

      if (!trimmed) {
        i += 1;
        continue;
      }

      const heading = trimmed.match(/^(#{1,4})\s+(.+)$/);
      if (heading) {
        const level = Math.min(4, heading[1].length);
        const headingContent = renderInlineMarkdown(heading[2]);
        if (level === 1) blocks.push(<h1 key={nextKey("heading")}>{headingContent}</h1>);
        else if (level === 2) blocks.push(<h2 key={nextKey("heading")}>{headingContent}</h2>);
        else if (level === 3) blocks.push(<h3 key={nextKey("heading")}>{headingContent}</h3>);
        else blocks.push(<h4 key={nextKey("heading")}>{headingContent}</h4>);
        i += 1;
        continue;
      }

      if (trimmed.startsWith("$$")) {
        const mathLines: string[] = [];
        const sameLine = trimmed.length > 2 ? trimmed.slice(2) : "";
        if (sameLine && sameLine.endsWith("$$")) {
          mathLines.push(sameLine.slice(0, -2));
          i += 1;
        } else {
          if (sameLine) mathLines.push(sameLine);
          i += 1;
          while (i < lines.length && !lines[i].trim().endsWith("$$")) {
            mathLines.push(lines[i]);
            i += 1;
          }
          if (i < lines.length) {
            mathLines.push(lines[i].trim().replace(/\$\$$/, ""));
            i += 1;
          }
        }
        blocks.push(<div key={nextKey("math")} className="math-display">{renderMath(mathLines.join("\n").trim(), true)}</div>);
        continue;
      }

      if (trimmed.startsWith("\\[") || trimmed.endsWith("\\]")) {
        const mathLines: string[] = [trimmed.replace(/^\\\[/, "").replace(/\\\]$/, "")];
        i += 1;
        while (i < lines.length && !lines[i].trim().endsWith("\\]")) {
          mathLines.push(lines[i]);
          i += 1;
        }
        if (i < lines.length) {
          mathLines.push(lines[i].trim().replace(/\\\]$/, ""));
          i += 1;
        }
        blocks.push(<div key={nextKey("math")} className="math-display">{renderMath(mathLines.join("\n").trim(), true)}</div>);
        continue;
      }

      if (trimmed.startsWith(">")) {
        const quoteLines: string[] = [];
        while (i < lines.length && lines[i].trim().startsWith(">")) {
          quoteLines.push(lines[i].trim().replace(/^>\s?/, ""));
          i += 1;
        }
        blocks.push(<blockquote key={nextKey("quote")}>{renderInlineMarkdown(quoteLines.join(" "))}</blockquote>);
        continue;
      }

      if (/^[-*]\s+/.test(trimmed)) {
        const items: string[] = [];
        while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
          items.push(lines[i].trim().replace(/^[-*]\s+/, ""));
          i += 1;
        }
        blocks.push(
          <ul key={nextKey("ul")}>
            {items.map((item, idx) => <li key={idx}>{renderInlineMarkdown(item)}</li>)}
          </ul>
        );
        continue;
      }

      if (/^\d+\.\s+/.test(trimmed)) {
        const items: string[] = [];
        while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
          items.push(lines[i].trim().replace(/^\d+\.\s+/, ""));
          i += 1;
        }
        blocks.push(
          <ol key={nextKey("ol")}>
            {items.map((item, idx) => <li key={idx}>{renderInlineMarkdown(item)}</li>)}
          </ol>
        );
        continue;
      }

      if (trimmed.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
        const header = splitTableRow(lines[i]);
        i += 2;
        const rows: string[][] = [];
        while (i < lines.length && lines[i].trim().includes("|")) {
          rows.push(splitTableRow(lines[i]));
          i += 1;
        }
        blocks.push(
          <div key={nextKey("table")} className="markdown-table-wrap">
            <table>
              <thead>
                <tr>{header.map((cell, idx) => <th key={idx}>{renderInlineMarkdown(cell)}</th>)}</tr>
              </thead>
              <tbody>
                {rows.map((row, rowIdx) => (
                  <tr key={rowIdx}>{header.map((_, cellIdx) => <td key={cellIdx}>{renderInlineMarkdown(row[cellIdx] || "")}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        );
        continue;
      }

      const paraLines: string[] = [trimmed];
      i += 1;
      while (i < lines.length) {
        const next = lines[i].trim();
        if (!next) break;
        if (/^(#{1,4})\s+/.test(next) || next.startsWith(">") || /^[-*]\s+/.test(next) || /^\d+\.\s+/.test(next) || next.startsWith("$$") || next.startsWith("\\[") || (next.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1]))) break;
        paraLines.push(next);
        i += 1;
      }
      blocks.push(<p key={nextKey("p")}>{renderInlineMarkdown(paraLines.join(" "))}</p>);
    }
  };

  while ((fence = fencePattern.exec(markdown)) !== null) {
    if (fence.index > lastIndex) pushTextBlocks(markdown.slice(lastIndex, fence.index));
    const language = fence[1] ? `language-${fence[1]}` : "";
    blocks.push(
      <pre key={`code-${blockIndex++}`} className="markdown-code-block">
        <code className={language}>{fence[2].replace(/\n$/, "")}</code>
      </pre>
    );
    lastIndex = fence.index + fence[0].length;
  }

  if (lastIndex < markdown.length) pushTextBlocks(markdown.slice(lastIndex));

  return blocks;
}

function MessageContent({ role, content }: Message) {
  if (role === "user") {
    return <div className="bubble-text plain-message">{content}</div>;
  }

  return <div className="bubble-text markdown-message">{renderMarkdownBlocks(content)}</div>;
}


function SidebarGlyph({ className = "" }: { className?: string }) {
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="3" y="4" width="18" height="16" rx="4" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M9 4v16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M6 8h.01M6 12h.01M6 16h.01" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

function NewChatGlyph({ className = "" }: { className?: string }) {
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M5 19h14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M7 15.5 16.7 5.8a2.1 2.1 0 0 1 3 3L10 18.5 6 19l1-3.5Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChatGlyph({ className = "" }: { className?: string }) {
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M5.5 17.5A7.3 7.3 0 1 1 9 20l-4 1 1-3.5Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SettingsGlyph({ className = "" }: { className?: string }) {
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M19.4 13.5a7.7 7.7 0 0 0 .05-1.5l1.7-1.3-1.9-3.2-2 .8a7.1 7.1 0 0 0-1.3-.75L15.6 5h-3.7l-.35 2.55c-.46.2-.9.45-1.3.75l-2-.8-1.9 3.2L8.05 12a7.7 7.7 0 0 0 .05 1.5l-1.75 1.35 1.9 3.2 2.08-.84c.38.28.8.51 1.24.7L11.9 20h3.7l.33-2.1c.45-.19.86-.43 1.25-.7l2.07.84 1.9-3.2-1.75-1.34Z" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function TrashGlyph({ className = "" }: { className?: string }) {
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M5 7h14M10 11v6M14 11v6M9 7l.6-2h4.8L15 7M7 7l.7 13h8.6L17 7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function Chat() {
  const DEFAULT_MODE = normalizeAppMode(process.env.NEXT_PUBLIC_APP_MODE);

  const [appMode, setAppMode] = useState<AppMode>(DEFAULT_MODE);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const modeMenuRef = useRef<HTMLDivElement | null>(null);

  const [messages, setMessages] = useState<Message[]>(() => [makeMsg("assistant", DEFAULT_ASSISTANT_GREETING)]);
  const messagesRef = useRef<Message[]>(messages);

  const [conversations, setConversations] = useState<SavedConversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false);
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const [portalReady, setPortalReady] = useState(false);
  const settingsMenuRef = useRef<HTMLDivElement | null>(null);
  const activeConversationIdRef = useRef<string | null>(null);

  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const [debugOpen, setDebugOpen] = useState(false);
  const [debug, setDebug] = useState<ChatResponse | null>(null);

  const [voicePhase, setVoicePhase] = useState<VoicePhase>("idle");
  const [voiceError, setVoiceError] = useState("");
  const [transcriptPreview, setTranscriptPreview] = useState("");
  const [waveLevels, setWaveLevels] = useState<number[]>(initialWaveLevels);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const waveformRafRef = useRef<number | null>(null);
  const maxRecTimerRef = useRef<number | null>(null);
  const lastWavePaintRef = useRef(0);
  const silenceSinceRef = useRef<number | null>(null);
  const hadSpeechRef = useRef(false);
  const recognitionRef = useRef<any>(null);
  const transcriptRef = useRef<SpeechBuffer>({ finalSegments: {}, interimSegments: {} });
  const nextFinalSegmentIdRef = useRef(0);
  const syntheticWaveformRafRef = useRef<number | null>(null);
  const browserSpeechAutoStopTimerRef = useRef<number | null>(null);
  const browserSpeechHadResultRef = useRef(false);
  const browserDoneRequestedRef = useRef(false);
  const voicePhaseRef = useRef<VoicePhase>("idle");

  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const latestUserMessageRef = useRef<HTMLDivElement | null>(null);
  const latestAssistantResponseRef = useRef<HTMLDivElement | null>(null);
  const lastUserScrollIndexRef = useRef(-1);
  const lastAssistantFocusIndexRef = useRef(-1);
  const composerFixedRef = useRef<HTMLDivElement | null>(null);
  const [composerHeight, setComposerHeight] = useState(184);
  const [keyboardInset, setKeyboardInset] = useState(0);

  const hasUserMessages = useMemo(() => messages.some((m) => m.role === "user"), [messages]);
  const sortedConversations = useMemo(
    () => [...conversations].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
    [conversations]
  );
  const latestUserMessageIndex = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === "user") return i;
    }
    return -1;
  }, [messages]);
  const latestAssistantResponseIndex = useMemo(() => {
    if (latestUserMessageIndex < 0) return -1;

    for (let i = messages.length - 1; i > latestUserMessageIndex; i -= 1) {
      if (messages[i].role === "assistant") return i;
    }

    return -1;
  }, [messages, latestUserMessageIndex]);
  const isVoiceActive = voicePhase !== "idle";

  useEffect(() => {
    setPortalReady(true);
  }, []);

  useEffect(() => {
    try {
      const saved = normalizeAppMode(window.localStorage.getItem("app_mode"));
      setAppMode(saved);
    } catch {
      // Local storage can be blocked in private browser modes.
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem("app_mode", appMode);
    } catch {
      // Ignore storage failures; the app still works.
    }
  }, [appMode]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(CHAT_HISTORY_STORAGE_KEY);
      const saved = normalizeStoredConversations(raw ? JSON.parse(raw) : []);
      setConversations(saved);
    } catch {
      setConversations([]);
    } finally {
      setHistoryLoaded(true);
    }

    const mediaQuery = window.matchMedia("(max-width: 840px)");
    setHistoryOpen(!mediaQuery.matches);

    const onViewportChange = (event: MediaQueryListEvent) => {
      setHistoryOpen(!event.matches);
    };

    mediaQuery.addEventListener("change", onViewportChange);
    return () => mediaQuery.removeEventListener("change", onViewportChange);
  }, []);

  useEffect(() => {
    if (!historyLoaded) return;

    try {
      window.localStorage.setItem(
        CHAT_HISTORY_STORAGE_KEY,
        JSON.stringify(sortedConversations.slice(0, MAX_SAVED_CONVERSATIONS))
      );
    } catch {
      // Local storage can fail in private mode or when the quota is full.
    }
  }, [historyLoaded, sortedConversations]);

  useEffect(() => {
    activeConversationIdRef.current = activeConversationId;
  }, [activeConversationId]);

  useEffect(() => {
    if (!historyLoaded || !activeConversationId || !hasUserMessage(messages)) return;

    const now = new Date().toISOString();
    setConversations((prev) => {
      const existing = prev.find((conversation) => conversation.id === activeConversationId);
      const createdAt = existing?.createdAt || now;
      const updated: SavedConversation = {
        id: activeConversationId,
        title: conversationTitle(messages),
        messages,
        createdAt,
        updatedAt: now,
      };

      return [updated, ...prev.filter((conversation) => conversation.id !== activeConversationId)]
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .slice(0, MAX_SAVED_CONVERSATIONS);
    });
  }, [activeConversationId, historyLoaded, messages]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    voicePhaseRef.current = voicePhase;
  }, [voicePhase]);

  useEffect(() => {
    if (!modeMenuOpen) return;

    const onPointerDown = (event: MouseEvent) => {
      const menu = modeMenuRef.current;
      if (menu && !menu.contains(event.target as Node)) setModeMenuOpen(false);
    };

    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [modeMenuOpen]);

  useEffect(() => {
    if (!settingsMenuOpen) return;

    const onPointerDown = (event: MouseEvent) => {
      if (debugOpen || confirmClearOpen) return;

      const menu = settingsMenuRef.current;
      if (menu && !menu.contains(event.target as Node)) setSettingsMenuOpen(false);
    };

    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [settingsMenuOpen, debugOpen, confirmClearOpen]);

  useEffect(() => {
    autosizePrompt();
  }, [input]);

  useEffect(() => {
    if (latestUserMessageIndex < 0 || lastUserScrollIndexRef.current === latestUserMessageIndex) return;

    lastUserScrollIndexRef.current = latestUserMessageIndex;
    window.requestAnimationFrame(() => {
      scrollChatElementTo(latestUserMessageRef.current, 8);
    });
  }, [latestUserMessageIndex]);

  useEffect(() => {
    if (busy || latestAssistantResponseIndex < 0 || lastAssistantFocusIndexRef.current === latestAssistantResponseIndex) return;

    lastAssistantFocusIndexRef.current = latestAssistantResponseIndex;
    window.requestAnimationFrame(() => {
      scrollChatElementTo(latestAssistantResponseRef.current, assistantLeadInOffset());
    });
  }, [busy, latestAssistantResponseIndex]);

  useEffect(() => {
    if (!hasUserMessages) return;

    const el = composerFixedRef.current;
    if (!el) return;

    const updateHeight = () => setComposerHeight(Math.ceil(el.getBoundingClientRect().height));
    updateHeight();

    const ro = new ResizeObserver(updateHeight);
    ro.observe(el);
    window.addEventListener("resize", updateHeight);

    return () => {
      ro.disconnect();
      window.removeEventListener("resize", updateHeight);
    };
  }, [hasUserMessages]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    let raf = 0;

    const updateKeyboardInset = () => {
      window.cancelAnimationFrame(raf);
      raf = window.requestAnimationFrame(() => {
        const viewport = window.visualViewport;
        const active = document.activeElement;
        const isEditable =
          active instanceof HTMLTextAreaElement ||
          active instanceof HTMLInputElement ||
          active instanceof HTMLSelectElement ||
          active instanceof HTMLElement && active.isContentEditable;
        const isMobileWidth = window.matchMedia("(max-width: 720px)").matches;

        if (!viewport || !isMobileWidth || !isEditable) {
          setKeyboardInset(0);
          return;
        }

        const rawInset = window.innerHeight - viewport.height - viewport.offsetTop;
        const nextInset = Math.max(0, Math.round(rawInset));
        setKeyboardInset(nextInset > 72 ? nextInset : 0);
      });
    };

    updateKeyboardInset();
    window.visualViewport?.addEventListener("resize", updateKeyboardInset);
    window.visualViewport?.addEventListener("scroll", updateKeyboardInset);
    window.addEventListener("resize", updateKeyboardInset);
    window.addEventListener("orientationchange", updateKeyboardInset);
    document.addEventListener("focusin", updateKeyboardInset);
    document.addEventListener("focusout", updateKeyboardInset);

    return () => {
      window.cancelAnimationFrame(raf);
      window.visualViewport?.removeEventListener("resize", updateKeyboardInset);
      window.visualViewport?.removeEventListener("scroll", updateKeyboardInset);
      window.removeEventListener("resize", updateKeyboardInset);
      window.removeEventListener("orientationchange", updateKeyboardInset);
      document.removeEventListener("focusin", updateKeyboardInset);
      document.removeEventListener("focusout", updateKeyboardInset);
    };
  }, []);

  useEffect(() => {
    return () => cleanupRecordingResources();
  }, []);

  function scrollChatElementTo(element: HTMLElement | null, offsetPx = 0) {
    if (!element) return;

    const scroller = chatScrollRef.current;
    if (!scroller) {
      element.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }

    const scrollerRect = scroller.getBoundingClientRect();
    const elementRect = element.getBoundingClientRect();
    const targetTop = scroller.scrollTop + elementRect.top - scrollerRect.top - offsetPx;
    const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);

    scroller.scrollTo({
      top: Math.min(maxScrollTop, Math.max(0, targetTop)),
      behavior: "smooth",
    });
  }

  function assistantLeadInOffset() {
    const userBubble = latestUserMessageRef.current;
    const fallback = window.matchMedia("(max-width: 720px)").matches ? 52 : 68;
    if (!userBubble) return fallback;

    const userHeight = userBubble.getBoundingClientRect().height;
    return Math.round(Math.max(44, Math.min(88, userHeight * 0.55)));
  }

  function focusPrompt() {
    inputRef.current?.focus();
  }

  function handlePromptFocus() {
    window.setTimeout(() => {
      inputRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }, 80);
  }

  function keepPromptFocused(event: React.PointerEvent<HTMLElement>) {
    // Mobile browsers blur the textarea as soon as a button receives pointerdown.
    // Preventing the default pointer focus keeps the keyboard open while the
    // mode selector is used, without changing send/mic behavior.
    if (document.activeElement === inputRef.current) event.preventDefault();
  }

  function selectMode(mode: AppMode) {
    setAppMode(mode);
    setModeMenuOpen(false);

    if (document.activeElement === inputRef.current) {
      window.requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
    }
  }

  function autosizePrompt() {
    const el = inputRef.current;
    if (!el) return;

    el.style.height = "auto";
    const next = Math.min(el.scrollHeight, MAX_TEXTAREA_PX);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > MAX_TEXTAREA_PX ? "auto" : "hidden";
  }

  function ensureActiveConversation() {
    if (activeConversationIdRef.current) return activeConversationIdRef.current;

    const id = makeConversationId();
    activeConversationIdRef.current = id;
    setActiveConversationId(id);
    return id;
  }

  async function callChat(nextMessages: Message[]) {
    setBusy(true);
    setDebug(null);

    try {
      const res = await fetch(buildApiUrl("/api/chat"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: nextMessages, app_mode: appMode }),
      });

      if (!res.ok) throw new Error(await responseErrorMessage(res, "chat"));

      const data: ChatResponse = await res.json();
      const botMsg = makeMsg("assistant", data.reply);
      setMessages((prev) => [...prev, botMsg]);
      setDebug(data);
    } catch (error: unknown) {
      const errMsg = friendlyRequestError(error, "chat").slice(0, 520);
      setMessages((prev) => [...prev, makeMsg("assistant", `⚠️ ${errMsg}`)]);
    } finally {
      setBusy(false);
    }
  }

  async function sendText() {
    const text = input.trim();
    if (!text || busy || isVoiceActive) return;

    setInput("");
    requestAnimationFrame(() => autosizePrompt());

    ensureActiveConversation();
    const next = [...messagesRef.current, makeMsg("user", text)];
    setMessages(next);
    await callChat(next);
  }

  function appendVoiceTranscriptToPrompt(text: string) {
    const clean = normalizeSpeechText(text);
    setVoicePhase("idle");
    setTranscriptPreview("");

    if (!clean) {
      setVoiceError("I could not detect clear speech. Try again closer to the mic.");
      return false;
    }

    setInput((prev) => normalizeSpeechText(`${prev} ${clean}`));
    requestAnimationFrame(() => {
      autosizePrompt();
      focusPrompt();
    });
    return true;
  }

  async function commitVoiceTranscript(text: string) {
    const clean = normalizeSpeechText(text);

    if (!AUTO_SEND_VOICE) {
      appendVoiceTranscriptToPrompt(clean);
      return;
    }

    setTranscriptPreview("");

    if (!clean) {
      setVoicePhase("idle");
      setVoiceError("I could not detect clear speech. Try again closer to the mic.");
      return;
    }

    setInput(clean);
    requestAnimationFrame(() => autosizePrompt());
    await new Promise((resolve) => window.setTimeout(resolve, 90));

    setInput("");
    setVoicePhase("idle");
    ensureActiveConversation();
    const next = [...messagesRef.current, makeMsg("user", clean)];
    setMessages(next);
    await callChat(next);
  }

  function newChat() {
    if (busy) return;

    cleanupRecordingResources();
    activeConversationIdRef.current = null;
    setActiveConversationId(null);
    setVoicePhase("idle");
    setTranscriptPreview("");
    setVoiceError("");
    setInput("");
    setMessages([makeMsg("assistant", FRESH_ASSISTANT_GREETING)]);
    setDebug(null);
    setDebugOpen(false);

    if (isMobileViewport()) setHistoryOpen(false);
  }

  function openConversation(conversation: SavedConversation) {
    if (busy) return;

    cleanupRecordingResources();
    activeConversationIdRef.current = conversation.id;
    setActiveConversationId(conversation.id);
    setMessages(conversation.messages);
    setInput("");
    setVoicePhase("idle");
    setTranscriptPreview("");
    setVoiceError("");
    setDebug(null);
    setDebugOpen(false);

    if (isMobileViewport()) setHistoryOpen(false);

    window.requestAnimationFrame(() => {
      const scroller = chatScrollRef.current;
      if (scroller) scroller.scrollTo({ top: scroller.scrollHeight, behavior: "auto" });
    });
  }

  function deleteConversation(conversationId: string, event: React.MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    if (busy) return;

    setConversations((prev) => prev.filter((conversation) => conversation.id !== conversationId));

    if (activeConversationIdRef.current === conversationId) {
      activeConversationIdRef.current = null;
      setActiveConversationId(null);
      setMessages([makeMsg("assistant", DEFAULT_ASSISTANT_GREETING)]);
      setDebug(null);
      setDebugOpen(false);
    }
  }

  function clearAllLocalHistory() {
    if (busy) return;

    cleanupRecordingResources();
    setConversations([]);
    activeConversationIdRef.current = null;
    setActiveConversationId(null);
    setMessages([makeMsg("assistant", FRESH_ASSISTANT_GREETING)]);
    setInput("");
    setVoicePhase("idle");
    setTranscriptPreview("");
    setVoiceError("");
    setDebug(null);
    setDebugOpen(false);
    setConfirmClearOpen(false);

    try {
      window.localStorage.removeItem(CHAT_HISTORY_STORAGE_KEY);
    } catch {
      // Ignore storage failures; the in-memory state is already cleared.
    }

    if (isMobileViewport()) {
      setHistoryOpen(false);
      setSettingsMenuOpen(false);
    }
  }

  function fillPrompt(text: string) {
    setInput(text);
    requestAnimationFrame(() => {
      autosizePrompt();
      focusPrompt();
    });
  }

  function onPromptKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    const isComposing = (e.nativeEvent as any)?.isComposing;
    if (e.key === "Enter" && !e.shiftKey && !isComposing) {
      e.preventDefault();
      sendText();
    }
  }

  function modeLabel(m: AppMode) {
    return m === "quality" ? "Quality" : "Quota saver";
  }

  function modeSubtitle(m: AppMode) {
    return m === "quality" ? "Deep reasoning" : "Balanced quality";
  }

  function setMode(m: AppMode) {
    setAppMode(m);
    setModeMenuOpen(false);
  }

  function resetVoiceRefs() {
    chunksRef.current = [];
    silenceSinceRef.current = null;
    hadSpeechRef.current = false;
    browserSpeechHadResultRef.current = false;
    browserDoneRequestedRef.current = false;
    transcriptRef.current = { finalSegments: {}, interimSegments: {} };
    nextFinalSegmentIdRef.current = 0;
  }

  function stopWaveform() {
    if (syntheticWaveformRafRef.current != null) {
      cancelAnimationFrame(syntheticWaveformRafRef.current);
      syntheticWaveformRafRef.current = null;
    }

    if (waveformRafRef.current != null) {
      cancelAnimationFrame(waveformRafRef.current);
      waveformRafRef.current = null;
    }
    lastWavePaintRef.current = 0;
    setWaveLevels(initialWaveLevels());
  }

  function clearVoiceTimers() {
    if (maxRecTimerRef.current != null) {
      window.clearTimeout(maxRecTimerRef.current);
      maxRecTimerRef.current = null;
    }

    if (browserSpeechAutoStopTimerRef.current != null) {
      window.clearTimeout(browserSpeechAutoStopTimerRef.current);
      browserSpeechAutoStopTimerRef.current = null;
    }
  }

  function cleanupVoiceInputMedia() {
    stopWaveform();

    try {
      if (audioCtxRef.current?.state !== "closed") audioCtxRef.current?.close?.();
    } catch {
      // Browser may already close it.
    }
    audioCtxRef.current = null;

    try {
      streamRef.current?.getTracks?.().forEach((track) => track.stop());
    } catch {
      // Ignore device cleanup failures.
    }
    streamRef.current = null;
  }

  function cleanupRecordingResources() {
    cleanupVoiceInputMedia();
    clearVoiceTimers();

    try {
      recognitionRef.current?.stop?.();
    } catch {
      // Already stopped.
    }
    recognitionRef.current = null;

    mediaRecorderRef.current = null;
    resetVoiceRefs();
  }

  function stopRecording() {
    const recorder = mediaRecorderRef.current;
    setVoicePhase("stopping");

    try {
      recognitionRef.current?.stop?.();
    } catch {
      // SpeechRecognition may already be stopped.
    }

    try {
      if (recorder && recorder.state === "recording") recorder.stop();
      else cleanupRecordingResources();
    } catch {
      cleanupRecordingResources();
      setVoicePhase("idle");
    }
  }

  function getSpeechRecognitionCtor() {
    if (typeof window === "undefined") return null;
    return (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition || null;
  }

  function collapseRepeatedTrailingChunks(words: string[]) {
    const out: string[] = [];

    for (const word of words) {
      out.push(word);

      let changed = true;
      while (changed) {
        changed = false;
        const maxChunk = Math.floor(out.length / 2);

        for (let size = maxChunk; size >= 1; size -= 1) {
          const a = out.slice(out.length - size * 2, out.length - size).join(" ").toLowerCase();
          const b = out.slice(out.length - size).join(" ").toLowerCase();

          if (a && a === b) {
            out.splice(out.length - size, size);
            changed = true;
            break;
          }
        }
      }
    }

    return out;
  }

  function normalizeSpeechText(text: string) {
    const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
    return collapseRepeatedTrailingChunks(words).join(" ").trim();
  }

  function orderedSegmentText(segments: Record<number, string>) {
    return Object.entries(segments)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([, text]) => text.trim())
      .filter(Boolean)
      .join(" ");
  }

  function buildFinalTranscriptText() {
    return normalizeSpeechText(orderedSegmentText(transcriptRef.current.finalSegments));
  }

  function buildTranscriptText() {
    const { finalSegments, interimSegments } = transcriptRef.current;
    return normalizeSpeechText(`${orderedSegmentText(finalSegments)} ${orderedSegmentText(interimSegments)}`);
  }

  function scheduleBrowserSpeechAutoStop(rec: any) {
    if (browserSpeechAutoStopTimerRef.current != null) {
      window.clearTimeout(browserSpeechAutoStopTimerRef.current);
    }

    browserSpeechAutoStopTimerRef.current = window.setTimeout(() => {
      try {
        rec.stop();
      } catch {
        // Already stopped by the browser.
      }
    }, SILENCE_STOP_MS);
  }

  function configureSpeechRecognitionHandlers(rec: any, submitOnEnd: boolean) {
    rec.lang = BROWSER_STT_LANG;
    rec.interimResults = false;
    rec.continuous = false;
    rec.maxAlternatives = 1;

    if (REQUIRE_LOCAL_BROWSER_STT && "processLocally" in rec) {
      try {
        rec.processLocally = true;
      } catch {
        // Older browsers expose the property but do not let it be assigned.
      }
    }

    rec.onresult = (event: any) => {
      let hasUsableResult = false;

      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const text = normalizeSpeechText(String(result[0]?.transcript || ""));
        if (!text) continue;

        hasUsableResult = true;

        if (result.isFinal) {
          transcriptRef.current.finalSegments[nextFinalSegmentIdRef.current] = text;
          nextFinalSegmentIdRef.current += 1;
          delete transcriptRef.current.interimSegments[i];
        }
      }

      if (hasUsableResult) browserSpeechHadResultRef.current = true;
    };

    rec.onspeechend = () => {
      // Do not auto-stop. The user controls completion with the Done button.
    };

    rec.onerror = (event: any) => {
      const code = String(event?.error || "").trim();
      if (code && code !== "no-speech" && code !== "aborted") {
        setVoiceError(`Browser speech recognition failed${code ? `: ${code}` : ""}. Try typing, or set NEXT_PUBLIC_VOICE_TRANSCRIPTION_MODE=backend.`);
      }
    };

    rec.onend = async () => {
      clearVoiceTimers();
      recognitionRef.current = null;

      if (!submitOnEnd) return;

      if (!browserDoneRequestedRef.current && voicePhaseRef.current === "recording") {
        restartBrowserRecognition();
        return;
      }

      const text = buildFinalTranscriptText() || buildTranscriptText();
      if (!text) {
        setVoicePhase("idle");
        setTranscriptPreview("");
        setVoiceError(
          browserSpeechHadResultRef.current
            ? "The browser heard something but did not produce usable text. Try again closer to the mic."
            : "I could not detect clear speech. Try again closer to the mic."
        );
        resetVoiceRefs();
        return;
      }

      setVoicePhase("transcribing");
      window.setTimeout(() => {
        void commitVoiceTranscript(text);
      }, 180);
    };
  }

  function startSpeechRecognitionIfAvailable() {
    const SpeechRecognitionCtor = getSpeechRecognitionCtor();
    if (!SpeechRecognitionCtor) return;

    try {
      const rec = new SpeechRecognitionCtor();
      recognitionRef.current = rec;
      configureSpeechRecognitionHandlers(rec, false);
      rec.start();
    } catch {
      recognitionRef.current = null;
    }
  }

  function restartBrowserRecognition() {
    const SpeechRecognitionCtor = getSpeechRecognitionCtor();
    if (!SpeechRecognitionCtor || browserDoneRequestedRef.current) return;

    try {
      const rec = new SpeechRecognitionCtor();
      recognitionRef.current = rec;
      configureSpeechRecognitionHandlers(rec, true);
      rec.start();
    } catch {
      // Some mobile browsers end recognition after silence and refuse immediate restart.
      // Keep the waveform active and wait for the user to tap Done.
      recognitionRef.current = null;
    }
  }

  function startSyntheticWaveformPreview() {
    stopWaveform();

    const tick = () => {
      const now = Date.now() / 165;
      setWaveLevels(
        Array.from({ length: WAVE_BAR_COUNT }, (_, i) => {
          const wave = 0.5 + 0.5 * Math.sin(now + i * 0.62);
          const pulse = 0.5 + 0.5 * Math.sin(now * 0.63 + i * 0.28);
          return Math.max(0.12, Math.min(1, 0.18 + wave * 0.48 + pulse * 0.18));
        })
      );
      syntheticWaveformRafRef.current = requestAnimationFrame(tick);
    };

    syntheticWaveformRafRef.current = requestAnimationFrame(tick);
  }

  async function startBrowserWaveformPreview() {
    if (!navigator.mediaDevices?.getUserMedia) return;

    const rawStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      } as MediaTrackConstraints,
    });
    streamRef.current = rawStream;

    const AudioContextCtor = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextCtor) return;

    const audioCtx: AudioContext = new AudioContextCtor();
    audioCtxRef.current = audioCtx;
    await audioCtx.resume?.();

    const source = audioCtx.createMediaStreamSource(rawStream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.82;
    source.connect(analyser);
    startWaveform(analyser, { autoStopOnSilence: false });
  }

  async function startBrowserSpeechInput() {
    const SpeechRecognitionCtor = getSpeechRecognitionCtor();
    if (!SpeechRecognitionCtor) {
      setVoiceError("This browser does not support speech recognition. Use Chrome/Edge, type the question, or switch NEXT_PUBLIC_VOICE_TRANSCRIPTION_MODE=backend.");
      setVoicePhase("idle");
      return;
    }

    browserDoneRequestedRef.current = false;
    setVoicePhase("requesting");

    try {
      if (REQUIRE_LOCAL_BROWSER_STT && typeof SpeechRecognitionCtor.available === "function") {
        const status = await SpeechRecognitionCtor.available({ langs: [BROWSER_STT_LANG], processLocally: true });
        if (status === "downloadable" && typeof SpeechRecognitionCtor.install === "function") {
          await SpeechRecognitionCtor.install({ langs: [BROWSER_STT_LANG], processLocally: true });
        } else if (status === "unavailable") {
          throw new Error(`On-device speech recognition is unavailable for ${BROWSER_STT_LANG} in this browser.`);
        }
      }

      // In browser-STT mode, do not open a second getUserMedia microphone stream for the waveform.
      // Mobile browsers often let the visualizer access the mic while SpeechRecognition then returns no transcript.
      // This animated waveform keeps the UI feedback without competing with SpeechRecognition for audio capture.
      startSyntheticWaveformPreview();

      const rec = new SpeechRecognitionCtor();
      recognitionRef.current = rec;
      configureSpeechRecognitionHandlers(rec, true);
      rec.start();
      setVoicePhase("recording");
    } catch (error: unknown) {
      clearVoiceTimers();
      cleanupVoiceInputMedia();
      recognitionRef.current = null;
      setVoicePhase("idle");
      setVoiceError(error instanceof Error ? error.message : "Could not start browser speech recognition.");
    }
  }

  function stopBrowserSpeechInput() {
    browserDoneRequestedRef.current = true;
    setVoicePhase("transcribing");
    clearVoiceTimers();
    cleanupVoiceInputMedia();

    const rec = recognitionRef.current;
    if (!rec) {
      const text = buildFinalTranscriptText() || buildTranscriptText();
      if (text) void commitVoiceTranscript(text);
      else setVoicePhase("idle");
      return;
    }

    try {
      rec.stop?.();
    } catch {
      const text = buildFinalTranscriptText() || buildTranscriptText();
      if (text) void commitVoiceTranscript(text);
      else setVoicePhase("idle");
    }
  }

  function startWaveform(analyser: AnalyserNode, options: { autoStopOnSilence?: boolean } = {}) {
    const data = new Uint8Array(analyser.fftSize);
    let noiseFloor = 0.01;

    const tick = () => {
      analyser.getByteTimeDomainData(data);

      let sum = 0;
      for (let i = 0; i < data.length; i += 1) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }

      const rms = Math.sqrt(sum / data.length);
      const alpha = hadSpeechRef.current ? 0.99 : 0.94;
      noiseFloor = alpha * noiseFloor + (1 - alpha) * rms;

      const now = Date.now();
      if (now - lastWavePaintRef.current > 65) {
        lastWavePaintRef.current = now;
        setWaveLevels(buildWaveLevels(rms));
      }

      const speechThreshold = Math.max(noiseFloor * 3.3, 0.012);
      if (rms > speechThreshold) {
        hadSpeechRef.current = true;
        silenceSinceRef.current = null;
      } else if (options.autoStopOnSilence !== false && hadSpeechRef.current) {
        if (silenceSinceRef.current == null) silenceSinceRef.current = now;
        if (now - silenceSinceRef.current > SILENCE_STOP_MS) {
          stopRecording();
          return;
        }
      }

      waveformRafRef.current = requestAnimationFrame(tick);
    };

    waveformRafRef.current = requestAnimationFrame(tick);
  }

  async function toggleRecording() {
    if (busy) return;

    if (voicePhase === "recording" || voicePhase === "requesting") {
      if (VOICE_TRANSCRIPTION_MODE === "browser") stopBrowserSpeechInput();
      else stopRecording();
      return;
    }

    if (voicePhase === "stopping" || voicePhase === "transcribing") return;

    setVoiceError("");
    setTranscriptPreview("");
    resetVoiceRefs();

    if (VOICE_TRANSCRIPTION_MODE === "browser") {
      await startBrowserSpeechInput();
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setVoiceError("Your browser does not expose microphone capture. Use Chrome/Edge or type the question.");
      return;
    }

    if (!(window as any).MediaRecorder) {
      setVoiceError("This browser cannot record audio from the mic. Use Chrome/Edge for voice input.");
      return;
    }

    setVoicePhase("requesting");

    try {
      const rawStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        } as MediaTrackConstraints,
      });
      streamRef.current = rawStream;

      const AudioContextCtor = (window as any).AudioContext || (window as any).webkitAudioContext;
      const audioCtx: AudioContext | null = AudioContextCtor ? new AudioContextCtor() : null;
      audioCtxRef.current = audioCtx;

      let recordStream = rawStream;
      if (audioCtx) {
        await audioCtx.resume?.();
        const source = audioCtx.createMediaStreamSource(rawStream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0.82;

        const compressor = audioCtx.createDynamicsCompressor();
        compressor.threshold.setValueAtTime(-45, audioCtx.currentTime);
        compressor.knee.setValueAtTime(30, audioCtx.currentTime);
        compressor.ratio.setValueAtTime(10, audioCtx.currentTime);
        compressor.attack.setValueAtTime(0.004, audioCtx.currentTime);
        compressor.release.setValueAtTime(0.22, audioCtx.currentTime);

        const gain = audioCtx.createGain();
        gain.gain.setValueAtTime(1.16, audioCtx.currentTime);

        const destination = audioCtx.createMediaStreamDestination();
        source.connect(analyser);
        source.connect(compressor);
        compressor.connect(gain);
        gain.connect(destination);
        recordStream = destination.stream;
        startWaveform(analyser, { autoStopOnSilence: true });
      }

      const mimeCandidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
      const mimeType = mimeCandidates.find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = mimeType
        ? new MediaRecorder(recordStream, { mimeType, audioBitsPerSecond: 128000 })
        : new MediaRecorder(recordStream, { audioBitsPerSecond: 128000 });

      mediaRecorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };

      recorder.onerror = () => {
        setVoiceError("Recording failed. Check mic permission and try again.");
        cleanupRecordingResources();
        setVoicePhase("idle");
      };

      recorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        cleanupRecordingResources();

        setVoicePhase("transcribing");

        if (blob.size < 900) {
          setVoicePhase("idle");
          setVoiceError("That recording was too short or silent. Try again.");
          return;
        }

        try {
          const form = new FormData();
          form.append("file", blob, "voice.webm");
          const response = await fetch(buildApiUrl("/api/transcribe"), { method: "POST", body: form });
          if (!response.ok) throw new Error(await responseErrorMessage(response, "transcription"));

          const data = (await response.json()) as { text?: string };
          const text = String(data.text || "").trim();

          if (!text) {
            setVoicePhase("idle");
            setVoiceError("I could not detect clear speech. Try again closer to the mic.");
            return;
          }

          await commitVoiceTranscript(text);
        } catch (error: unknown) {
          setVoicePhase("idle");
          setVoiceError(friendlyRequestError(error, "transcription"));
        }
      };

      recorder.start(250);
      setVoicePhase("recording");

      maxRecTimerRef.current = window.setTimeout(() => stopRecording(), MAX_RECORDING_MS);
    } catch (error: any) {
      cleanupRecordingResources();
      setVoicePhase("idle");
      const denied = String(error?.name || "").toLowerCase().includes("notallowed");
      setVoiceError(denied ? "Microphone permission was denied." : "Could not start the microphone.");
    }
  }

  function renderModeSelector() {
    return (
      <div className="mode-wrap" ref={modeMenuRef}>
        <button
          className="mode-pill"
          type="button"
          onPointerDown={keepPromptFocused}
          onClick={() => setModeMenuOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={modeMenuOpen}
          title="Choose response mode"
        >
          <span className="mode-pill-label">{modeLabel(appMode)}</span>
          <span className="mode-pill-chev" aria-hidden="true">
            ▾
          </span>
        </button>

        {modeMenuOpen ? (
          <div className="mode-menu" role="menu" aria-label="Mode selection">
            {(["quota_saver", "quality"] as AppMode[]).map((mode) => (
              <button
                key={mode}
                className="mode-item"
                role="menuitem"
                onPointerDown={keepPromptFocused}
                onClick={() => selectMode(mode)}
                aria-checked={appMode === mode}
              >
                <div className="mode-item-text">
                  <div className="mode-item-title">{modeLabel(mode)}</div>
                  <div className="mode-item-sub">{modeSubtitle(mode)}</div>
                </div>
                {appMode === mode ? <div className="mode-check">✓</div> : null}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  function dismissVoiceNotice() {
    setVoiceError("");
    setTranscriptPreview("");
  }

  function renderVoiceStatus() {
    if (!isVoiceActive && !voiceError && !transcriptPreview) return null;

    const title =
      voicePhase === "requesting"
        ? "Requesting microphone…"
        : voicePhase === "recording"
          ? "Listening"
          : voicePhase === "stopping"
            ? "Finishing recording…"
            : voicePhase === "transcribing"
              ? "Transcribing"
              : voiceError
                ? "Voice input needs attention"
                : "Transcript";

    const subtitle =
      voicePhase === "recording"
        ? "Recording. Tap Done when you finish speaking."
        : voicePhase === "transcribing"
          ? "Transcribing and sending…"
          : voiceError || transcriptPreview;

    return (
      <div className={`voice-panel ${voiceError ? "has-error" : ""}`} aria-live="polite">
        <div className="voice-panel-top">
          <div>
            <div className="voice-title">{title}</div>
            {subtitle ? <div className="voice-subtitle">{subtitle}</div> : null}
          </div>
          {voicePhase === "recording" ? (
            <button
              className="voice-stop-btn"
              type="button"
              onClick={VOICE_TRANSCRIPTION_MODE === "browser" ? stopBrowserSpeechInput : stopRecording}
            >
              Done
            </button>
          ) : voiceError || transcriptPreview ? (
            <button
              className="voice-close-btn"
              type="button"
              onPointerDown={keepPromptFocused}
              onClick={dismissVoiceNotice}
              aria-label="Dismiss voice notification"
              title="Dismiss"
            >
              ×
            </button>
          ) : null}
        </div>

        {voicePhase === "recording" || voicePhase === "requesting" ? (
          <div className="waveform" aria-hidden="true">
            {waveLevels.map((level, i) => (
              <span key={i} style={{ transform: `scaleY(${level})` }} />
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  function renderMobileHistoryButton() {
    return (
      <button
        className={`ghost-btn history-floating-btn sidebar-icon-button ${historyOpen ? "is-hidden" : ""}`}
        type="button"
        onClick={() => setHistoryOpen(true)}
        aria-label="Open chat history"
        aria-expanded={historyOpen}
        title="Chat history"
      >
        <SidebarGlyph />
      </button>
    );
  }

  function renderHistorySidebar() {
    const toggleLabel = historyOpen ? "Close chat history" : "Open chat history";

    const openSettingsFromRail = () => {
      setHistoryOpen(true);
      setSettingsMenuOpen(true);
    };

    return (
      <>
        {portalReady ? createPortal(renderMobileHistoryButton(), document.body) : null}

        <div
          className={`history-backdrop ${historyOpen ? "is-open" : ""}`}
          onClick={() => setHistoryOpen(false)}
          aria-hidden="true"
        />

        <aside className={`history-sidebar ${historyOpen ? "is-open" : ""}`} aria-label="Chat history">
          <div className="history-rail" aria-label="Sidebar shortcuts">
            <div className="history-rail-top">
              <button
                className="history-rail-btn"
                type="button"
                onClick={() => setHistoryOpen((value) => !value)}
                aria-label={toggleLabel}
                title={toggleLabel}
              >
                <SidebarGlyph />
              </button>
              <button
                className="history-rail-btn"
                type="button"
                onClick={newChat}
                aria-label="New chat"
                title="New chat"
                disabled={busy}
              >
                <NewChatGlyph />
              </button>
              <button
                className="history-rail-btn"
                type="button"
                onClick={() => setHistoryOpen(true)}
                aria-label="Show saved conversations"
                title="Saved conversations"
              >
                <ChatGlyph />
              </button>
            </div>

            <button
              className="history-rail-btn history-rail-settings"
              type="button"
              onClick={openSettingsFromRail}
              aria-label="Open settings"
              title="Settings"
            >
              <SettingsGlyph />
            </button>
          </div>

          <div className="history-panel">
            <div className="history-sidebar-header">
              <div className="history-heading">
                <span className="history-heading-icon" aria-hidden="true"><SidebarGlyph /></span>
                <div>
                  <div className="history-title">Chat history</div>
                  <div className="history-subtitle">Saved on this device</div>
                </div>
              </div>
              <button
                className="history-close-btn"
                type="button"
                onClick={() => setHistoryOpen(false)}
                aria-label="Close chat history"
                title="Close sidebar"
              >
                <SidebarGlyph />
              </button>
            </div>

            <button className="history-new-chat-btn" type="button" onClick={newChat} disabled={busy}>
              <NewChatGlyph />
              <span>New chat</span>
            </button>

            <div className="history-list-shell">
              <div className="history-section-label">Previous conversations</div>

              <div className="history-list" role="list">
                {sortedConversations.length ? (
                  sortedConversations.map((conversation) => {
                    const isActive = conversation.id === activeConversationId;

                    return (
                      <div
                        key={conversation.id}
                        className={`history-item ${isActive ? "is-active" : ""}`}
                        role="listitem"
                        aria-current={isActive ? "true" : undefined}
                      >
                        <button
                          className="history-item-open"
                          type="button"
                          onClick={() => openConversation(conversation)}
                          disabled={busy}
                        >
                          <span className="history-item-title">{conversation.title}</span>
                          <span className="history-item-preview">{conversationPreview(conversation.messages)}</span>
                        </button>
                        <span className="history-item-meta">
                          <span>{formatConversationTime(conversation.createdAt)}</span>
                          <button
                            className="history-delete-btn"
                            type="button"
                            onClick={(event) => deleteConversation(conversation.id, event)}
                            aria-label={`Delete ${conversation.title}`}
                            title="Delete conversation"
                            disabled={busy}
                          >
                            ×
                          </button>
                        </span>
                      </div>
                    );
                  })
                ) : (
                  <div className="history-empty">
                    Conversations will appear here after you send your first message.
                  </div>
                )}
              </div>
            </div>

            <div className="history-settings" aria-label="Sidebar settings" ref={settingsMenuRef}>
              <button
                className={`history-settings-trigger ${settingsMenuOpen ? "is-open" : ""}`}
                type="button"
                onClick={() => setSettingsMenuOpen((value) => !value)}
                aria-haspopup="menu"
                aria-expanded={settingsMenuOpen}
              >
                <span className="history-settings-trigger-main">
                  <span className="history-settings-icon" aria-hidden="true"><SettingsGlyph /></span>
                  <span>
                    <span className="history-settings-title">Settings</span>
                    <span className="history-settings-subtitle">Theme, model details, local data</span>
                  </span>
                </span>
                <span className="history-settings-chevron" aria-hidden="true">▾</span>
              </button>

              {settingsMenuOpen ? (
                <div className="settings-dropdown" role="menu" aria-label="Settings options">
                  <div className="settings-dropdown-row" role="menuitem">
                    <div>
                      <div className="settings-option-title">Theme</div>
                      <div className="settings-option-subtitle">Toggle light or dark</div>
                    </div>
                    <ThemeToggle />
                  </div>

                  <button
                    className="settings-dropdown-action"
                    type="button"
                    role="menuitem"
                    onClick={() => setDebugOpen(true)}
                  >
                    <span>Model details</span>
                    <span className="settings-action-hint">Open</span>
                  </button>

                  <button
                    className="settings-dropdown-action is-danger"
                    type="button"
                    role="menuitem"
                    onClick={() => setConfirmClearOpen(true)}
                    disabled={!sortedConversations.length && !hasUserMessages}
                  >
                    <span>Delete all memory</span>
                    <span className="settings-action-hint">Local only</span>
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </aside>

        {debugOpen ? (
          <div className="app-modal-backdrop" role="presentation" onClick={() => setDebugOpen(false)}>
            <section
              className="app-modal model-details-modal"
              role="dialog"
              aria-modal="true"
              aria-label="Model details"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="app-modal-header">
                <div>
                  <div className="app-modal-title">Model details</div>
                  <div className="app-modal-subtitle">Runtime information from the latest response</div>
                </div>
                <button className="app-modal-close" type="button" onClick={() => setDebugOpen(false)} aria-label="Close model details">
                  ×
                </button>
              </div>
              {renderDebugPanel("model-modal-debug-panel")}
            </section>
          </div>
        ) : null}

        {confirmClearOpen ? (
          <div className="app-modal-backdrop" role="presentation" onClick={() => setConfirmClearOpen(false)}>
            <section
              className="app-modal confirm-clear-modal"
              role="dialog"
              aria-modal="true"
              aria-label="Delete all local chat history"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="app-modal-header">
                <div>
                  <div className="app-modal-title">Delete all memory?</div>
                  <div className="app-modal-subtitle">This removes only the chats saved on this device.</div>
                </div>
                <button className="app-modal-close" type="button" onClick={() => setConfirmClearOpen(false)} aria-label="Cancel deletion">
                  ×
                </button>
              </div>
              <p className="confirm-clear-copy">
                This cannot be undone. Your current conversation and all saved local conversations will be cleared.
              </p>
              <div className="confirm-clear-actions">
                <button className="confirm-clear-cancel" type="button" onClick={() => setConfirmClearOpen(false)}>
                  Cancel
                </button>
                <button className="confirm-clear-delete" type="button" onClick={clearAllLocalHistory}>
                  Delete all
                </button>
              </div>
            </section>
          </div>
        ) : null}
      </>
    );
  }

  function renderDebugPanel(extraClassName = "") {
    return (
      <div className={`debug-panel ${extraClassName}`.trim()}>
        <div className="debug-row">
          <span>App mode</span>
          <strong>{appMode}</strong>
        </div>
        <div className="debug-row">
          <span>Voice mode</span>
          <strong>{VOICE_TRANSCRIPTION_MODE}</strong>
        </div>
        <div className="debug-row">
          <span>Last used model</span>
          <strong>{debug?.used_model || "-"}</strong>
        </div>
        <div className="debug-row">
          <span>Last tried model</span>
          <strong>{debug?.last_tried_model || "-"}</strong>
        </div>
        <div className="debug-row">
          <span>Mode detail</span>
          <strong>{debug?.mode_detail || "-"}</strong>
        </div>
        <div className="debug-row">
          <span>Candidate models</span>
          <strong>{debug?.candidate_models?.join(", ") || "-"}</strong>
        </div>
        {debug?.model_errors?.length ? <pre className="debug-pre">{debug.model_errors.join("\n")}</pre> : null}
      </div>
    );
  }

  function renderComposer(extraClassName: string) {
    const micLabel = voicePhase === "recording" ? "Done recording" : "Start voice input";

    const composerRef = extraClassName.includes("composer-fixed") ? composerFixedRef : undefined;

    return (
      <div className={`composer ${extraClassName}`} aria-label="Message composer" ref={composerRef}>
        <div className={`composer-bar ${busy ? "is-busy" : ""} ${isVoiceActive ? "has-voice" : ""}`}>
          {renderVoiceStatus()}

          <textarea
            id="prompt-input"
            className="prompt-input"
            placeholder={voicePhase === "recording" ? "Recording…" : "Ask anything…"}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onPromptKeyDown}
            onFocus={handlePromptFocus}
            disabled={busy || isVoiceActive}
            autoComplete="off"
            rows={1}
            ref={inputRef}
          />

          <div className="composer-actions-row" aria-label="Composer actions">
            <div className="composer-actions-left">{renderModeSelector()}</div>
            <div className="composer-actions-right">
              <button
                className={`icon-btn mic-btn ${voicePhase === "recording" ? "is-recording" : ""}`}
                type="button"
                onClick={toggleRecording}
                aria-label={micLabel}
                title={micLabel}
                disabled={busy || voicePhase === "stopping" || voicePhase === "transcribing"}
              >
                {voicePhase === "recording" ? <span className="stop-glyph" /> : <span className="voice-wave-glyph" aria-hidden="true"><span /><span /><span /></span>}
              </button>

              <button
                className="icon-btn send-btn"
                type="button"
                onClick={sendText}
                aria-label="Send"
                title="Send"
                disabled={busy || isVoiceActive || !input.trim()}
              >
                {busy ? <span className="spinner" aria-hidden="true" /> : "➤"}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`chat-root ${hasUserMessages ? "chat-mode" : "hero-mode"} ${historyOpen ? "history-open" : ""}`}
      data-mode={appMode}
      data-voice-phase={voicePhase}
      style={{ "--composer-height": `${composerHeight}px`, "--keyboard-inset": `${keyboardInset}px` } as React.CSSProperties}
    >
      {renderHistorySidebar()}

      <div className="chat-main">
      {hasUserMessages ? (
        <>
          <div className="chat-actions">
            <button
              onClick={() => setHistoryOpen((value) => !value)}
              className="ghost-btn history-chat-toggle sidebar-icon-button"
              type="button"
              aria-expanded={historyOpen}
              aria-label="Open chat history"
              title="Chat history"
            >
              <SidebarGlyph />
            </button>
          </div>

          <div className="chat-scroll-outer" ref={chatScrollRef}>
            <div className="chat-scroll-inner">
              <div className="chat">
                {messages.map((m, idx) => {
                  const isPending = busy && idx === messages.length - 1 && m.role === "user";
                  return (
                    <div
                      key={`${m.ts}-${idx}`}
                      ref={
                        idx === latestUserMessageIndex
                          ? latestUserMessageRef
                          : idx === latestAssistantResponseIndex
                            ? latestAssistantResponseRef
                            : undefined
                      }
                      className={`bubble ${m.role === "user" ? "user" : "ai"} ${isPending ? "pending" : ""}`}
                      style={{ "--bubble-index": idx } as React.CSSProperties}
                    >
                      <MessageContent role={m.role} content={m.content} ts={m.ts} />
                      <div className="meta">{m.ts}</div>
                    </div>
                  );
                })}

                {busy ? (
                  <div className="bubble ai typing" aria-label="Assistant is analyzing">
                    <div className="typing-row">
                      <span className="typing-label">Analyzing</span>
                      <span className="typing-dots" aria-hidden="true">
                        <span className="dot" />
                        <span className="dot" />
                        <span className="dot" />
                      </span>
                    </div>
                  </div>
                ) : null}

                <div className="chat-bottom-spacer" aria-hidden="true" />
              </div>
            </div>
          </div>

          {renderComposer("composer-fixed")}
        </>
      ) : (
        <>
          <div className="hero">
            <div className="hero-copy">
              <div className="hero-kicker"><span className="sparkle" aria-hidden="true">✨</span> Hi</div>
              <h1 className="hero-title"><span>Meet my AI twin</span></h1>
              <p className="hero-subtitle">
                Ask interview-style questions about projects, deep RL, strengths, growth areas — it replies like I would.
              </p>
            </div>

            {renderComposer("composer-hero")}

            <div className="hero-chips" aria-label="Quick prompts">
              <button className="chip" type="button" onClick={() => fillPrompt("What should we know about your life story in a few sentences?")}>What should we know about your life story in a few sentences?</button>
              <button className="chip" type="button" onClick={() => fillPrompt("What’s your #1 superpower?")}>What’s your #1 superpower?</button>
              <button className="chip" type="button" onClick={() => fillPrompt("What are the top 3 areas you’d like to grow in?")}>What are the top 3 areas you’d like to grow in?</button>
              <button className="chip" type="button" onClick={() => fillPrompt("Give complete mathematical detail of your M.Tech Thesis")}>Give complete mathematical detail of your M.Tech Thesis</button>
            </div>
          </div>
        </>
      )}
      </div>
    </div>
  );
}
