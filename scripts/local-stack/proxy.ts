// Deterministic fault injection between services: each inter-service link (for example
// control→wallet or relayer→rpc) goes through a loopback proxy. A rule can drop a request before
// delivery or drop the reply after the callee committed, and can run a hook (for example killing
// every service process) at that exact boundary.
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface ProxyRequest {
  link: string;
  method: string;
  path: string;
  body: string;
  /** JSON-RPC method for RPC links. */
  rpcMethod: string | undefined;
  headers: Record<string, string | string[] | undefined>;
}

export interface FaultRule {
  match: (r: ProxyRequest) => boolean;
  /** How many matching requests this rule handles (default 1). */
  times?: number;
  /** Runs before forwarding; "drop" closes the connection without delivering the request. */
  before?: (r: ProxyRequest) => Promise<"forward" | "drop"> | "forward" | "drop";
  /** Runs after the callee replied; "drop" closes the connection without delivering the reply. */
  after?: (r: ProxyRequest, reply: { status: number; body: string }) => Promise<"deliver" | "drop"> | "deliver" | "drop";
  hits?: number;
}

export interface LoggedRequest {
  at: number;
  method: string;
  path: string;
  rpcMethod: string | undefined;
  status: number | "dropped" | "error";
}

async function readAll(stream: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

export class FaultProxy {
  readonly rules: FaultRule[] = [];
  readonly log: LoggedRequest[] = [];
  #server: Server | undefined;

  constructor(
    readonly link: string,
    readonly port: number,
    readonly target: string,
  ) {}

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  add(rule: FaultRule): FaultRule {
    rule.hits = 0;
    this.rules.push(rule);
    return rule;
  }

  clear(): void {
    this.rules.length = 0;
  }

  count(pred: (l: LoggedRequest) => boolean): number {
    return this.log.filter(pred).length;
  }

  async start(): Promise<void> {
    this.#server = createServer((req, res) => void this.#handle(req, res));
    this.#server.keepAliveTimeout = 65_000;
    await new Promise<void>((resolve, reject) => {
      this.#server!.once("error", reject);
      this.#server!.listen(this.port, "127.0.0.1", () => resolve());
    });
  }

  async close(): Promise<void> {
    if (!this.#server) return;
    this.#server.closeAllConnections();
    await new Promise<void>((r) => this.#server!.close(() => r()));
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readAll(req);
    let rpcMethod: string | undefined;
    if (req.headers["content-type"]?.includes("json") && body.length > 0 && body[0] === 0x7b) {
      try {
        const m = (JSON.parse(body.toString("utf8")) as { method?: unknown }).method;
        rpcMethod = typeof m === "string" && (req.url ?? "/") === "/" ? m : undefined;
      } catch {
        rpcMethod = undefined;
      }
    }
    const pr: ProxyRequest = { link: this.link, method: req.method ?? "GET", path: (req.url ?? "/").split("?")[0]!, body: body.toString("utf8"), rpcMethod, headers: req.headers };
    const entry: LoggedRequest = { at: Date.now(), method: pr.method, path: pr.path, rpcMethod, status: "error" };
    this.log.push(entry);
    const rule = this.rules.find((r) => (r.hits ?? 0) < (r.times ?? 1) && r.match(pr));
    if (rule) rule.hits = (rule.hits ?? 0) + 1;
    if (rule?.before && (await rule.before(pr)) === "drop") {
      entry.status = "dropped";
      req.socket.destroy();
      return;
    }
    const target = new URL(this.target);
    let upstream: { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer };
    try {
      upstream = await new Promise((resolve, reject) => {
        const headers = { ...req.headers, host: target.host };
        const out = httpRequest({ host: target.hostname, port: target.port, path: req.url, method: req.method, headers, agent: false }, (r) => {
          readAll(r).then((b) => resolve({ status: r.statusCode ?? 502, headers: r.headers, body: b }), reject);
        });
        out.setTimeout(180_000, () => out.destroy(new Error("upstream timeout")));
        out.on("error", reject);
        out.end(body);
      });
    } catch {
      entry.status = "error";
      req.socket.destroy();
      return;
    }
    if (rule?.after && (await rule.after(pr, { status: upstream.status, body: upstream.body.toString("utf8") })) === "drop") {
      entry.status = "dropped";
      req.socket.destroy();
      return;
    }
    entry.status = upstream.status;
    const headers = { ...upstream.headers };
    delete headers["transfer-encoding"];
    delete headers.connection;
    headers["content-length"] = String(upstream.body.length);
    res.writeHead(upstream.status, headers);
    res.end(upstream.body);
  }
}
