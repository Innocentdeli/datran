// Starts a live reactor for the tests (REACTOR_BIN) or uses REACTOR_URL (+ REACTOR_TOKEN).
// Falls back to ../../core-reactor/target/release/core-reactor[.exe]; returns null when none is available.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

function defaultBin() {
  const root = resolve(here, "..", "..", "..", "core-reactor", "target", "release");
  for (const n of ["core-reactor.exe", "core-reactor"]) {
    const p = join(root, n);
    if (existsSync(p)) return p;
  }
  return undefined;
}

/** @returns {Promise<{url: string, token: string | undefined, stop: () => Promise<void>} | null>} */
export async function startReactor() {
  if (process.env.REACTOR_URL) {
    return { url: process.env.REACTOR_URL.replace(/\/+$/, ""), token: process.env.REACTOR_TOKEN || undefined, stop: async () => {} };
  }
  const bin = process.env.REACTOR_BIN || defaultBin();
  if (!bin || !existsSync(bin)) return null;
  const token = process.env.REACTOR_TOKEN || `test-${randomBytes(8).toString("hex")}`;
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), "datran-ts-"));
  const env = { ...process.env, REACTOR_PORT: String(port), REACTOR_TOKEN: token, REACTOR_STATE_DIR: dir, REACTOR_BIND: "127.0.0.1" };
  delete env.REACTOR_CLUSTER_TOKEN;
  const child = spawn(bin, [], { env, stdio: "ignore" });
  let exited = false;
  child.on("exit", () => (exited = true));
  const url = `http://127.0.0.1:${port}`;
  const stop = async () => {
    if (!exited) {
      const done = new Promise((r) => child.once("exit", r));
      child.kill();
      await done;
    }
    rmSync(dir, { recursive: true, force: true });
  };
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`reactor exited early (code ${child.exitCode})`);
    try {
      const r = await fetch(`${url}/health`);
      if (r.ok) return { url, token, stop };
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  await stop();
  throw new Error("reactor did not become healthy within 30 s");
}

/**
 * Starts `n` reactors from REACTOR_BIN with REACTOR_PEERS pointing at each other (data gravity).
 * REACTOR_MIN_REPLICAS=1 and a huge REACTOR_GRAVITY_PULL keep placement deterministic (reads on a
 * non-holder are remote reads). Returns null without a binary (or when only REACTOR_URL is set).
 * @returns {Promise<{urls: string[], token: string, clusterToken: string, stop: () => Promise<void>} | null>}
 */
export async function startCluster(n = 2, gossipMs = 200) {
  if (process.env.REACTOR_URL && !process.env.REACTOR_BIN) return null;
  const bin = process.env.REACTOR_BIN || defaultBin();
  if (!bin || !existsSync(bin)) return null;
  const token = `test-${randomBytes(8).toString("hex")}`;
  const clusterToken = `cluster-${randomBytes(8).toString("hex")}`;
  const ports = [];
  for (let i = 0; i < n; i++) ports.push(await freePort());
  const urls = ports.map((p) => `http://127.0.0.1:${p}`);
  const nodes = [];
  const stop = async () => {
    await Promise.all(
      nodes.map(async ({ child, dir, exited }) => {
        if (!exited()) {
          const done = new Promise((r) => child.once("exit", r));
          child.kill();
          await done;
        }
        rmSync(dir, { recursive: true, force: true });
      }),
    );
  };
  try {
    for (let i = 0; i < n; i++) {
      const dir = mkdtempSync(join(tmpdir(), `datran-ts-c${i}-`));
      const env = {
        ...process.env,
        REACTOR_PORT: String(ports[i]),
        REACTOR_TOKEN: token,
        REACTOR_STATE_DIR: dir,
        REACTOR_BIND: "127.0.0.1",
        REACTOR_CLUSTER_TOKEN: clusterToken,
        REACTOR_PEERS: urls.filter((_, j) => j !== i).join(","),
        REACTOR_GOSSIP_INTERVAL_MS: String(gossipMs),
        REACTOR_MIN_REPLICAS: "1",
        REACTOR_GRAVITY_PULL: "1000000",
      };
      const child = spawn(bin, [], { env, stdio: "ignore" });
      let exited = false;
      child.on("exit", () => (exited = true));
      nodes.push({ child, dir, exited: () => exited });
    }
    const deadline = Date.now() + 30_000;
    for (let i = 0; i < n; i++) {
      for (;;) {
        if (nodes[i].exited()) throw new Error(`reactor ${i} exited early (code ${nodes[i].child.exitCode})`);
        try {
          if ((await fetch(`${urls[i]}/health`)).ok) break;
        } catch {
          /* not up yet */
        }
        if (Date.now() > deadline) throw new Error("cluster did not become healthy within 30 s");
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  } catch (e) {
    await stop();
    throw e;
  }
  return { urls, token, clusterToken, stop };
}
