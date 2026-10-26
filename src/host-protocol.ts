import { listRecommendations } from "./catalog.js";
import { ModuleRegistry } from "./registry.js";
import { ExperienceRuntime } from "./runtime.js";

export const HOST_PROTOCOL_VERSION = "experience-host/v1" as const;

export type HostAction =
  | "discover_experiences"
  | "prepare_experience_launch"
  | "launch_experience"
  | "continue_experience"
  | "submit_experience_event"
  | "finish_experience"
  | "get_consent_status"
  | "revoke_consent"
  | "get_audit_log";

export interface HostRequest {
  protocol: typeof HOST_PROTOCOL_VERSION;
  request_id: string;
  action: HostAction;
  payload: Record<string, unknown>;
}

export interface HostResponse {
  protocol: typeof HOST_PROTOCOL_VERSION;
  request_id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

export interface ExperienceHostAdapter {
  readonly host_id: string;
  readonly protocol: typeof HOST_PROTOCOL_VERSION;
  readonly actions: readonly HostAction[];
  handle(input: unknown): Promise<HostResponse>;
}

export function createJsonHostAdapter(registry: ModuleRegistry, runtime: ExperienceRuntime): ExperienceHostAdapter {
  const actions: readonly HostAction[] = [
    "discover_experiences",
    "prepare_experience_launch",
    "launch_experience",
    "continue_experience",
    "submit_experience_event",
    "finish_experience",
    "get_consent_status",
    "revoke_consent",
    "get_audit_log",
  ];

  return {
    host_id: "generic-json-host",
    protocol: HOST_PROTOCOL_VERSION,
    actions,
    async handle(input: unknown): Promise<HostResponse> {
      const request = parseRequest(input);
      if (!request.ok) return request.response;
      try {
        return {
          protocol: HOST_PROTOCOL_VERSION,
          request_id: request.value.request_id,
          ok: true,
          result: await dispatch(request.value, registry, runtime),
        };
      } catch (error) {
        return {
          protocol: HOST_PROTOCOL_VERSION,
          request_id: request.value.request_id,
          ok: false,
          error: {
            code: error instanceof HostRequestError ? error.code : "request_failed",
            message: error instanceof Error ? error.message : "request_failed",
          },
        };
      }
    },
  };
}

async function dispatch(request: HostRequest, registry: ModuleRegistry, runtime: ExperienceRuntime): Promise<unknown> {
  const payload = request.payload;
  switch (request.action) {
    case "discover_experiences":
      return {
        kind: "experience_recommendations",
        recommendations: listRecommendations(
          registry.list(),
          stringValue(payload.intent, "intent"),
          stringArray(payload.known_interests),
          numberValue(payload.max_results, 3),
        ),
      };
    case "prepare_experience_launch":
      return runtime.prepareLaunch(
        stringValue(payload.experience_id, "experience_id"),
        payload.context_envelope,
        stringArray(payload.requested_scopes),
      );
    case "launch_experience":
      return runtime.launch(stringValue(payload.experience_id, "experience_id"), stringValue(payload.consent_token, "consent_token"));
    case "continue_experience": {
      const snapshot = runtime.getSnapshot(stringValue(payload.session_id, "session_id"));
      if (!snapshot) throw new HostRequestError("not_found", "找不到这个体验会话。");
      return { status: "ok", snapshot };
    }
    case "submit_experience_event":
      return runtime.submitEvent(
        stringValue(payload.session_id, "session_id"),
        eventType(payload.event_type),
        recordValue(payload.payload),
      );
    case "finish_experience":
      return runtime.finish(stringValue(payload.session_id, "session_id"));
    case "get_consent_status":
      return runtime.getConsentStatus(stringValue(payload.consent_receipt_id, "consent_receipt_id"));
    case "revoke_consent":
      return runtime.revokeConsent(stringValue(payload.consent_receipt_id, "consent_receipt_id"));
    case "get_audit_log":
      return { protocol: "experience-audit/v1", records: await runtime.getAuditLogAsync(numberValue(payload.limit, 100)) };
  }
}

function parseRequest(input: unknown): { ok: true; value: HostRequest } | { ok: false; response: HostResponse } {
  if (!isRecord(input)) return { ok: false, response: errorResponse("unknown", "invalid_payload", "请求必须是 JSON 对象。") };
  const requestId = typeof input.request_id === "string" ? input.request_id : "unknown";
  if (input.protocol !== HOST_PROTOCOL_VERSION) return { ok: false, response: errorResponse(requestId, "protocol_mismatch", `需要 ${HOST_PROTOCOL_VERSION}。`) };
  if (typeof input.action !== "string" || !isAction(input.action)) return { ok: false, response: errorResponse(requestId, "unsupported_action", "不支持的宿主动作。") };
  if (!isRecord(input.payload)) return { ok: false, response: errorResponse(requestId, "invalid_payload", "payload 必须是 JSON 对象。") };
  return { ok: true, value: { protocol: HOST_PROTOCOL_VERSION, request_id: requestId, action: input.action, payload: input.payload } };
}

function errorResponse(requestId: string, code: string, message: string): HostResponse {
  return { protocol: HOST_PROTOCOL_VERSION, request_id: requestId, ok: false, error: { code, message } };
}

function isAction(value: string): value is HostAction {
  return ["discover_experiences", "prepare_experience_launch", "launch_experience", "continue_experience", "submit_experience_event", "finish_experience", "get_consent_status", "revoke_consent", "get_audit_log"].includes(value);
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new HostRequestError("invalid_payload", `${field} 必须是非空文本。`);
  return value;
}

function stringArray(value: unknown, fallback: string[] = []): string[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new HostRequestError("invalid_payload", "字段必须是文本数组。");
  return value;
}

function numberValue(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new HostRequestError("invalid_payload", "字段必须是数字。");
  return value;
}

function eventType(value: unknown): "answer" | "hint" | "restart" | "finish" {
  if (value === "answer" || value === "hint" || value === "restart" || value === "finish") return value;
  throw new HostRequestError("invalid_payload", "不支持的事件类型。");
}

function recordValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class HostRequestError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}
