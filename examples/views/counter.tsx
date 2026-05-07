import { useState } from "react";
import type { ViewProps } from "@openthink/ui-leaf/view";

interface CounterData {
  initialCount: number;
}

export default function Counter({ data, mutate }: ViewProps<CounterData>) {
  const [count, setCount] = useState(data.initialCount ?? 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function bump(by: number) {
    setBusy(true);
    setError(null);
    try {
      const result = await mutate<{ count: number }>("increment", { by });
      setCount(result.count);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        fontFamily: "system-ui, -apple-system, sans-serif",
        padding: "2rem",
        maxWidth: "24rem",
        margin: "0 auto",
        color: "#1a1a1a",
      }}
    >
      <h1 style={{ fontSize: "1.5rem", marginBottom: "1.5rem" }}>Counter</h1>
      <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
        <button
          type="button"
          onClick={() => bump(-1)}
          disabled={busy}
          style={{ padding: "0.5rem 1rem", fontSize: "1rem" }}
        >
          −1
        </button>
        <span
          style={{
            minWidth: "4rem",
            textAlign: "center",
            fontSize: "2rem",
            fontWeight: 700,
          }}
        >
          {count}
        </span>
        <button
          type="button"
          onClick={() => bump(1)}
          disabled={busy}
          style={{ padding: "0.5rem 1rem", fontSize: "1rem" }}
        >
          +1
        </button>
      </div>
      {error && (
        <p role="alert" style={{ color: "#c00", marginTop: "1rem" }}>
          {error}
        </p>
      )}
    </div>
  );
}
