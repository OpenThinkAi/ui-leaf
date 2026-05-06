import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Paths — npm/bun cds into the package directory before running scripts,
// so process.cwd() is the package root at postinstall time.
// ---------------------------------------------------------------------------
const PKG_ROOT = process.cwd();
const BIN_DIR = path.join(PKG_ROOT, "bin");
const SENTINEL = path.join(BIN_DIR, ".ui-leaf-version");

// Allow test suites to redirect downloads to a local HTTP server.
const RELEASE_BASE =
  process.env["UI_LEAF_DOWNLOAD_BASE"] ??
  "https://github.com/OpenThinkAi/ui-leaf/releases/download";

// ---------------------------------------------------------------------------
// Platform → artifact mapping
// ---------------------------------------------------------------------------
interface Target {
  artifact: string; // release-asset filename
  binary: string; // filename inside bin/
}

// Exported for unit tests so they can verify mappings without calling process.exit.
export const PLATFORM_MAP: Readonly<Record<string, Target>> = {
  "darwin-arm64": { artifact: "ui-leaf-darwin-arm64", binary: "ui-leaf" },
  "darwin-x64": { artifact: "ui-leaf-darwin-x64", binary: "ui-leaf" },
  "linux-x64": { artifact: "ui-leaf-linux-x64", binary: "ui-leaf" },
  "linux-arm64": { artifact: "ui-leaf-linux-arm64", binary: "ui-leaf" },
  "win32-x64": { artifact: "ui-leaf-windows-x64.exe", binary: "ui-leaf.exe" },
};

function detectTarget(): Target {
  const plat = process.platform;
  const arch = process.arch;
  const target = PLATFORM_MAP[`${plat}-${arch}`];
  if (target) return target;
  console.error(
    `ui-leaf: unsupported platform \`${plat}-${arch}\`. ` +
      `Supported: darwin-arm64, darwin-x64, linux-x64, linux-arm64, win32-x64. ` +
      `Open an issue at https://github.com/OpenThinkAi/ui-leaf/issues`
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Package version — read from the sibling package.json at runtime.
// ---------------------------------------------------------------------------
function readVersion(): string {
  const raw = fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf8");
  const pkg = JSON.parse(raw) as { version: string };
  return pkg.version;
}

// ---------------------------------------------------------------------------
// Idempotency sentinel: bin/.ui-leaf-version contains "<version>:<artifact>"
// ---------------------------------------------------------------------------
export function isAlreadyInstalled(
  version: string,
  artifact: string,
  sentinelPath = SENTINEL
): boolean {
  try {
    return (
      fs.readFileSync(sentinelPath, "utf8").trim() === `${version}:${artifact}`
    );
  } catch {
    return false;
  }
}

async function writeSentinel(
  version: string,
  artifact: string,
  sentinelPath = SENTINEL
): Promise<void> {
  await fsp.writeFile(sentinelPath, `${version}:${artifact}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// HTTP — redirect-following fetch (max 5 redirects).
// Downgrade from https → http inside a redirect chain is always blocked.
// If the initial URL is http:// (only possible via UI_LEAF_DOWNLOAD_BASE in
// tests), http→http redirects are allowed since there was no https to
// downgrade from.
// ---------------------------------------------------------------------------
function fetchUrl(
  url: string,
  hops = 0,
  enforceHttps = url.startsWith("https://")
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    if (hops > 5) {
      reject(new Error("ui-leaf: too many redirects (> 5)"));
      return;
    }
    if (enforceHttps && !url.startsWith("https://")) {
      reject(new Error(`ui-leaf: refusing https→http redirect to ${url}`));
      return;
    }

    const requester = url.startsWith("https://") ? https : http;
    const req = requester.get(url, (res) => {
      if (
        res.statusCode !== undefined &&
        res.statusCode >= 300 &&
        res.statusCode < 400
      ) {
        const loc = res.headers["location"];
        if (!loc) {
          reject(new Error("ui-leaf: redirect with no Location header"));
          return;
        }
        res.resume(); // drain and discard redirect body
        fetchUrl(loc, hops + 1, enforceHttps).then(resolve, reject);
        return;
      }
      resolve(res);
    });
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Fetch small text payload into memory (used for checksums.txt).
// ---------------------------------------------------------------------------
async function fetchText(url: string): Promise<string> {
  const res = await fetchUrl(url);
  if (res.statusCode !== 200) {
    res.resume();
    throw new Error(`ui-leaf: HTTP ${res.statusCode} for ${url}`);
  }
  return new Promise((resolve, reject) => {
    let data = "";
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      data += chunk;
    });
    res.on("end", () => resolve(data));
    res.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Stream binary to a temp file, computing sha256 in one pass.
// ---------------------------------------------------------------------------
async function downloadToTemp(url: string, tmpPath: string): Promise<string> {
  const res = await fetchUrl(url);
  if (res.statusCode !== 200) {
    res.resume();
    throw new Error(`ui-leaf: HTTP ${res.statusCode} for ${url}`);
  }

  const hash = crypto.createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(tmpPath);
    // Both handlers receive every chunk: hash sees it, pipe writes it.
    res.on("data", (chunk: Buffer) => hash.update(chunk));
    res.pipe(out);
    out.on("finish", resolve);
    out.on("error", (e) => {
      res.destroy(e);
      reject(e);
    });
    res.on("error", (e) => {
      out.destroy(e);
      reject(e);
    });
  });

  return hash.digest("hex");
}

// ---------------------------------------------------------------------------
// Retry with exponential backoff: attempts 1/2/3 wait 0/1s/2s before retry.
// ---------------------------------------------------------------------------
function sleep(ms: number): Promise<void> {
  // Collapse delays in tests so retry cases don't slow down the suite.
  const actual = process.env["UI_LEAF_TEST_FAST_RETRY"] ? 10 : ms;
  return new Promise((r) => setTimeout(r, actual));
}

async function withRetry<T>(fn: () => Promise<T>, label = ""): Promise<T> {
  let lastErr!: Error;
  for (let i = 0; i < 3; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err as Error;
      if (i < 2) {
        const delay = 1000 * 2 ** i;
        console.warn(
          `ui-leaf: ${label ? label + " — " : ""}attempt ${i + 1} failed (${lastErr.message}); retrying in ${delay / 1000}s…`
        );
        await sleep(delay);
      }
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// checksums.txt parser — format: "<hex>  <filename>" (two spaces, sha256sum)
// ---------------------------------------------------------------------------
export function parseChecksums(text: string, artifact: string): string {
  for (const line of text.split("\n")) {
    const parts = line.trim().split(/\s+/, 2);
    if (parts.length === 2 && parts[1] === artifact && parts[0]) {
      return parts[0];
    }
  }
  throw new Error(
    `ui-leaf: no checksum entry for ${artifact} in checksums.txt`
  );
}

// ---------------------------------------------------------------------------
// Windows JS launcher — written to bin/ui-leaf when installing on win32.
// npm's bin shim will invoke this file; it spawns the sibling .exe.
// ---------------------------------------------------------------------------
const WIN_LAUNCHER = `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const child = spawn(
  path.join(__dirname, 'ui-leaf.exe'),
  process.argv.slice(2),
  { stdio: 'inherit' }
);
child.on('exit', (code) => process.exit(code ?? 1));
`;

// ---------------------------------------------------------------------------
// UI_LEAF_BINARY_PATH — install from local path, skip download.
// On POSIX this creates a symlink; if the source is moved/deleted the link
// silently breaks. Use an absolute path to avoid CWD-relative surprises.
// ---------------------------------------------------------------------------
async function installFromEnvPath(
  envPath: string,
  binaryDest: string
): Promise<void> {
  if (process.platform === "win32") {
    await fsp.copyFile(envPath, binaryDest);
  } else {
    try {
      await fsp.unlink(binaryDest);
    } catch {
      /* not present */
    }
    await fsp.symlink(path.resolve(envPath), binaryDest);
    // chmod the real file, not the link (symlinks don't have independent perms on most POSIX systems).
    await fsp.chmod(path.resolve(envPath), 0o755);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const target = detectTarget();
  const version = readVersion();
  const isWindows = process.platform === "win32";

  await fsp.mkdir(BIN_DIR, { recursive: true });

  // UI_LEAF_SKIP_DOWNLOAD=1: for offline/air-gapped CI; exits 0 without a binary.
  if (process.env["UI_LEAF_SKIP_DOWNLOAD"] === "1") {
    console.log(
      "ui-leaf: UI_LEAF_SKIP_DOWNLOAD=1 — skipping binary download. " +
        "Set UI_LEAF_BINARY_PATH=/path/to/ui-leaf before using the binary."
    );
    return;
  }

  // Short-circuit: use a pre-built binary supplied by the caller.
  const envPath = process.env["UI_LEAF_BINARY_PATH"];
  if (envPath) {
    const binaryDest = path.join(BIN_DIR, target.binary);
    await installFromEnvPath(envPath, binaryDest);
    await writeSentinel(version, `env-override:${target.artifact}`);
    console.log(`ui-leaf: installed from UI_LEAF_BINARY_PATH (${envPath})`);
    return;
  }

  // Idempotency: if the sentinel matches version + artifact, nothing to do.
  if (isAlreadyInstalled(version, target.artifact)) {
    console.log(
      `ui-leaf: ${target.artifact} v${version} already installed — skipping`
    );
    return;
  }

  const tag = `v${version}`;
  const checksumsUrl = `${RELEASE_BASE}/${tag}/checksums.txt`;
  const binaryUrl = `${RELEASE_BASE}/${tag}/${target.artifact}`;
  const binaryDest = path.join(BIN_DIR, target.binary);
  const tmpBinary = `${binaryDest}.tmp.${process.pid}`;

  // 1. Fetch checksums.txt and extract the expected digest for our artifact.
  console.log("ui-leaf: fetching checksums…");
  let expectedDigest: string;
  try {
    const csText = await withRetry(() => fetchText(checksumsUrl), "fetch checksums");
    expectedDigest = parseChecksums(csText, target.artifact);
  } catch (err) {
    console.error(
      `ui-leaf: failed to fetch checksums: ${(err as Error).message}\n` +
        "  If you're behind a proxy, Node's https.get does not read HTTPS_PROXY.\n" +
        "  Workaround: download the binary manually and set UI_LEAF_BINARY_PATH=/path/to/ui-leaf"
    );
    process.exit(1);
  }

  // 2. Download binary, computing sha256 in the same pass.
  console.log(`ui-leaf: downloading ${target.artifact}…`);
  let actualDigest: string;
  try {
    actualDigest = await withRetry(
      () => downloadToTemp(binaryUrl, tmpBinary),
      `download ${target.artifact}`
    );
  } catch (err) {
    await fsp.unlink(tmpBinary).catch(() => {});
    console.error(
      `ui-leaf: download failed: ${(err as Error).message}\n` +
        "  If you're behind a proxy, Node's https.get does not read HTTPS_PROXY.\n" +
        "  Workaround: set UI_LEAF_BINARY_PATH=/path/to/ui-leaf"
    );
    process.exit(1);
  }

  // 3. Verify SHA256.
  if (actualDigest !== expectedDigest) {
    await fsp.unlink(tmpBinary).catch(() => {});
    console.error(
      `ui-leaf: SHA256 mismatch for ${target.artifact}.\n` +
        `  expected: ${expectedDigest}\n` +
        `  actual:   ${actualDigest}`
    );
    process.exit(1);
  }

  // 4. Atomic rename into place, then chmod / write Windows launcher.
  await fsp.rename(tmpBinary, binaryDest);

  if (isWindows) {
    // Replace the stub at bin/ui-leaf with a Node launcher for the .exe.
    await fsp.writeFile(path.join(BIN_DIR, "ui-leaf"), WIN_LAUNCHER, "utf8");
  } else {
    await fsp.chmod(binaryDest, 0o755);
  }

  await writeSentinel(version, target.artifact);
  console.log(`ui-leaf: installed ${target.artifact} v${version}`);
}

// Run only when executed directly; skip when imported by test files.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(`ui-leaf: unexpected error: ${(err as Error).message}`);
    process.exit(1);
  });
}
