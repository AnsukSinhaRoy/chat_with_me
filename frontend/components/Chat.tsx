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
  const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000";

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

  // Helps async callbacks (like MediaRecorder.onstop) always use the latest messages.
  const messagesRef = useRef<Message[]>(messages);

  const chatEndRef = useRef<HTMLDivElement | null>(null);

  const hasUserMessages = useMemo(
    () => messages.some((m) => m.role === "user"),
    [messages]
  );

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
          app_mode: process.env.NEXT_PUBLIC_APP_MODE || "quota_saver",
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

  async function toggleRecording() {
    if (busy) return;

    if (!recording) {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      mediaRecorderRef.current = mr;
      chunksRef.current = [];

      mr.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: mr.mimeType || "audio/webm" });

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

      mr.start();
      setRecording(true);
    } else {
      mediaRecorderRef.current?.stop();
      setRecording(false);
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
              <div className="debug-line">APP_MODE: {process.env.NEXT_PUBLIC_APP_MODE || "quota_saver"}</div>
              <div className="debug-line">Last used chat model: {debug?.used_model || "-"}</div>
              <div className="debug-line">Last tried model: {debug?.last_tried_model || "-"}</div>
              {debug?.model_errors?.length ? (
                <pre className="debug-pre">{debug.model_errors.join("\n")}</pre>
              ) : null}
            </div>
          )}

          <div className="chat-scroll">
            <div className="chat">
              {messages.map((m, idx) => (
                <div key={idx} className={`bubble ${m.role === "user" ? "user" : "ai"}`}>
                  {m.content}
                  <div className="meta">{m.ts}</div>
                </div>
              ))}
              <div ref={chatEndRef} />
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
              <button className="chip" onClick={() => fillPrompt("Give me a quick overview of your strongest project.")}
              >
                Strongest project
              </button>
              <button className="chip" onClick={() => fillPrompt("Explain your RL work in 60 seconds, like an interview answer.")}
              >
                60-sec pitch
              </button>
              <button className="chip" onClick={() => fillPrompt("Ask me 5 tough interview questions for applied ML.")}
              >
                Tough questions
              </button>
              <button className="chip" onClick={() => fillPrompt("Let’s do a mock interview. Start with a question.")}
              >
                Mock interview
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
                <div className="debug-line">APP_MODE: {process.env.NEXT_PUBLIC_APP_MODE || "quota_saver"}</div>
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
