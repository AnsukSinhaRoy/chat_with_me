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

        if (!response.ok) throw new Error(`Health check returned ${response.status}`);
        const data = await response.json().catch(() => null);
        if (!data?.ok) throw new Error("Health check did not return ok=true");

        if (!cancelled) setState("online");
      } catch {
        if (!cancelled) setState("offline");
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

  const offline = state === "offline" || state === "missing";
  const label = offline ? "backend offline" : state === "checking" ? "checking connection" : "online";

  return (
    <span
      className={`brand-status-wrap ${offline ? "has-tooltip" : ""}`.trim()}
      data-tooltip={offline ? "backend offline" : undefined}
    >
      <span
        className={`brand-status-dot status-${state}`}
        aria-label={label}
        title={offline ? "backend offline" : label}
      />
    </span>
  );
}
