"use client";

import { useEffect, useState } from "react";

type BackendState = "checking" | "online" | "offline" | "missing";

const API_BASE = normalizeApiBase(process.env.NEXT_PUBLIC_API_BASE_URL || "");

function normalizeApiBase(value: string) {
  return value.trim().replace(/\/+$/, "").replace(/\/api$/i, "");
}

function healthUrl() {
  return `${API_BASE}/healthz`;
}

export default function BackendStatus() {
  const [state, setState] = useState<BackendState>(API_BASE ? "checking" : "missing");
  const [detail, setDetail] = useState(API_BASE ? "Checking backend…" : "NEXT_PUBLIC_API_BASE_URL is not set");

  useEffect(() => {
    if (!API_BASE) return;

    let cancelled = false;
    let timer: number | undefined;

    const check = async () => {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 6500);

      try {
        const response = await fetch(healthUrl(), {
          method: "GET",
          cache: "no-store",
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`Health check returned ${response.status}`);
        }

        const data = await response.json().catch(() => null);
        if (!data?.ok) throw new Error("Health check did not return ok=true");

        if (!cancelled) {
          setState("online");
          setDetail(`Backend online: ${API_BASE}`);
        }
      } catch (error: unknown) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : "Backend health check failed";
          setState("offline");
          setDetail(`${message}. Check backend URL and CORS.`);
        }
      } finally {
        window.clearTimeout(timeout);
      }
    };

    check();
    timer = window.setInterval(check, 30_000);

    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
    };
  }, []);

  const label =
    state === "online"
      ? "Backend online"
      : state === "checking"
        ? "Checking backend"
        : state === "missing"
          ? "Backend not configured"
          : "Backend offline";

  return (
    <div className={`status-pill status-${state}`} title={detail} aria-live="polite">
      <span className="status-dot" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}
