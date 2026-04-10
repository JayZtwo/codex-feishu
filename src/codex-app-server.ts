import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export interface AppServerJsonRpcError {
  code?: number;
  message?: string;
  data?: unknown;
}

export interface AppServerJsonRpcMessage {
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: AppServerJsonRpcError;
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}

export type AppServerEventHandler = (message: AppServerJsonRpcMessage) => void;

function stringifyJsonRpcError(error: AppServerJsonRpcError): string {
  if (typeof error.message === 'string' && error.message.trim()) {
    if (error.data === undefined) {
      return error.message;
    }
    try {
      return `${error.message}: ${JSON.stringify(error.data)}`;
    } catch {
      return error.message;
    }
  }

  if (error.data !== undefined) {
    try {
      return JSON.stringify(error.data);
    } catch {
      return 'Unknown JSON-RPC error';
    }
  }

  return 'Unknown JSON-RPC error';
}

function isJsonRpcResponse(message: AppServerJsonRpcMessage): boolean {
  return message.id !== undefined && (Object.prototype.hasOwnProperty.call(message, 'result') || Object.prototype.hasOwnProperty.call(message, 'error'));
}

export class CodexAppServerClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private startPromise: Promise<void> | null = null;
  private nextRequestId = 1;
  private initialized = false;
  private lineBuffer = '';
  private stderrBuffer = '';
  private pendingRequests = new Map<string | number, PendingRequest>();
  private handlers = new Set<AppServerEventHandler>();

  constructor(
    private readonly codexPath: string,
    private readonly env: Record<string, string>,
    private readonly cwd: string,
  ) {}

  subscribe(handler: AppServerEventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  getLastStderr(): string {
    return this.stderrBuffer.trim();
  }

  async request<T>(method: string, params: unknown): Promise<T> {
    await this.ensureStarted();
    const id = this.nextRequestId++;
    return this.sendRequestInternal<T>(id, method, params);
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.ensureStarted();
    this.writeMessage(params === undefined ? { method } : { method, params });
  }

  async respond(id: string | number, result: unknown): Promise<void> {
    await this.ensureStarted();
    this.writeMessage({ id, result });
  }

  private async ensureStarted(): Promise<void> {
    if (this.initialized && this.child && !this.child.killed) {
      return;
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = this.start().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async start(): Promise<void> {
    if (this.child && !this.child.killed) {
      return;
    }

    this.lineBuffer = '';
    this.stderrBuffer = '';
    this.initialized = false;

    const child = spawn(
      this.codexPath,
      ['app-server', '--listen', 'stdio://', '-c', 'skip_git_repo_check=true'],
      {
        cwd: this.cwd,
        env: this.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.handleStdout(chunk));
    child.stderr.on('data', (chunk: string) => {
      this.stderrBuffer = `${this.stderrBuffer}${chunk}`.slice(-32_768);
    });
    child.once('error', (error) => {
      this.handleProcessClose(error instanceof Error ? error.message : String(error));
    });
    child.once('close', (code, signal) => {
      const reason = code === null
        ? `Codex app-server exited with signal ${signal ?? 'unknown'}`
        : `Codex app-server exited with code ${code}`;
      this.handleProcessClose(reason);
    });

    this.child = child;

    await this.sendRequestInternal(0, 'initialize', {
      clientInfo: {
        name: 'codex-feishu',
        version: '0.1.0',
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    this.writeMessage({ method: 'initialized' });
    this.initialized = true;
  }

  private async sendRequestInternal<T>(
    id: string | number,
    method: string,
    params: unknown,
  ): Promise<T> {
    const child = this.child;
    if (!child || child.killed) {
      throw new Error('Codex app-server is not running');
    }

    return new Promise<T>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      try {
        this.writeMessage({ id, method, params });
      } catch (error) {
        this.pendingRequests.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private writeMessage(message: Record<string, unknown>): void {
    const child = this.child;
    if (!child || child.killed || child.stdin.destroyed) {
      throw new Error('Codex app-server stdin is unavailable');
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleStdout(chunk: string): void {
    this.lineBuffer += chunk;

    while (true) {
      const newlineIndex = this.lineBuffer.indexOf('\n');
      if (newlineIndex < 0) {
        break;
      }

      const line = this.lineBuffer.slice(0, newlineIndex).trim();
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }

      let message: AppServerJsonRpcMessage;
      try {
        message = JSON.parse(line) as AppServerJsonRpcMessage;
      } catch {
        continue;
      }

      if (isJsonRpcResponse(message)) {
        const pending = this.pendingRequests.get(message.id!);
        if (!pending) {
          continue;
        }
        this.pendingRequests.delete(message.id!);
        if (message.error) {
          pending.reject(new Error(stringifyJsonRpcError(message.error)));
        } else {
          pending.resolve(message.result);
        }
        continue;
      }

      for (const handler of this.handlers) {
        handler(message);
      }
    }
  }

  private handleProcessClose(reason: string): void {
    if (!this.child && this.pendingRequests.size === 0) {
      return;
    }

    this.child = null;
    this.initialized = false;
    this.startPromise = null;

    const message = this.stderrBuffer.trim()
      ? `${reason}\n${this.stderrBuffer.trim()}`
      : reason;

    for (const [, pending] of this.pendingRequests) {
      pending.reject(new Error(message));
    }
    this.pendingRequests.clear();

    const event: AppServerJsonRpcMessage = {
      method: '__connection_closed__',
      params: { message },
    };
    for (const handler of this.handlers) {
      handler(event);
    }
  }
}
