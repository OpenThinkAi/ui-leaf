import crypto from "node:crypto";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PLATFORM_MAP, isAlreadyInstalled, parseChecksums } from "../src/postinstall.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sha256Hex(data: Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

async function makeTmpDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), "ui-leaf-postinstall-test-"));
}

// ---------------------------------------------------------------------------
// Local test HTTP server — serves checksums.txt and a fake binary payload.
// ---------------------------------------------------------------------------
interface TestServer {
  baseUrl: string;
  fakePayload: Buffer;
  fakeDigest: string;
  close(): void;
}

async function startTestServer(
  checksumsTxt: string,
  binaryPayload: Buffer
): Promise<TestServer> {
  const server = http.createServer((req, res) => {
    const url = req.url ?? "";
    if (url.endsWith("checksums.txt")) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(checksumsTxt);
    } else if (url.includes("ui-leaf-")) {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.end(binaryPayload);
    } else {
      res.writeHead(404);
      res.end("not found");
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    fakePayload: binaryPayload,
    fakeDigest: sha256Hex(binaryPayload),
    close: () => server.close(),
  };
}

// ---------------------------------------------------------------------------
// Platform map
// ---------------------------------------------------------------------------
describe("PLATFORM_MAP", () => {
  test("darwin-arm64 → ui-leaf-darwin-arm64", () => {
    expect(PLATFORM_MAP["darwin-arm64"]?.artifact).toBe("ui-leaf-darwin-arm64");
    expect(PLATFORM_MAP["darwin-arm64"]?.binary).toBe("ui-leaf");
  });
  test("darwin-x64 → ui-leaf-darwin-x64", () => {
    expect(PLATFORM_MAP["darwin-x64"]?.artifact).toBe("ui-leaf-darwin-x64");
    expect(PLATFORM_MAP["darwin-x64"]?.binary).toBe("ui-leaf");
  });
  test("linux-x64 → ui-leaf-linux-x64", () => {
    expect(PLATFORM_MAP["linux-x64"]?.artifact).toBe("ui-leaf-linux-x64");
    expect(PLATFORM_MAP["linux-x64"]?.binary).toBe("ui-leaf");
  });
  test("linux-arm64 → ui-leaf-linux-arm64", () => {
    expect(PLATFORM_MAP["linux-arm64"]?.artifact).toBe("ui-leaf-linux-arm64");
    expect(PLATFORM_MAP["linux-arm64"]?.binary).toBe("ui-leaf");
  });
  test("win32-x64 → ui-leaf-windows-x64.exe (with .exe binary)", () => {
    expect(PLATFORM_MAP["win32-x64"]?.artifact).toBe(
      "ui-leaf-windows-x64.exe"
    );
    expect(PLATFORM_MAP["win32-x64"]?.binary).toBe("ui-leaf.exe");
  });
  test("covers exactly 5 targets", () => {
    expect(Object.keys(PLATFORM_MAP)).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// parseChecksums
// ---------------------------------------------------------------------------
describe("parseChecksums", () => {
  const csText = [
    "aabbcc0011223344556677889900aabb  ui-leaf-darwin-arm64",
    "1122334455667788990011aabbccddee  ui-leaf-linux-x64",
    "",
  ].join("\n");

  test("returns matching digest", () => {
    expect(parseChecksums(csText, "ui-leaf-darwin-arm64")).toBe(
      "aabbcc0011223344556677889900aabb"
    );
  });
  test("returns second matching artifact", () => {
    expect(parseChecksums(csText, "ui-leaf-linux-x64")).toBe(
      "1122334455667788990011aabbccddee"
    );
  });
  test("throws when artifact not found", () => {
    expect(() => parseChecksums(csText, "ui-leaf-windows-x64.exe")).toThrow(
      /no checksum entry for ui-leaf-windows-x64\.exe/
    );
  });
  test("handles checksums with extra whitespace lines", () => {
    const withBlanks = "\n  \n" + csText + "\n  \n";
    expect(parseChecksums(withBlanks, "ui-leaf-linux-x64")).toBe(
      "1122334455667788990011aabbccddee"
    );
  });
});

// ---------------------------------------------------------------------------
// isAlreadyInstalled
// ---------------------------------------------------------------------------
describe("isAlreadyInstalled", () => {
  let tmpDir: string;
  beforeAll(async () => {
    tmpDir = await makeTmpDir();
  });
  afterAll(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  test("returns false when sentinel does not exist", () => {
    const sentinel = path.join(tmpDir, "missing-sentinel");
    expect(isAlreadyInstalled("1.2.3", "ui-leaf-linux-x64", sentinel)).toBe(
      false
    );
  });
  test("returns true when sentinel matches version:artifact", async () => {
    const sentinel = path.join(tmpDir, "match-sentinel");
    await fsp.writeFile(sentinel, "1.2.3:ui-leaf-linux-x64\n", "utf8");
    expect(isAlreadyInstalled("1.2.3", "ui-leaf-linux-x64", sentinel)).toBe(
      true
    );
  });
  test("returns false when version differs", async () => {
    const sentinel = path.join(tmpDir, "version-mismatch-sentinel");
    await fsp.writeFile(sentinel, "1.2.3:ui-leaf-linux-x64\n", "utf8");
    expect(isAlreadyInstalled("1.2.4", "ui-leaf-linux-x64", sentinel)).toBe(
      false
    );
  });
  test("returns false when artifact differs", async () => {
    const sentinel = path.join(tmpDir, "artifact-mismatch-sentinel");
    await fsp.writeFile(sentinel, "1.2.3:ui-leaf-linux-x64\n", "utf8");
    expect(isAlreadyInstalled("1.2.3", "ui-leaf-darwin-arm64", sentinel)).toBe(
      false
    );
  });
});

// ---------------------------------------------------------------------------
// Full postinstall flow via subprocess (uses UI_LEAF_DOWNLOAD_BASE + tmpdir)
// ---------------------------------------------------------------------------
// We run postinstall.ts as a subprocess via `bun run` so that process.exit
// and top-level side-effects are isolated from the test runner process.
// ---------------------------------------------------------------------------
async function runPostinstall(
  env: Record<string, string>,
  pkgRoot: string
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  const scriptPath = path.resolve(
    import.meta.dir,
    "../src/postinstall.ts"
  );
  const proc = Bun.spawn(["bun", "run", scriptPath], {
    cwd: pkgRoot,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
}

async function makePackageRoot(version = "0.0.1"): Promise<string> {
  const dir = await makeTmpDir();
  await fsp.mkdir(path.join(dir, "bin"), { recursive: true });
  // Minimal package.json the postinstall reads for version
  await fsp.writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "@openthink/ui-leaf-wrapper", version }),
    "utf8"
  );
  return dir;
}

describe("postinstall — download + verify flow", () => {
  const fakePayload = Buffer.from("fake binary content for testing");
  const fakeDigest = sha256Hex(fakePayload);
  // We need to know the artifact name for the current test platform.
  const currentKey = `${process.platform}-${process.arch}`;
  const currentTarget = PLATFORM_MAP[currentKey];

  // Skip the integration tests if we're on an unsupported platform in CI.
  const itIfSupported = currentTarget ? test : test.skip;

  let srv: TestServer;
  beforeAll(async () => {
    if (!currentTarget) return;
    const checksumsTxt = `${fakeDigest}  ${currentTarget.artifact}\n`;
    srv = await startTestServer(checksumsTxt, fakePayload);
  });
  afterAll(() => {
    srv?.close();
  });

  itIfSupported("downloads binary, verifies SHA256, writes sentinel", async () => {
    const pkgRoot = await makePackageRoot("0.0.1");
    try {
      const { exitCode, stderr } = await runPostinstall(
        { UI_LEAF_DOWNLOAD_BASE: `${srv.baseUrl}/v0.0.1` },
        pkgRoot
      );
      if (exitCode !== 0) {
        throw new Error(`postinstall exited ${exitCode}: ${stderr}`);
      }
      const binaryDest = path.join(pkgRoot, "bin", currentTarget!.binary);
      const installed = await fsp.readFile(binaryDest);
      expect(installed).toEqual(fakePayload);

      const sentinel = await fsp.readFile(
        path.join(pkgRoot, "bin", ".ui-leaf-version"),
        "utf8"
      );
      expect(sentinel.trim()).toBe(`0.0.1:${currentTarget!.artifact}`);
    } finally {
      await fsp.rm(pkgRoot, { recursive: true, force: true });
    }
  });

  itIfSupported("idempotency — skips download when sentinel matches", async () => {
    const pkgRoot = await makePackageRoot("0.0.1");
    try {
      const sentinel = path.join(pkgRoot, "bin", ".ui-leaf-version");
      await fsp.writeFile(
        sentinel,
        `0.0.1:${currentTarget!.artifact}\n`,
        "utf8"
      );

      let networkHits = 0;
      const noNetSrv = await (async () => {
        const s = http.createServer((_req, res) => {
          networkHits++;
          res.writeHead(500);
          res.end();
        });
        await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
        const addr = s.address() as { port: number };
        return {
          baseUrl: `http://127.0.0.1:${addr.port}`,
          close: () => s.close(),
        };
      })();

      const { exitCode } = await runPostinstall(
        { UI_LEAF_DOWNLOAD_BASE: `${noNetSrv.baseUrl}/v0.0.1` },
        pkgRoot
      );
      noNetSrv.close();

      expect(exitCode).toBe(0);
      expect(networkHits).toBe(0);
    } finally {
      await fsp.rm(pkgRoot, { recursive: true, force: true });
    }
  });

  itIfSupported("fails with non-zero exit on SHA256 mismatch", async () => {
    const pkgRoot = await makePackageRoot("0.0.1");
    try {
      // Serve a checksums.txt with a wrong digest
      const badChecksums = `${"00".repeat(32)}  ${currentTarget!.artifact}\n`;
      const badSrv = await startTestServer(badChecksums, fakePayload);

      const { exitCode, stderr } = await runPostinstall(
        { UI_LEAF_DOWNLOAD_BASE: `${badSrv.baseUrl}/v0.0.1` },
        pkgRoot
      );
      badSrv.close();

      expect(exitCode).not.toBe(0);
      expect(stderr).toMatch(/SHA256 mismatch/);
    } finally {
      await fsp.rm(pkgRoot, { recursive: true, force: true });
    }
  });

  itIfSupported("retries on network errors and fails after 3 attempts", async () => {
    const pkgRoot = await makePackageRoot("0.0.1");
    try {
      let hits = 0;
      const failSrv = await (async () => {
        const s = http.createServer((req, res) => {
          hits++;
          // Return 500 to simulate a transient error for checksums AND binary
          res.writeHead(500);
          res.end("internal server error");
        });
        await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
        const addr = s.address() as { port: number };
        return {
          baseUrl: `http://127.0.0.1:${addr.port}`,
          close: () => s.close(),
        };
      })();

      const { exitCode, stderr } = await runPostinstall(
        {
          UI_LEAF_DOWNLOAD_BASE: `${failSrv.baseUrl}/v0.0.1`,
          // Shorten retry delays so the test doesn't take 3+ seconds
          UI_LEAF_TEST_FAST_RETRY: "1",
        },
        pkgRoot
      );
      failSrv.close();

      expect(exitCode).not.toBe(0);
      expect(stderr).toMatch(/failed to fetch checksums/);
      // 3 attempts for checksums (binary download never reached due to early failure)
      expect(hits).toBe(3);
    } finally {
      await fsp.rm(pkgRoot, { recursive: true, force: true });
    }
  });

  itIfSupported("UI_LEAF_BINARY_PATH installs from local path, skips download", async () => {
    const pkgRoot = await makePackageRoot("0.0.1");
    const localBinary = path.join(pkgRoot, "fake-local-binary");
    try {
      await fsp.writeFile(localBinary, fakePayload);

      const { exitCode, stderr } = await runPostinstall(
        { UI_LEAF_BINARY_PATH: localBinary },
        pkgRoot
      );
      if (exitCode !== 0) {
        throw new Error(`postinstall exited ${exitCode}: ${stderr}`);
      }

      const binaryDest = path.join(pkgRoot, "bin", currentTarget!.binary);
      const installed = await fsp.readFile(binaryDest);
      expect(installed).toEqual(fakePayload);

      const sentinel = await fsp.readFile(
        path.join(pkgRoot, "bin", ".ui-leaf-version"),
        "utf8"
      );
      expect(sentinel.trim()).toBe(
        `0.0.1:env-override:${currentTarget!.artifact}`
      );
    } finally {
      await fsp.rm(pkgRoot, { recursive: true, force: true });
    }
  });
});
