"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

type Role = "user" | "assistant";
type AppMode = "quota_saver" | "quality";
type VoicePhase = "idle" | "requesting" | "recording" | "stopping" | "transcribing";

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
  final: string;
  interim: string;
};

const WAVE_BAR_COUNT = 32;
const MAX_TEXTAREA_PX = 160;
const MAX_RECORDING_MS = 22_000;
const SILENCE_STOP_MS = 1_150;

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

function pickVoice(): SpeechSynthesisVoice | null {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return null;

  const voices = window.speechSynthesis.getVoices() || [];
  const maleHints = [
    "male",
    "david",
    "mark",
    "alex",
    "daniel",
    "george",
    "fred",
    "roger",
    "thomas",
    "john",
    "microsoft david",
    "google uk english male",
    "google us english",
  ];
  const englishVoices = voices.filter((v) => /^en/i.test(v.lang));
  const pool = englishVoices.length ? englishVoices : voices;
  if (!pool.length) return null;

  return (
    pool.find((v) => {
      const name = (v.name || "").toLowerCase();
      const uri = (v.voiceURI || "").toLowerCase();
      return maleHints.some((hint) => name.includes(hint) || uri.includes(hint));
    }) || pool[0]
  );
}

function speak(text: string) {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;

  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  const voice = pickVoice();
  if (voice) utterance.voice = voice;
  utterance.rate = 1.0;
  utterance.pitch = 0.9;
  window.speechSynthesis.speak(utterance);
}

export default function Chat() {
  const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "";
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
  const transcriptRef = useRef<SpeechBuffer>({ final: "", interim: "" });

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
    window.speechSynthesis?.getVoices?.();
  }, []);

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
      const res = await fetch(`${API_BASE}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: nextMessages, app_mode: appMode }),
      });

      if (!res.ok) {
        const txt = await res.text();
        let message = txt;
        try {
          const parsed = JSON.parse(txt);
          message = parsed?.detail || parsed?.error || txt;
        } catch {
          // Keep raw response text.
        }
        throw new Error(String(message));
      }

      const data: ChatResponse = await res.json();
      const botMsg = makeMsg("assistant", data.reply);
      setMessages((prev) => [...prev, botMsg]);
      setDebug(data);
      speak(data.reply);
    } catch (error: any) {
      const errMsg = String(error?.message || "Request failed").slice(0, 260);
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

  async function sendVoiceTranscript(text: string) {
    const clean = text.trim();
    setVoicePhase("idle");
    setTranscriptPreview("");

    if (!clean) {
      setVoiceError("I could not detect clear speech. Try again closer to the mic.");
      return;
    }

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
    transcriptRef.current = { final: "", interim: "" };
  }

  function stopWaveform() {
    if (waveformRafRef.current != null) {
      cancelAnimationFrame(waveformRafRef.current);
      waveformRafRef.current = null;
    }
    lastWavePaintRef.current = 0;
    setWaveLevels(initialWaveLevels());
  }

  function cleanupRecordingResources() {
    stopWaveform();

    if (maxRecTimerRef.current != null) {
      window.clearTimeout(maxRecTimerRef.current);
      maxRecTimerRef.current = null;
    }

    try {
      recognitionRef.current?.stop?.();
    } catch {
      // Already stopped.
    }
    recognitionRef.current = null;

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

  function startSpeechRecognitionIfAvailable() {
    const SpeechRecognitionCtor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognitionCtor) return;

    try {
      const rec = new SpeechRecognitionCtor();
      recognitionRef.current = rec;
      rec.lang = "en-IN";
      rec.interimResults = true;
      rec.continuous = true;

      rec.onresult = (event: any) => {
        let interim = "";
        let final = "";

        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const result = event.results[i];
          const text = String(result[0]?.transcript || "").trim();
          if (!text) continue;
          if (result.isFinal) final += ` ${text}`;
          else interim += ` ${text}`;
        }

        transcriptRef.current.final = `${transcriptRef.current.final} ${final}`.trim();
        transcriptRef.current.interim = interim.trim();
        setTranscriptPreview(`${transcriptRef.current.final} ${transcriptRef.current.interim}`.trim());
      };

      rec.onspeechend = () => {
        const heardText = `${transcriptRef.current.final} ${transcriptRef.current.interim}`.trim();
        if (heardText) stopRecording();
      };

      rec.onerror = () => {
        // Backend transcription still runs from the recorded audio.
      };

      rec.start();
    } catch {
      recognitionRef.current = null;
    }
  }

  function startWaveform(analyser: AnalyserNode) {
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
      } else if (hadSpeechRef.current) {
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
      stopRecording();
      return;
    }

    if (voicePhase === "stopping" || voicePhase === "transcribing") return;

    setVoiceError("");
    setTranscriptPreview("");
    resetVoiceRefs();

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
        startWaveform(analyser);
      }

      const mimeCandidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/ogg"];
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
        const browserTranscript = `${transcriptRef.current.final} ${transcriptRef.current.interim}`.trim();
        cleanupRecordingResources();

        setVoicePhase("transcribing");

        if (browserTranscript) {
          setTranscriptPreview(browserTranscript);
          await sendVoiceTranscript(browserTranscript);
          return;
        }

        if (blob.size < 900) {
          setVoicePhase("idle");
          setVoiceError("That recording was too short or silent. Try again.");
          return;
        }

        try {
          const form = new FormData();
          form.append("file", blob, "voice.webm");
          const response = await fetch(`${API_BASE}/api/transcribe`, { method: "POST", body: form });
          if (!response.ok) throw new Error(await response.text());

          const data = (await response.json()) as { text?: string };
          const text = String(data.text || "").trim();
          setTranscriptPreview(text);
          await sendVoiceTranscript(text);
        } catch {
          setVoicePhase("idle");
          setVoiceError("Audio upload/transcription failed. The typed input still works.");
        }
      };

      startSpeechRecognitionIfAvailable();
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
        ? transcriptPreview || "Speak naturally. I’ll stop after a short pause."
        : voicePhase === "transcribing"
          ? transcriptPreview || "Converting speech to text…"
          : voiceError || transcriptPreview;

    return (
      <div className={`voice-panel ${voiceError ? "has-error" : ""}`} aria-live="polite">
        <div className="voice-panel-top">
          <div>
            <div className="voice-title">{title}</div>
            {subtitle ? <div className="voice-subtitle">{subtitle}</div> : null}
          </div>
          {voicePhase === "recording" ? (
            <button className="voice-stop-btn" type="button" onClick={stopRecording}>
              Stop
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

  function renderComposer(extraClassName: string) {
    const micLabel = voicePhase === "recording" ? "Stop recording" : "Start voice input";

    return (
      <div className={`composer ${extraClassName}`} aria-label="Message composer">
        <div className={`composer-bar ${busy ? "is-busy" : ""} ${isVoiceActive ? "has-voice" : ""}`}>
          {renderVoiceStatus()}

          <textarea
            id="prompt-input"
            className="prompt-input"
            placeholder={voicePhase === "recording" ? "Listening…" : "Ask anything…"}
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

        <div className="composer-hint">Enter to send • Shift+Enter for newline • Mic supports auto-stop</div>
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
              Debug
            </button>
          </div>

          {debugOpen ? (
            <div className="debug-panel">
              <div className="debug-line">APP_MODE: {appMode}</div>
              <div className="debug-line">Last used chat model: {debug?.used_model || "-"}</div>
              <div className="debug-line">Last tried model: {debug?.last_tried_model || "-"}</div>
              {debug?.model_errors?.length ? <pre className="debug-pre">{debug.model_errors.join("\n")}</pre> : null}
            </div>
          ) : null}

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
              Debug
            </button>
            {debugOpen ? (
              <div className="debug-panel landing-debug-panel">
                <div className="debug-line">APP_MODE: {appMode}</div>
                <div className="debug-line">Last used chat model: {debug?.used_model || "-"}</div>
                <div className="debug-line">Last tried model: {debug?.last_tried_model || "-"}</div>
                {debug?.model_errors?.length ? <pre className="debug-pre">{debug.model_errors.join("\n")}</pre> : null}
              </div>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
