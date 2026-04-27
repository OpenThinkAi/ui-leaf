import { useState } from "react";
import type { ViewProps } from "ui-leaf/view";

interface DemoData {
  initialCount?: number;
  [key: string]: unknown;
}

export default function Demo({ data, mutate }: ViewProps<DemoData>) {
  // Counter starts from the value the CLI passed in. After mutations,
  // the CLI is the source of truth; the view tracks what it last saw.
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
        maxWidth: "48rem",
        margin: "0 auto",
        color: "#1a1a1a",
      }}
    >
      <h1 style={{ fontSize: "1.75rem", marginBottom: "0.5rem" }}>ui-leaf</h1>
      <p style={{ color: "#666", marginBottom: "1.5rem" }}>
        If the data renders below and the buttons round-trip through the CLI,
        the full bridge works.
      </p>

      <h2 style={{ fontSize: "1rem", marginBottom: "0.5rem" }}>Counter (CLI-owned state)</h2>
      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginBottom: "1.5rem" }}>
        <button
          type="button"
          onClick={() => bump(-1)}
          disabled={busy}
          style={{ padding: "0.5rem 1rem" }}
        >
          −1
        </button>
        <span style={{ minWidth: "3rem", textAlign: "center", fontWeight: 600 }}>{count}</span>
        <button
          type="button"
          onClick={() => bump(1)}
          disabled={busy}
          style={{ padding: "0.5rem 1rem" }}
        >
          +1
        </button>
        {error && (
          <span role="alert" style={{ color: "#c00", marginLeft: "1rem" }}>
            {error}
          </span>
        )}
      </div>

      <h2 style={{ fontSize: "1rem", marginBottom: "0.5rem" }}>Data received</h2>
      <pre
        style={{
          background: "#f4f4f4",
          padding: "1rem",
          borderRadius: "0.5rem",
          fontSize: "0.875rem",
          overflowX: "auto",
        }}
      >
        {JSON.stringify(data, null, 2)}
      </pre>
    </div>
  );
}
