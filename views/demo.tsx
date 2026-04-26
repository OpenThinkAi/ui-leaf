interface DemoProps {
  data: unknown;
}

export default function Demo({ data }: DemoProps) {
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
      <h1 style={{ fontSize: "1.75rem", marginBottom: "0.5rem" }}>
        ui-leaf
      </h1>
      <p style={{ color: "#666", marginBottom: "1.5rem" }}>
        If you see this and the data below, the rendering path works.
      </p>
      <h2 style={{ fontSize: "1rem", marginBottom: "0.5rem" }}>
        Data received
      </h2>
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
