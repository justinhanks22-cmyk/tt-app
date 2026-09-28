"use client";

import { useEffect, useState } from "react";
import { formatRemaining } from "@/lib/format";

/** Display-only countdown. Actual deletion is enforced on the server, never by this timer. */
export default function Countdown({ expiresAt, onExpire }: { expiresAt: string; onExpire?: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  const remaining = new Date(expiresAt).getTime() - now;

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (remaining <= 0) onExpire?.();
  }, [remaining, onExpire]);

  if (remaining <= 0) return <span>Expired and deleted</span>;
  return (
    <span title={new Date(expiresAt).toLocaleString()}>Automatically deleted in {formatRemaining(remaining)}</span>
  );
}
