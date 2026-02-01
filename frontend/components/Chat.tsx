"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

type Role = "user" | "assistant";

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

function hhmm() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function pickVoice(): SpeechSynthesisVoice | null {
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
  const en = voices.filter((v) => /^en/i.test(v.lang));
  const pool = en.length ? en : voices;
  if (!pool.length) return null;

  const found = pool.find((v) => {
    const name = (v.name || "").toLowerCase();
    const uri = (v.voiceURI || "").toLowerCase();
    return maleHints.some((h) => name.includes(h) || uri.includes(h));
  });
  return found || pool[0];
}

function speak(text: string) {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();

  const voice = pickVoice();
  const u = new SpeechSynthesisUtterance(text);
  if (voice) u.voice = voice;
  u.rate = 1.0;
  u.pitch = 0.9;
  window.speechSynthesis.speak(u);
}

export default function Chat() {
  /**
   * Vercel-friendly default:
   * - If NEXT_PUBLIC_API_BASE_URL is NOT set, we use same-origin requests ("/api/..."),
   *   which works great with Vercel rewrites/proxies.
   * - For local dev with a separate backend, set NEXT_PUBLIC_API_BASE_URL=http://localhost:8000
   */
  const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "";

  // --- app mode (quota_saver vs quality) ---
  type AppMode = "quota_saver" | "quality";
  const DEFAULT_MODE: AppMode =
    ((process.env.NEXT_PUBLIC_APP_MODE as AppMode) || "quota_saver").toLowerCase() === "quality"
      ? "quality"
      : "quota_saver";

  const [appMode, setAppMode] = useState<AppMode>(DEFAULT_MODE);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const modeMenuRef = useRef<HTMLDivElement | null>(null);

  const [messages, setMessages] = useState<Message[]>([
    {
      role: "assistant",
      content:
        "Hey — I’m Ansuk. Ask me anything interview-style: projects, RL, strengths, growth areas, whatever.",
      ts: hhmm(),
    },
  ]);

  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  const [debugOpen, setDebugOpen] = useState(false);
  const [debug, setDebug] = useState<ChatResponse | null>(null);

  // --- microphone recording ---
  const [recording, setRecording] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);

  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const vadRafRef = useRef<number | null>(null);
  const maxRecTimerRef = useRef<number | null>(null);
  const silenceSinceRef = useRef<number | null>(null);
  const hadSpeechRef = useRef<boolean>(false);

  // Web Speech API (Chrome) — used to auto-stop + produce a clearer transcript.
  const recognitionRef = useRef<any>(null);
  const transcriptRef = useRef<{ final: string; interim: string }>({ final: "", interim: "" });

  // Helps async callbacks (like MediaRecorder.onstop) always use the latest messages.
  const messagesRef = useRef<Message[]>(messages);

  const chatEndRef = useRef<HTMLDivElement | null>(null);

  const hasUserMessages = useMemo(
    () => messages.some((m) => m.role === "user"),
    [messages]
  );

  // Load persisted mode (so the dropdown selection sticks)
  useEffect(() => {
    try {
      const saved = (window.localStorage.getItem("app_mode") || "").toLowerCase();
      if (saved === "quality" || saved === "quota_saver") setAppMode(saved);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem("app_mode", appMode);
    } catch {
      // ignore
    }
  }, [appMode]);

  // Close the mode menu on outside click
  useEffect(() => {
    if (!modeMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      const el = modeMenuRef.current;
      if (!el) return;
      if (el.contains(e.target as Node)) return;
      setModeMenuOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [modeMenuOpen]);

  useEffect(() => {
    // ensure voices populate
    window.speechSynthesis?.getVoices?.();
  }, []);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    if (!hasUserMessages) return;
    chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, hasUserMessages]);

  async function callChat(nextMessages: Message[]) {
    setBusy(true);
    setDebug(null);
    try {
      const res = await fetch(`${API_BASE}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: nextMessages,
          app_mode: appMode,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data: ChatResponse = await res.json();

      const botMsg: Message = { role: "assistant", content: data.reply, ts: hhmm() };
      setMessages((prev) => [...prev, botMsg]);
      setDebug(data);

      // Speak after a user-initiated action (send/stop recording) to avoid autoplay blocks
      speak(data.reply);
    } catch (e: any) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "I hit a temporary limit. Try again in a moment.", ts: hhmm() },
      ]);
    } finally {
      setBusy(false);
    }
  }

  async function sendText() {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");

    const next = [...messagesRef.current, { role: "user", content: text, ts: hhmm() }];
    setMessages(next);
    await callChat(next);
  }

  function newChat() {
    setMessages([
      {
        role: "assistant",
        content: "Fresh slate. Hit me with your best interview question.",
        ts: hhmm(),
      },
    ]);
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
    // focus the input for faster iteration
    const el = document.getElementById("prompt-input") as HTMLInputElement | null;
    el?.focus();
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

  function cleanupRecording() {
    if (vadRafRef.current) {
      cancelAnimationFrame(vadRafRef.current);
      vadRafRef.current = null;
    }
    if (maxRecTimerRef.current) {
      window.clearTimeout(maxRecTimerRef.current);
      maxRecTimerRef.current = null;
    }
    silenceSinceRef.current = null;
    hadSpeechRef.current = false;

    try {
      recognitionRef.current?.stop?.();
    } catch {
      // ignore
    }
    recognitionRef.current = null;
    transcriptRef.current = { final: "", interim: "" };

    try {
      audioCtxRef.current?.close?.();
    } catch {
      // ignore
    }
    audioCtxRef.current = null;

    try {
      streamRef.current?.getTracks?.().forEach((t) => t.stop());
    } catch {
      // ignore
    }
    streamRef.current = null;
  }

  function stopRecording() {
    if (!recording) return;
    try {
      recognitionRef.current?.stop?.();
    } catch {
      // ignore
    }
    try {
      const mr = mediaRecorderRef.current;
      if (mr && mr.state === "recording") mr.stop();
    } catch {
      // ignore
    }
    setRecording(false);
  }

  function startSpeechRecognitionIfAvailable() {
    const SR: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return;

    try {
      const rec = new SR();
      recognitionRef.current = rec;

      // en-IN feels nicer for Indian English users; switch to en-US if you prefer.
      rec.lang = "en-IN";
      rec.interimResults = true;
      rec.continuous = true;

      transcriptRef.current = { final: "", interim: "" };

      rec.onresult = (event: any) => {
        let interim = "";
        let final = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const res = event.results[i];
          const txt = (res[0]?.transcript || "").toString();
          if (res.isFinal) final += txt;
          else interim += txt;
        }
        transcriptRef.current.final = (transcriptRef.current.final + " " + final).trim();
        transcriptRef.current.interim = interim.trim();
      };

      // Many Chrome builds fire onspeechend on pauses — we use it to auto-stop.
      rec.onspeechend = () => {
        // Only stop after we've heard *something*
        if ((transcriptRef.current.final || transcriptRef.current.interim).trim()) {
          stopRecording();
        }
      };

      rec.onerror = () => {
        // If speech recognition fails, we still have audio upload fallback.
      };

      rec.start();
    } catch {
      recognitionRef.current = null;
    }
  }

  function startSilenceAutoStop(analyser: AnalyserNode) {
    const data = new Uint8Array(analyser.fftSize);
    let noiseFloor = 0.01; // dynamic baseline

    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length);

      // Adapt noise floor more when we haven't detected speech yet.
      const alpha = hadSpeechRef.current ? 0.99 : 0.95;
      noiseFloor = alpha * noiseFloor + (1 - alpha) * rms;

      const threshold = Math.max(noiseFloor * 3.5, 0.012);
      const now = Date.now();

      if (rms > threshold) {
        hadSpeechRef.current = true;
        silenceSinceRef.current = null;
      } else if (hadSpeechRef.current) {
        if (silenceSinceRef.current == null) silenceSinceRef.current = now;
        if (now - (silenceSinceRef.current || now) > 900) {
          stopRecording();
          return;
        }
      }

      vadRafRef.current = requestAnimationFrame(tick);
    };

    vadRafRef.current = requestAnimationFrame(tick);
  }

  async function toggleRecording() {
    if (busy) return;

    if (!recording) {
      // Reset transcript buffers for this take
      transcriptRef.current = { final: "", interim: "" };

      // Capture with better defaults (clearer audio in most setups)
      const rawStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        } as any,
      });
      streamRef.current = rawStream;

      // Optional light processing (compression + gain) BEFORE recording.
      const AC: any = (window as any).AudioContext || (window as any).webkitAudioContext;
      const audioCtx: AudioContext | null = AC ? new AC() : null;
      audioCtxRef.current = audioCtx;

      let recordStream: MediaStream = rawStream;
      if (audioCtx) {
        const source = audioCtx.createMediaStreamSource(rawStream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 2048;

        const compressor = audioCtx.createDynamicsCompressor();
        compressor.threshold.setValueAtTime(-45, audioCtx.currentTime);
        compressor.knee.setValueAtTime(30, audioCtx.currentTime);
        compressor.ratio.setValueAtTime(12, audioCtx.currentTime);
        compressor.attack.setValueAtTime(0.003, audioCtx.currentTime);
        compressor.release.setValueAtTime(0.25, audioCtx.currentTime);

        const gain = audioCtx.createGain();
        gain.gain.setValueAtTime(1.18, audioCtx.currentTime);

        const dest = audioCtx.createMediaStreamDestination();

        source.connect(compressor);
        compressor.connect(gain);
        gain.connect(dest);

        // analyser is for silence detection (auto-stop)
        source.connect(analyser);
        startSilenceAutoStop(analyser);

        recordStream = dest.stream;
      }

      // Pick a good mime type when possible
      const mimeCandidates = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/ogg;codecs=opus",
        "audio/ogg",
      ];
      const mimeType = mimeCandidates.find((t) => (window as any).MediaRecorder?.isTypeSupported?.(t));
      const mr = mimeType
        ? new MediaRecorder(recordStream, { mimeType, audioBitsPerSecond: 128000 })
        : new MediaRecorder(recordStream, { audioBitsPerSecond: 128000 });

      mediaRecorderRef.current = mr;
      chunksRef.current = [];

      mr.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      mr.onstop = async () => {
        // stop devices + timers + audio context
        const blob = new Blob(chunksRef.current, { type: mr.mimeType || "audio/webm" });
        const srText = transcriptRef.current.final.trim();
        const srInterim = transcriptRef.current.interim.trim();
        cleanupRecording();

        // Prefer Web Speech API transcript if available (usually clearer + already text)
        const preferredText = (srText || srInterim).trim();
        if (preferredText) {
          const next = [...messagesRef.current, { role: "user", content: preferredText, ts: hhmm() }];
          setMessages(next);
          await callChat(next);
          return;
        }

        // upload to backend for transcription
        const form = new FormData();
        form.append("file", blob, "audio.webm");

        setBusy(true);
        try {
          const tr = await fetch(`${API_BASE}/api/transcribe`, { method: "POST", body: form });
          if (!tr.ok) throw new Error(await tr.text());
          const data = (await tr.json()) as { text: string };

          const userText = (data.text || "").trim() || "(Audio unclear)";
          const next = [...messagesRef.current, { role: "user", content: userText, ts: hhmm() }];
          setMessages(next);
          await callChat(next);
        } catch {
          setMessages((prev) => [
            ...prev,
            { role: "assistant", content: "Audio upload/transcribe failed — try again.", ts: hhmm() },
          ]);
        } finally {
          setBusy(false);
        }
      };

      // Start browser speech recognition (if available) for auto-stop + cleaner text.
      startSpeechRecognitionIfAvailable();

      // Safety net: stop after 18s no matter what
      maxRecTimerRef.current = window.setTimeout(() => {
        stopRecording();
      }, 18000);

      mr.start();
      setRecording(true);
    } else {
      stopRecording();
    }
  }

  const micLabel = recording ? "Stop recording" : "Start voice";
  const sendLabel = "Send";

  return (
    <div className={`chat-root ${hasUserMessages ? "chat-mode" : "hero-mode"}`}>
      {hasUserMessages ? (
        <>
          <div className="chat-actions">
            <button onClick={newChat} className="ghost-btn">
              New chat
            </button>
            <button onClick={exportJSON} className="ghost-btn">
              Export
            </button>
            <button
              onClick={() => setDebugOpen((v) => !v)}
              className="ghost-btn"
              style={{ marginLeft: "auto" }}
            >
              Debug
            </button>
          </div>

          {debugOpen && (
            <div className="debug-panel">
              <div className="debug-line">APP_MODE: {appMode}</div>
              <div className="debug-line">Last used chat model: {debug?.used_model || "-"}</div>
              <div className="debug-line">Last tried model: {debug?.last_tried_model || "-"}</div>
              {debug?.model_errors?.length ? (
                <pre className="debug-pre">{debug.model_errors.join("\n")}</pre>
              ) : null}
            </div>
          )}

          {/*
            Full-width scroll area so the scrollbar sits on the extreme right edge of the screen.
            Inner wrapper keeps chat content centered.
          */}
          <div className="chat-scroll-outer">
            <div className="chat-scroll-inner">
              <div className="chat">
                {messages.map((m, idx) => (
                  <div key={idx} className={`bubble ${m.role === "user" ? "user" : "ai"}`}>
                    {m.content}
                    <div className="meta">{m.ts}</div>
                  </div>
                ))}
                {/* Spacer ensures the last message never sits behind the fixed composer */}
                <div className="chat-bottom-spacer" aria-hidden="true" />
                <div ref={chatEndRef} />
              </div>
            </div>
          </div>

          <div className="composer composer-fixed" aria-label="Message composer">
            <div className={`composer-bar ${busy ? "is-busy" : ""}`}>
              <input
                id="prompt-input"
                className="prompt-input"
                type="text"
                placeholder="Ask anything…"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") sendText();
                }}
                disabled={busy}
                autoComplete="off"
              />

              {/* Gemini-like mode dropdown */}
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
                {modeMenuOpen && (
                  <div className="mode-menu" role="menu" aria-label="Mode selection">
                    <button className="mode-item" role="menuitem" onClick={() => setMode("quota_saver")}
                      aria-checked={appMode === "quota_saver"}
                    >
                      <div className="mode-item-text">
                        <div className="mode-item-title">Quota saver</div>
                        <div className="mode-item-sub">Answers quickly</div>
                      </div>
                      {appMode === "quota_saver" ? <div className="mode-check">✓</div> : null}
                    </button>
                    <button className="mode-item" role="menuitem" onClick={() => setMode("quality")}
                      aria-checked={appMode === "quality"}
                    >
                      <div className="mode-item-text">
                        <div className="mode-item-title">Quality</div>
                        <div className="mode-item-sub">Best answers</div>
                      </div>
                      {appMode === "quality" ? <div className="mode-check">✓</div> : null}
                    </button>
                  </div>
                )}
              </div>

              <button
                className={`icon-btn mic-btn ${recording ? "is-recording" : ""}`}
                onClick={toggleRecording}
                aria-label={micLabel}
                title={micLabel}
                disabled={busy}
              >
                {recording ? "■" : "🎤"}
              </button>
              <button
                className="icon-btn send-btn"
                onClick={sendText}
                aria-label={sendLabel}
                title={sendLabel}
                disabled={busy}
              >
                ➤
              </button>
            </div>
            <div className="composer-hint">Enter to send • Mic for voice</div>
          </div>
        </>
      ) : (
        <>
          <div className="hero">
            <div className="hero-copy">
              <div className="hero-kicker">✨ Hi</div>
              <h1 className="hero-title">Where should we start?</h1>
              <p className="hero-subtitle">
                Ask interview-style questions about projects, deep RL, strengths, growth areas — or just talk.
              </p>
            </div>

            <div className="composer composer-hero" aria-label="Message composer">
              <div className={`composer-bar ${busy ? "is-busy" : ""}`}>
                <input
                  id="prompt-input"
                  className="prompt-input"
                  type="text"
                  placeholder="Ask anything…"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") sendText();
                  }}
                  disabled={busy}
                  autoComplete="off"
                />

                {/* Mode dropdown on landing too */}
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
                  {modeMenuOpen && (
                    <div className="mode-menu" role="menu" aria-label="Mode selection">
                      <button className="mode-item" role="menuitem" onClick={() => setMode("quota_saver")}
                        aria-checked={appMode === "quota_saver"}
                      >
                        <div className="mode-item-text">
                          <div className="mode-item-title">Quota saver</div>
                          <div className="mode-item-sub">Answers quickly</div>
                        </div>
                        {appMode === "quota_saver" ? <div className="mode-check">✓</div> : null}
                      </button>
                      <button className="mode-item" role="menuitem" onClick={() => setMode("quality")}
                        aria-checked={appMode === "quality"}
                      >
                        <div className="mode-item-text">
                          <div className="mode-item-title">Quality</div>
                          <div className="mode-item-sub">Best answers</div>
                        </div>
                        {appMode === "quality" ? <div className="mode-check">✓</div> : null}
                      </button>
                    </div>
                  )}
                </div>

                <button
                  className={`icon-btn mic-btn ${recording ? "is-recording" : ""}`}
                  onClick={toggleRecording}
                  aria-label={micLabel}
                  title={micLabel}
                  disabled={busy}
                >
                  {recording ? "■" : "🎤"}
                </button>
                <button
                  className="icon-btn send-btn"
                  onClick={sendText}
                  aria-label={sendLabel}
                  title={sendLabel}
                  disabled={busy}
                >
                  ➤
                </button>
              </div>
            </div>

            <div className="hero-chips" aria-label="Quick prompts">
              <button className="chip" onClick={() => fillPrompt("What should we know about your life story in a few sentences?")}
              >
                What should we know about your life story in a few sentences?
              </button>
              <button className="chip" onClick={() => fillPrompt("What’s your #1 superpower? ")}
              >
                What’s your #1 superpower?
              </button>
              <button className="chip" onClick={() => fillPrompt("What are the top 3 areas you’d like to grow in?")}
              >
                What are the top 3 areas you’d like to grow in?
              </button>
              <button className="chip" onClick={() => fillPrompt("What misconception do your coworkers have about you?")}
              >
                What misconception do your coworkers have about you?
              </button>
            </div>
          </div>

          {/* Keep debug reachable even on the landing screen */}
          <div className="landing-footer">
            <button onClick={() => setDebugOpen((v) => !v)} className="ghost-btn">
              Debug
            </button>
            {debugOpen && (
              <div className="debug-panel" style={{ marginTop: 10 }}>
                <div className="debug-line">APP_MODE: {appMode}</div>
                <div className="debug-line">Last used chat model: {debug?.used_model || "-"}</div>
                <div className="debug-line">Last tried model: {debug?.last_tried_model || "-"}</div>
                {debug?.model_errors?.length ? (
                  <pre className="debug-pre">{debug.model_errors.join("\n")}</pre>
                ) : null}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
