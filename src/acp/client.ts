/**
 * ACP client — JSON-RPC 2.0 over stdio (NDJSON), spawned `goose acp` agent.
 *
 * Responsibilities:
 *  - Framing: one JSON message per line on the agent's stdout, ours on stdin
 *  - Requests with ids and pending-response map (optional per-request timeout)
 *  - Routing of agent→client requests (fs/*, session/request_permission) to
 *    registered handlers, agent→client notifications to `onUpdate`
 *  - Lifecycle: spawn → initialize → session/new|load → prompt ⇄ updates → cancel
 *
 * Goose custom requests (system prompt, extensions, rename, …) live in `custom.ts`.
 */

import { spawn, type ChildProcess } from "node:child_process";
import type {
  ContentBlock,
  InitializeRequest,
  InitializeResponse,
  JsonRpcMessage,
  LoadSessionRequest,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  RequestPermissionResponse,
  SessionNotification,
} from "./types";

/** JSON-RPC error codes used by ACP. */
const ERR = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
} as const;

export interface AcpClientOptions {
  /** Binary to run; default "goose". Must support the `acp` subcommand. */
  bin?: string;
  /** Extra args for the agent, e.g. ["--with-builtin", "developer"]. */
  args?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Called for every line the agent prints on stderr (not part of the protocol). */
  onStderr?: (line: string) => void;
  /** Called when the agent process exits. */
  onExit?: (code: number | null) => void;
}

export interface RequestHandlerResult {
  result: unknown;
}

export type ServerRequestHandler = (params: any) => Promise<unknown> | unknown;

export interface PromptHandlers {
  /** `session/request_permission` — must resolve to a permission outcome. */
  requestPermission: (params: any) => Promise<RequestPermissionResponse>;
  /** `fs/read_text_file` — required when advertising fs.readTextFile. */
  readTextFile?: (params: any) => Promise<{ content: string }>;
  /** `fs/write_text_file` — required when advertising fs.writeTextFile. */
  writeTextFile?: (params: any) => Promise<unknown>;
  /** Any other agent→client request (elicitation, terminal, …). */
  onRequest?: (method: string, params: any) => Promise<unknown> | unknown;
}

export interface SessionUpdateCallback {
  (notification: SessionNotification): void;
}

export class AcpClient {
  private child!: ChildProcess;
  private nextId = 1;
  private buffer = "";
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout | null }
  >();
  private updateCb: SessionUpdateCallback | null = null;
  private promptHandlers: PromptHandlers | null = null;
  private exiting = false;

  /** agentCapabilities from the initialize handshake. */
  agentInfo: InitializeResponse | null = null;

  private constructor(
    private readonly opts: AcpClientOptions,
  ) {}

  /**
   * Spawn the agent process and wire the transport. Does not send `initialize`.
   */
  static spawn(opts: AcpClientOptions = {}): AcpClient {
    const client = new AcpClient(opts);
    client.child = spawn(opts.bin ?? "goose", ["acp", ...(opts.args ?? [])], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env } as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });

    client.child.stdout!.setEncoding("utf-8");
    client.child.stdout!.on("data", (chunk: string) => client.feed(chunk));
    client.child.stderr!.setEncoding("utf-8");
    client.child.stderr!.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (line.trim() && opts.onStderr) opts.onStderr(line);
      }
    });
    client.child.on("exit", (code) => {
      if (opts.onExit) opts.onExit(code);
      client.failPending(new Error(`goose acp exited (code ${code})`));
    });
    // Fires on spawn failure (e.g. goose not installed) — without this, Node
    // throws an uncaught 'error' event instead of a readable message.
    client.child.on("error", (err) => {
      client.failPending(new Error(`failed to start goose acp: ${err.message}`));
    });
    return client;
  }

  // ─── Transport plumbing ────────────────────────────────────────────────────

  private feed(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line) this.dispatch(line);
    }
  }

  private dispatch(line: string): void {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line);
    } catch {
      this.opts.onStderr?.(`[acp] non-JSON stdout line: ${line.slice(0, 200)}`);
      return;
    }

    if ("id" in msg && ((msg as any).result !== undefined || (msg as any).error !== undefined)) {
      const entry = this.pending.get((msg as any).id);
      if (entry) {
        this.pending.delete((msg as any).id);
        if (entry.timer) clearTimeout(entry.timer);
        const err = (msg as any).error;
        if (err) {
          entry.reject(new Error(`${err.message} (code ${err.code})${err.data ? `: ${JSON.stringify(err.data).slice(0, 500)}` : ""}`));
        } else {
          entry.resolve((msg as any).result);
        }
      }
      return;
    }

    if ("method" in msg) {
      if ("id" in msg) {
        // Agent → client request; must be answered.
        this.handleServerRequest(msg as any).catch(() => {
          /* handler already sent an error response */
        });
      } else {
        // Agent → client notification.
        const params = (msg as any).params as SessionNotification | undefined;
        if ((msg as any).method === "session/update" && params?.update && this.updateCb) {
          this.updateCb(params);
        }
      }
    }
  }

  private async handleServerRequest(msg: { id: number; method: string; params?: any }): Promise<void> {
    let result: unknown;
    try {
      result = await this.routeServerRequest(msg.method, msg.params ?? {});
    } catch (error) {
      this.respond(msg.id, undefined, {
        code: ERR.INTERNAL,
        message: String((error as Error)?.message ?? error),
      });
      return;
    }
    this.respond(msg.id, result);
  }

  private async routeServerRequest(method: string, params: any): Promise<unknown> {
    const h = this.promptHandlers;
    if (!h) throw new Error("no handlers registered");
    switch (method) {
      case "session/request_permission":
        return h.requestPermission(params);
      case "fs/read_text_file":
        if (!h.readTextFile) throw new Error("fs.readTextFile not supported by client");
        return h.readTextFile(params);
      case "fs/write_text_file":
        if (!h.writeTextFile) throw new Error("fs.writeTextFile not supported by client");
        return h.writeTextFile(params) ?? {};
      default:
        if (h.onRequest) return h.onRequest(method, params);
        throw new Error(`method not found: ${method}`);
    }
  }

  private respond(id: number, result?: unknown, error?: { code: number; message: string }): void {
    this.send(error
      ? { jsonrpc: "2.0", id, error }
      : { jsonrpc: "2.0", id, result: result ?? {} });
  }

  private send(msg: Record<string, unknown>): void {
    if (this.exiting) return;
    this.child.stdin!.write(JSON.stringify(msg) + "\n");
  }

  private failPending(error: Error): void {
    for (const [, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Send a JSON-RPC request. `timeoutMs <= 0` means wait forever — use for
   * `session/prompt`, which can run for minutes.
   */
  request(method: string, params?: unknown, timeoutMs = 30_000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`acp request timeout: ${method}`));
          }, timeoutMs)
        : null;
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  onUpdate(cb: SessionUpdateCallback): void {
    this.updateCb = cb;
  }

  /**
   * Register agent→client handlers before `initialize` so capability
   * negotiation matches what we can actually serve.
   */
  setPromptHandlers(handlers: PromptHandlers): void {
    this.promptHandlers = handlers;
  }

  async initialize(clientCapabilities: InitializeRequest["clientCapabilities"]): Promise<InitializeResponse> {
    this.agentInfo = (await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities,
    }, 30_000)) as InitializeResponse;
    return this.agentInfo;
  }

  supportsLoadSession(): boolean {
    return this.agentInfo?.agentCapabilities?.loadSession === true;
  }

  async newSession(req: NewSessionRequest): Promise<NewSessionResponse> {
    return (await this.request("session/new", req, 60_000)) as NewSessionResponse;
  }

  async loadSession(req: LoadSessionRequest): Promise<void> {
    // Session updates (history replay) arrive via onUpdate while awaiting.
    await this.request("session/load", req, 60_000);
  }

  async prompt(sessionId: string, prompt: ContentBlock[]): Promise<PromptResponse> {
    const req: PromptRequest = { sessionId, prompt };
    return (await this.request("session/prompt", req, 0)) as PromptResponse;
  }

  cancel(sessionId: string): void {
    this.notify("session/cancel", { sessionId });
  }

  /** Graceful shutdown: close stdin, give the agent a moment, then SIGKILL. */
  async stop(timeoutMs = 2_000): Promise<void> {
    this.exiting = true;
    this.failPending(new Error("acp client stopped"));
    const child = this.child;
    if (child.exitCode !== null || child.signalCode) return;
    child.stdin!.end();
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    await exited;
    clearTimeout(timer);
  }
}
