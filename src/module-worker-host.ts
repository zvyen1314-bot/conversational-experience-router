import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { ExperienceContext, ExperienceModule, ExperienceModuleResult } from "./module-api.js";
import type { ExperienceManifest, SessionEvent, SessionState } from "./types.js";

interface WorkerRequest {
  id: string;
  method: "start" | "handleEvent";
  context: ExperienceContext;
  state?: SessionState;
  event?: SessionEvent;
}

interface WorkerResponse {
  id: string;
  ok: boolean;
  result?: SessionState | ExperienceModuleResult;
  error?: string;
}

export class IsolatedExperienceModule implements ExperienceModule {
  private child?: ChildProcess;
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  constructor(
    readonly manifest: ExperienceManifest,
    private readonly modulePath: string,
  ) {}

  async start(context: ExperienceContext): Promise<SessionState> {
    return this.call<SessionState>({ id: randomUUID(), method: "start", context });
  }

  async handleEvent(context: ExperienceContext, state: SessionState, event: SessionEvent): Promise<ExperienceModuleResult> {
    return this.call<ExperienceModuleResult>({ id: randomUUID(), method: "handleEvent", context, state, event });
  }

  close(): void {
    if (this.child && !this.child.killed) this.child.kill();
    this.failPending(new Error("模块子进程已关闭。"));
    this.child = undefined;
  }

  private call<T>(request: WorkerRequest): Promise<T> {
    const child = this.ensureChild();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(request.id, { resolve: (value) => resolve(value as T), reject });
      child.send(request, (error) => {
        if (error) {
          this.pending.delete(request.id);
          reject(error);
        }
      });
    });
  }

  private ensureChild(): ChildProcess {
    if (this.child && this.child.connected) return this.child;
    const workerPath = fileURLToPath(new URL("./module-worker-child.js", import.meta.url));
    const child = fork(workerPath, [this.modulePath], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: { ...process.env, EXPERIENCE_MODULE_CHILD: "1" },
    });
    child.on("message", (message: WorkerResponse) => {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(message.error ?? "模块子进程执行失败。"));
    });
    child.on("error", (error) => this.failPending(error));
    child.on("exit", (code, signal) => {
      if (this.child === child) this.child = undefined;
      if (code !== 0 || signal) this.failPending(new Error(`模块子进程已退出（code=${code ?? "none"}, signal=${signal ?? "none"}）。`));
    });
    this.child = child;
    return child;
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
