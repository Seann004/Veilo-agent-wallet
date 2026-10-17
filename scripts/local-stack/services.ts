// Runs the real service entry points (services/*/src/index.ts) as separate OS processes with a
// generated environment file. Restarting means killing the process outright (no graceful
// shutdown) and starting it again over the same databases, which is how crash boundaries are
// exercised. Child processes get a minimal inherited environment so nothing from the caller's
// shell (for example a devnet RPC) can override the generated file.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO, sleep } from "../devnet/lib";

export const SERVICES = ["relayer", "gateway", "control", "wallet", "runner"] as const;
export type ServiceName = (typeof SERVICES)[number];

const PASS_THROUGH = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "windir", "TEMP", "TMP", "USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA", "COMSPEC", "USERNAME", "USERDOMAIN", "PATHEXT", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE"];

export interface ServiceProcessOptions {
  envFile: string;
  logDir: string;
  /** Port each service listens on (health checks go here, not through proxies). */
  ports: Record<ServiceName, number>;
  /** Per-service environment overrides (proxy URLs/ports, crash points). */
  env: Record<ServiceName, Record<string, string>>;
}

interface Running {
  child: ChildProcess;
  exited: Promise<number | null>;
  logOffset: number;
}

export class ServiceProcesses {
  readonly #running = new Map<ServiceName, Running>();
  readonly exits: Array<{ service: ServiceName; code: number | null; at: number; expected: boolean }> = [];
  readonly #expected = new Set<ServiceName>();

  constructor(readonly o: ServiceProcessOptions) {
    mkdirSync(o.logDir, { recursive: true });
  }

  logPath(name: ServiceName): string {
    return join(this.o.logDir, `${name}.log`);
  }

  /** Log text written since the current process started (or the whole log). */
  logText(name: ServiceName, sinceStart = false): string {
    const p = this.logPath(name);
    if (!existsSync(p)) return "";
    const text = readFileSync(p, "utf8");
    return sinceStart ? text.slice(this.#running.get(name)?.logOffset ?? 0) : text;
  }

  running(name: ServiceName): boolean {
    return this.#running.has(name);
  }

  start(name: ServiceName, extra: Record<string, string> = {}): void {
    if (this.#running.has(name)) throw new Error(`${name} is already running`);
    // A process left behind by an interrupted harness would hold the port and the databases.
    const pidFile = join(this.o.logDir, `${name}.pid`);
    if (existsSync(pidFile)) {
      try {
        process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
      } catch {
        // already gone
      }
      unlinkSync(pidFile);
    }
    const base: Record<string, string> = {};
    for (const k of PASS_THROUGH) if (process.env[k] !== undefined) base[k] = process.env[k]!;
    const env = { ...base, VEILO_ENV_FILE: this.o.envFile, ...this.o.env[name], ...extra };
    const logPath = this.logPath(name);
    const logOffset = existsSync(logPath) ? statSync(logPath).size : 0;
    const fd = openSync(logPath, "a");
    const child = spawn(process.execPath, ["--import", "tsx", join("services", name, "src", "index.ts")], { cwd: REPO, env, stdio: ["ignore", fd, fd], windowsHide: true });
    closeSync(fd);
    if (child.pid !== undefined) writeFileSync(pidFile, String(child.pid));
    const exited = new Promise<number | null>((resolve) => {
      child.once("exit", (code) => {
        this.exits.push({ service: name, code, at: Date.now(), expected: this.#expected.delete(name) });
        if (this.#running.get(name)?.child === child) this.#running.delete(name);
        try {
          if (readFileSync(pidFile, "utf8") === String(child.pid)) unlinkSync(pidFile);
        } catch {
          // already removed
        }
        resolve(code);
      });
    });
    this.#running.set(name, { child, exited, logOffset });
  }

  /** Hard kill: the process gets no chance to flush or clean up. */
  async kill(name: ServiceName): Promise<void> {
    const r = this.#running.get(name);
    if (!r) return;
    this.#expected.add(name);
    r.child.kill("SIGKILL");
    await r.exited;
  }

  async killAll(): Promise<void> {
    await Promise.all(SERVICES.map((s) => this.kill(s)));
  }

  /** Resolves when the process exits on its own (for crash points). */
  async exitOf(name: ServiceName): Promise<number | null> {
    const r = this.#running.get(name);
    return r ? r.exited : null;
  }

  async waitHealthy(name: ServiceName, timeoutMs = 90_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (!this.#running.has(name)) throw new Error(`${name} exited during startup:\n${this.logText(name).slice(-1500)}`);
      try {
        const res = await fetch(`http://127.0.0.1:${this.o.ports[name]}/health`, { signal: AbortSignal.timeout(3_000) });
        if (res.status === 200) return;
      } catch {
        // not listening yet
      }
      if (Date.now() > deadline) throw new Error(`${name} not healthy within ${timeoutMs} ms:\n${this.logText(name, true).slice(-1500)}`);
      await sleep(500);
    }
  }

  /** Waits for the wallet's startup reconciliation to report ready=true. */
  async waitWalletReady(timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!/startup reconciliation: \d+ mismatch\(es\), ready=true/.test(this.logText("wallet", true))) {
      if (!this.#running.has("wallet")) throw new Error(`wallet exited:\n${this.logText("wallet").slice(-1500)}`);
      if (Date.now() > deadline) throw new Error(`wallet startup reconciliation not ready within ${timeoutMs} ms:\n${this.logText("wallet", true).slice(-1500)}`);
      await sleep(500);
    }
  }

  async startAll(extra: Partial<Record<ServiceName, Record<string, string>>> = {}): Promise<void> {
    for (const s of SERVICES) if (!this.#running.has(s)) this.start(s, extra[s] ?? {});
    for (const s of SERVICES) await this.waitHealthy(s);
    await this.waitWalletReady();
  }

  async restartAll(extra: Partial<Record<ServiceName, Record<string, string>>> = {}): Promise<void> {
    await this.killAll();
    await this.startAll(extra);
  }
}
