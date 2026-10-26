import { createHash, randomBytes, randomUUID } from "node:crypto";
import { ModuleRegistry } from "./registry.js";
import type { ExperienceContext, ExperienceModule } from "./module-api.js";
import { createAuditRecord, type AuditRecord, type DocumentStore } from "./persistence.js";
import { buildConsentPolicy, contextEnvelopeSchema, scopeContext, type ConsentPolicy, type ContextEnvelope } from "./protocol.js";
import type {
  ConsentRequest,
  ExperienceSession,
  LaunchResult,
  SessionEvent,
  SessionSnapshot,
  SessionState,
} from "./types.js";

const CONSENT_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 10 * 60 * 1000;
const MAX_EVENTS_PER_SESSION = 50;

interface StoredConsent {
  tokenHash: string;
  experienceId: string;
  expiresAt: number;
  used: boolean;
  policy: ConsentPolicy;
  contextEnvelope?: ContextEnvelope;
  receiptId: string;
  revoked: boolean;
}

export interface RuntimeOptions {
  allowedCapabilities?: string[];
}

export type PrepareLaunchResult =
  | ({ status: "consent_required" } & ConsentRequest)
  | { status: "not_found" | "invalid_context" | "invalid_scope" | "invalid_capability"; message: string; experienceId: string };

export interface SessionActionResult {
  status: "ok" | "invalid" | "expired" | "finished";
  message: string;
  snapshot?: SessionSnapshot;
}

export interface ConsentStatusResult {
  status: "active" | "used" | "expired" | "revoked" | "not_found";
  consentReceiptId: string;
  experienceId?: string;
  policy?: ConsentPolicy;
  expiresAt?: string;
}

interface PersistedRuntimeState {
  consents: StoredConsent[];
  sessions: ExperienceSession[];
}

export class ExperienceRuntime {
  private readonly consents = new Map<string, StoredConsent>();
  private readonly sessions = new Map<string, ExperienceSession>();
  private readonly allowedCapabilities?: Set<string>;
  private store?: DocumentStore;
  private auditRecords: AuditRecord[] = [];
  private baseUrl = "http://127.0.0.1:4317";

  constructor(private readonly registry: ModuleRegistry, options: RuntimeOptions = {}) {
    this.allowedCapabilities = options.allowedCapabilities ? new Set(options.allowedCapabilities) : undefined;
  }

  attachStore(store: DocumentStore): void {
    this.store = store;
  }

  async initialize(): Promise<void> {
    if (!this.store) return;
    const state = await this.store.load<PersistedRuntimeState>("runtime-v1");
    this.consents.clear();
    this.sessions.clear();
    for (const consent of state?.consents ?? []) this.consents.set(consent.tokenHash, consent);
    for (const session of state?.sessions ?? []) this.sessions.set(session.id, session);
    this.auditRecords = await this.store.listAudit(5000);
  }

  setBaseUrl(baseUrl: string): void {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  prepareLaunch(experienceId: string, contextInput?: unknown, requestedScopes: string[] = []): PrepareLaunchResult {
    const experience = this.registry.get(experienceId)?.manifest;
    if (!experience) return { status: "not_found", experienceId, message: "找不到这个体验模块。" };

    if (this.allowedCapabilities) {
      const allowedCapabilities = this.allowedCapabilities;
      const blocked = experience.capabilities.filter((capability) => !allowedCapabilities.has(capability));
      if (blocked.length > 0) {
        return {
          status: "invalid_capability",
          experienceId,
          message: `当前宿主策略不允许模块能力：${blocked.join("、")}。`,
        };
      }
    }

    let contextEnvelope: ContextEnvelope | undefined;
    if (contextInput !== undefined) {
      const parsed = contextEnvelopeSchema.safeParse(contextInput);
      if (!parsed.success || (parsed.data.expires_at && Date.parse(parsed.data.expires_at) <= Date.now())) {
        return { status: "invalid_context", experienceId, message: "Context Envelope 格式无效或已过期。" };
      }
      contextEnvelope = parsed.data;
    }

    let policy: ConsentPolicy;
    try {
      policy = buildConsentPolicy(experience, requestedScopes);
    } catch (error) {
      return { status: "invalid_scope", experienceId, message: error instanceof Error ? error.message : "授权范围无效。" };
    }

    this.prune();
    const now = Date.now();
    const expiresAt = now + CONSENT_TTL_MS;
    const token = randomBytes(24).toString("base64url");
    const tokenHash = hashToken(token);
    const receiptId = `consent-${randomUUID().slice(0, 8)}`;
    this.consents.set(tokenHash, {
      tokenHash: hashToken(token),
      experienceId,
      expiresAt,
      used: false,
      policy,
      contextEnvelope,
      receiptId,
      revoked: false,
    });
    this.recordAudit("consent.prepared", "consent", receiptId, undefined, {
      experience_id: experienceId,
      scopes: [...policy.allowed_reads, ...policy.allowed_writes],
      context_fields: Object.keys(contextEnvelope?.fields ?? {}),
    });
    this.persistSoon();

    return {
      status: "consent_required",
      experienceId,
      consentReceiptId: receiptId,
      title: experience.name,
      message: `启动“${experience.name}”前，请确认允许它读取：${policy.allowed_reads.join("、") || "无额外数据"}；写入：${policy.allowed_writes.join("、") || "无"}。授权将在 5 分钟后失效，且只能使用一次。`,
      scopes: [...policy.allowed_reads, ...policy.allowed_writes],
      consentToken: token,
      expiresAt: new Date(expiresAt).toISOString(),
      policy,
      contextFields: Object.entries(contextEnvelope?.fields ?? {})
        .filter(([, value]) => value !== undefined)
        .map(([key]) => key),
    };
  }

  async launch(experienceId: string, consentToken: string): Promise<LaunchResult> {
    const module = this.registry.get(experienceId);
    if (!module) {
      return {
        status: "not_found",
        experienceId,
        title: "未找到体验模块",
        message: `目录中没有 id 为“${experienceId}”的模块。`,
      };
    }

    const consent = this.consents.get(hashToken(consentToken));
    const valid = consent &&
      !consent.used &&
      !consent.revoked &&
      consent.experienceId === experienceId &&
      consent.expiresAt > Date.now() &&
      consent.tokenHash === hashToken(consentToken);

    if (!valid) {
      return {
        status: "invalid_consent",
        experienceId,
        title: module.manifest.name,
        message: "授权令牌无效、已过期、已使用，或与当前模块不匹配。请重新请求授权。",
      };
    }

    consent.used = true;
    const session = await this.createSession(module, consent.contextEnvelope, consent.policy);
    this.recordAudit("consent.used", "consent", consent.receiptId, undefined, {
      experience_id: experienceId,
      session_id: session.id,
    });
    this.persistSoon();
    return {
      status: "launched",
      experienceId,
      title: module.manifest.name,
      surface: module.manifest.ui,
      message: `已启动“${module.manifest.name}”。体验会话将在 10 分钟后失效。`,
      sessionId: session.id,
      entrypoint: `${this.baseUrl}/experiences/${experienceId}?session_id=${encodeURIComponent(session.id)}`,
      expiresAt: session.expiresAt,
      nextPrompt: module.manifest.starterPrompt,
      demoData: { mode: "session", state: session.state },
      consentReceiptId: consent.receiptId,
      consentPolicy: consent.policy,
    };
  }

  getSnapshot(sessionId: string): SessionSnapshot | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    this.expireIfNeeded(session);
    const experience = this.registry.get(session.experienceId)?.manifest;
    return {
      id: session.id,
      experienceId: session.experienceId,
      title: experience?.name ?? session.experienceId,
      status: session.status,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      state: { ...session.state },
      eventCount: session.events.length,
      entrypoint: `${this.baseUrl}/experiences/${session.experienceId}?session_id=${encodeURIComponent(session.id)}`,
    };
  }

  async submitEvent(
    sessionId: string,
    type: SessionEvent["type"],
    payload: Record<string, unknown> = {},
  ): Promise<SessionActionResult> {
    const session = this.sessions.get(sessionId);
    if (!session) return { status: "invalid", message: "找不到这个体验会话。" };
    this.expireIfNeeded(session);
    if (session.status === "expired") return { status: "expired", message: "这个体验会话已过期，请重新启动。" };
    if (session.status !== "active") return { status: "finished", message: "这个体验会话已经结束。", snapshot: this.getSnapshot(sessionId) };
    if (session.events.length >= MAX_EVENTS_PER_SESSION) {
      return { status: "invalid", message: "这个体验会话的事件数量已达到上限。" };
    }

    const module = this.registry.get(session.experienceId);
    if (!module) return { status: "invalid", message: "体验模块已从本地注册表中移除。" };
    const event: SessionEvent = { type, payload: sanitizePayload(payload), createdAt: new Date().toISOString() };
    session.events.push(event);

    try {
      const result = await module.handleEvent(this.context(session), session.state, event);
      session.state = normalizeState(result.state);
      if (result.status) session.status = result.status;
      this.recordAudit("session.event", "session", session.id, undefined, { event_type: type });
      this.persistSoon();
      return {
        status: "ok",
        message: result.message ?? session.state.feedback ?? "状态已更新。",
        snapshot: this.getSnapshot(sessionId),
      };
    } catch {
      return { status: "invalid", message: "体验模块处理事件时发生错误，请结束当前会话后重试。", snapshot: this.getSnapshot(sessionId) };
    }
  }

  async finish(sessionId: string): Promise<SessionActionResult> {
    return this.submitEvent(sessionId, "finish");
  }

  getConsentStatus(receiptId: string): ConsentStatusResult {
    const consent = this.findConsent(receiptId);
    if (!consent) return { status: "not_found", consentReceiptId: receiptId };
    const status = consent.revoked
      ? "revoked"
      : consent.used
        ? "used"
        : consent.expiresAt <= Date.now()
          ? "expired"
          : "active";
    return {
      status,
      consentReceiptId: consent.receiptId,
      experienceId: consent.experienceId,
      policy: consent.policy,
      expiresAt: new Date(consent.expiresAt).toISOString(),
    };
  }

  revokeConsent(receiptId: string): ConsentStatusResult {
    const consent = this.findConsent(receiptId);
    if (!consent) return { status: "not_found", consentReceiptId: receiptId };
    if (!consent.used && consent.expiresAt > Date.now()) {
      consent.revoked = true;
      this.recordAudit("consent.revoked", "consent", receiptId);
      this.persistSoon();
    }
    return this.getConsentStatus(receiptId);
  }

  getAuditLog(limit = 100): AuditRecord[] {
    return this.auditRecords
      .slice(-Math.min(Math.max(limit, 1), 500))
      .reverse()
      .map((record) => ({ ...record, metadata: { ...record.metadata } }));
  }

  async getAuditLogAsync(limit = 100): Promise<AuditRecord[]> {
    if (this.store) return this.store.listAudit(limit);
    return this.getAuditLog(limit);
  }

  private async createSession(
    module: ExperienceModule,
    contextEnvelope: ContextEnvelope | undefined,
    consentPolicy: ConsentPolicy,
  ): Promise<ExperienceSession> {
    const now = Date.now();
    const id = `session-${randomUUID().slice(0, 8)}`;
    const context: ExperienceContext = {
      sessionId: id,
      experienceId: module.manifest.id,
      approvedContext: scopeContext(contextEnvelope, consentPolicy),
      consentPolicy,
      now: new Date(now).toISOString(),
    };
    const state = normalizeState(await module.start(context));
    const session: ExperienceSession = {
      id,
      experienceId: module.manifest.id,
      status: "active",
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
      state,
      events: [],
      contextEnvelope,
      consentPolicy,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  private context(session: ExperienceSession): ExperienceContext {
    return {
      sessionId: session.id,
      experienceId: session.experienceId,
      approvedContext: scopeContext(session.contextEnvelope, session.consentPolicy),
      consentPolicy: session.consentPolicy,
      now: new Date().toISOString(),
    };
  }

  private expireIfNeeded(session: ExperienceSession): void {
    if (session.status === "active" && Date.parse(session.expiresAt) <= Date.now()) {
      session.status = "expired";
      session.state.feedback = "这个体验会话已过期。";
    }
  }

  private prune(): void {
    const now = Date.now();
    for (const [tokenHash, consent] of this.consents) {
      if (consent.expiresAt + SESSION_TTL_MS <= now) this.consents.delete(tokenHash);
    }
    for (const [id, session] of this.sessions) {
      this.expireIfNeeded(session);
      if (session.status === "expired" && Date.parse(session.expiresAt) + SESSION_TTL_MS <= now) this.sessions.delete(id);
    }
  }

  private findConsent(receiptId: string): StoredConsent | undefined {
    for (const consent of this.consents.values()) {
      if (consent.receiptId === receiptId) return consent;
    }
    return undefined;
  }

  private recordAudit(
    action: string,
    resourceType: string,
    resourceId?: string,
    actorId?: string,
    metadata: Record<string, unknown> = {},
  ): void {
    const record = createAuditRecord(action, resourceType, resourceId, actorId, metadata);
    this.auditRecords.push(record);
    this.auditRecords = this.auditRecords.slice(-5000);
    if (this.store) void this.store.appendAudit(record);
  }

  private persistSoon(): void {
    if (!this.store) return;
    void this.store.save("runtime-v1", {
      consents: [...this.consents.values()],
      sessions: [...this.sessions.values()],
    } satisfies PersistedRuntimeState);
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function normalizeState(state: SessionState): SessionState {
  return {
    ...state,
    round: typeof state.round === "number" ? state.round : 1,
    score: typeof state.score === "number" ? state.score : 0,
    hintUsed: state.hintUsed === true,
  };
}

function sanitizePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload).slice(0, 10)) {
    if (typeof value === "string") safe[key] = value.slice(0, 2000);
    else if (typeof value === "number" || typeof value === "boolean" || value === null) safe[key] = value;
  }
  return safe;
}
