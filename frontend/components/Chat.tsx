"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

type Role = "user" | "assistant";
type AppMode = "quota_saver" | "quality";
type VoicePhase = "idle" | "requesting" | "recording" | "stopping" | "transcribing";
type VoiceTranscriptionMode = "browser" | "backend";

type Message = {
  role: Role;
  content: string;
  ts: string;
};

type ChatResponse = {
  reply: string;
  used_model?: string | null;
  last_tried_model?: string | null;
  model_errors?: string[];
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
      "Backend URL is not configured. Set NEXT_PUBLIC_API_BASE_URL in the frontend Vercel project to your backend domain, then redeploy the frontend."
    );
  }

  return `${CONFIGURED_API_BASE}${path.startsWith("/") ? path : `/${path}`}`;
}

function configuredApiLabel() {
  return CONFIGURED_API_BASE || "Not configured";
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
    return "Backend is deployed, but GEMINI_API_KEYS is missing in the backend environment variables. Please add it to your Vercel dashboard.";
  }

  if (response.status === 413) {
    return "The audio file was too large for the backend. Record a shorter clip and try again.";
  }

  const prefix = area === "chat" ? "Chat request failed" : area === "transcription" ? "Transcription failed" : "Backend health check failed";
  return `${prefix} (${response.status}). ${detail || response.statusText || "No useful error message returned."}`;
}

function friendlyRequestError(error: unknown, area: "chat" | "transcription") {
  const message = error instanceof Error ? error.message : String(error || "Request failed");

  if (/Backend URL is not configured/i.test(message)) return message;
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

export default function Chat() {
  const DEFAULT_MODE = normalizeAppMode(process.env.NEXT_PUBLIC_APP_MODE);

  const [appMode, setAppMode] = useState<AppMode>(DEFAULT_MODE);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const modeMenuRef = useRef<HTMLDivElement | null>(null);

  const [messages, setMessages] = useState<Message[]>([
    makeMsg(
      "assistant",
      "Hey — I’m Ansuk. Ask me anything interview-style: projects, RL, strengths, growth areas, whatever."
    ),
  ]);
  const messagesRef = useRef<Message[]>(messages);

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

  const chatEndRef = useRef<HTMLDivElement | null>(null);

  const hasUserMessages = useMemo(() => messages.some((m) => m.role === "user"), [messages]);
  const isVoiceActive = voicePhase !== "idle";

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
    autosizePrompt();
  }, [input]);

  useEffect(() => {
    if (hasUserMessages) chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, busy, hasUserMessages]);

  useEffect(() => {
    return () => cleanupRecordingResources();
  }, []);

  function focusPrompt() {
    inputRef.current?.focus();
  }

  function autosizePrompt() {
    const el = inputRef.current;
    if (!el) return;

    el.style.height = "auto";
    const next = Math.min(el.scrollHeight, MAX_TEXTAREA_PX);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > MAX_TEXTAREA_PX ? "auto" : "hidden";
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
    const next = [...messagesRef.current, makeMsg("user", clean)];
    setMessages(next);
    await callChat(next);
  }

  function newChat() {
    cleanupRecordingResources();
    setVoicePhase("idle");
    setTranscriptPreview("");
    setVoiceError("");
    setMessages([makeMsg("assistant", "Fresh slate. Hit me with your best interview question.")]);
    setDebug(null);
    setDebugOpen(false);
  }

  function exportJSON() {
    const blob = new Blob([JSON.stringify(messages, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "chat.json";
    a.click();
    URL.revokeObjectURL(url);
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
    return m === "quality" ? "Best answers" : "Answers quickly";
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
                onClick={() => setMode(mode)}
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

  function renderDebugPanel(extraClassName = "") {
    return (
      <div className={`debug-panel ${extraClassName}`.trim()}>
        <div className="debug-row">
          <span>Backend URL</span>
          <strong>{configuredApiLabel()}</strong>
        </div>
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
        {debug?.model_errors?.length ? <pre className="debug-pre">{debug.model_errors.join("\n")}</pre> : null}
      </div>
    );
  }

  function renderComposer(extraClassName: string) {
    const micLabel = voicePhase === "recording" ? "Done recording" : "Start voice input";

    return (
      <div className={`composer ${extraClassName}`} aria-label="Message composer">
        <div className={`composer-bar ${busy ? "is-busy" : ""} ${isVoiceActive ? "has-voice" : ""}`}>
          {renderVoiceStatus()}

          <textarea
            id="prompt-input"
            className="prompt-input"
            placeholder={voicePhase === "recording" ? "Recording…" : "Ask anything…"}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onPromptKeyDown}
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
                {voicePhase === "recording" ? <span className="stop-glyph" /> : <span className="mic-glyph">🎤</span>}
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

        <div className="composer-hint">
          Enter to send • Shift+Enter for newline • Mic records until Done, then transcribes and sends
        </div>
      </div>
    );
  }

  return (
    <div className={`chat-root ${hasUserMessages ? "chat-mode" : "hero-mode"}`}>
      {hasUserMessages ? (
        <>
          <div className="chat-actions">
            <button onClick={newChat} className="ghost-btn" type="button">
              New chat
            </button>
            <button onClick={exportJSON} className="ghost-btn" type="button">
              Export
            </button>
            <button onClick={() => setDebugOpen((v) => !v)} className="ghost-btn debug-toggle" type="button">
              Status
            </button>
          </div>

          {debugOpen ? renderDebugPanel() : null}

          <div className="chat-scroll-outer">
            <div className="chat-scroll-inner">
              <div className="chat">
                {messages.map((m, idx) => {
                  const isPending = busy && idx === messages.length - 1 && m.role === "user";
                  return (
                    <div key={`${m.ts}-${idx}`} className={`bubble ${m.role === "user" ? "user" : "ai"} ${isPending ? "pending" : ""}`}>
                      <div className="bubble-text">{m.content}</div>
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
                <div ref={chatEndRef} />
              </div>
            </div>
          </div>

          {renderComposer("composer-fixed")}
        </>
      ) : (
        <>
          <div className="hero">
            <div className="hero-copy">
              <div className="hero-kicker">✨ Hi</div>
              <h1 className="hero-title">Meet my AI twin</h1>
              <p className="hero-subtitle">
                Ask interview-style questions about projects, deep RL, strengths, growth areas — it replies like I would.
              </p>
            </div>

            {renderComposer("composer-hero")}

            <div className="hero-chips" aria-label="Quick prompts">
              <button className="chip" type="button" onClick={() => fillPrompt("What should we know about your life story in a few sentences?")}>What should we know about your life story in a few sentences?</button>
              <button className="chip" type="button" onClick={() => fillPrompt("What’s your #1 superpower?")}>What’s your #1 superpower?</button>
              <button className="chip" type="button" onClick={() => fillPrompt("What are the top 3 areas you’d like to grow in?")}>What are the top 3 areas you’d like to grow in?</button>
              <button className="chip" type="button" onClick={() => fillPrompt("What misconception do your coworkers have about you?")}>What misconception do your coworkers have about you?</button>
            </div>
          </div>

          <div className="landing-footer">
            <button onClick={() => setDebugOpen((v) => !v)} className="ghost-btn" type="button">
              Status
            </button>
            {debugOpen ? renderDebugPanel("landing-debug-panel") : null}
          </div>
        </>
      )}
    </div>
  );
}
