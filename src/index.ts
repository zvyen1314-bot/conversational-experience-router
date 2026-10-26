import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { listRecommendations } from "./catalog.js";
import { PublicTopicService } from "./public-topics.js";
import { createPersistentStore } from "./persistence.js";
import { ExperienceRuntime } from "./runtime.js";
import { loadTrustedKeysFromEnvironment, ModuleRegistry, defaultModulesDirectory } from "./registry.js";
import { createContextEnvelope } from "./protocol.js";
import { startExperienceWebServer } from "./web.js";

const server = new McpServer({
  name: "conversational-experience-router",
  version: "1.0.0-alpha.1",
});
const registry = new ModuleRegistry({ isolateModules: process.env.EXPERIENCE_ISOLATE_MODULES !== "0" });
const runtime = new ExperienceRuntime(registry, { allowedCapabilities: parseAllowedCapabilities() });
const topics = new PublicTopicService();

function jsonText(value: unknown): { content: [{ type: "text"; text: string }] } {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

server.registerTool(
  "discover_experiences",
  {
    title: "Discover experiences",
    description:
      "根据用户当前明确表达的意图，推荐可立即开始的体验模块。宿主应先准备授权并获得用户同意，再启动体验。",
    inputSchema: {
      intent: z.string().min(1).describe("用户当前表达的需求或心情"),
      known_interests: z
        .array(z.string())
        .max(12)
        .optional()
        .describe("用户已经明确同意传给插件的兴趣线索"),
      max_results: z.number().int().min(1).max(5).optional().default(3),
    },
  },
  async ({ intent, known_interests, max_results }) => {
    const details = new Map(registry.listDetailed().map((entry) => [entry.manifest.id, entry]));
    return jsonText({
      kind: "experience_recommendations",
      privacy: "仅使用本次调用中传入的意图和用户已同意的兴趣线索。",
      recommendations: listRecommendations(registry.list(), intent, known_interests ?? [], max_results).map((recommendation) => ({
        ...recommendation,
        registry: details.get(recommendation.experience.id)
          ? {
              signature_status: details.get(recommendation.experience.id)?.signature_status,
              versions: details.get(recommendation.experience.id)?.versions,
            }
          : undefined,
      })),
      next_step: "向用户展示推荐并询问是否启动其中一个模块。",
    });
  },
);

server.registerTool(
  "list_public_modules",
  {
    title: "List public experience modules",
    description: "展示本地注册表中的公开体验模块，包括版本、权限、风险、发布者和签名状态。",
    inputSchema: {
      category: z.enum(["social", "game", "reflection"]).optional(),
      require_trusted_signature: z.boolean().optional().default(false),
      max_results: z.number().int().min(1).max(50).optional().default(20),
    },
  },
  async ({ category, require_trusted_signature, max_results }) => {
    const entries = registry.listDetailed()
      .filter((entry) => !category || entry.manifest.category === category)
      .filter((entry) => !require_trusted_signature || entry.signature_status === "trusted")
      .slice(0, max_results)
      .map((entry) => ({
        id: entry.manifest.id,
        version: entry.manifest.version,
        name: entry.manifest.name,
        tagline: entry.manifest.tagline,
        description: entry.manifest.description,
        category: entry.manifest.category,
        capabilities: entry.manifest.capabilities,
        risk_level: entry.manifest.riskLevel,
        ui: entry.manifest.ui,
        memory: entry.manifest.memory,
        publisher: entry.manifest.publisher,
        signature_status: entry.signature_status,
        versions: entry.versions,
      }));
    return jsonText({ protocol: "experience-registry/v1", entries });
  },
);

server.registerTool(
  "discover_public_topics",
  {
    title: "Discover public topics",
    description: "根据用户明确提供的兴趣发现公开话题；结果不包含私密匹配或自动私信。",
    inputSchema: {
      actor_id: z.string().min(1).max(120).optional().default("local-user"),
      query: z.string().max(200).optional(),
      interests: z.array(z.string().min(1).max(100)).max(20).optional(),
      max_results: z.number().int().min(1).max(50).optional().default(10),
    },
  },
  async ({ actor_id, query, interests, max_results }) => jsonText({
    kind: "public_topics",
    privacy: "仅返回公开话题；当前服务不提供自动私信或真人匹配。",
    topics: topics.discover({ actorId: actor_id, query, interests, limit: max_results }),
  }),
);

server.registerTool(
  "create_public_topic",
  {
    title: "Create a public topic",
    description: "创建一个公开话题。发布前应向用户展示公开可见范围和内容审核规则。",
    inputSchema: {
      actor_id: z.string().min(1).max(120),
      title: z.string().min(3).max(120),
      body: z.string().min(1).max(2000),
      tags: z.array(z.string().min(1).max(40)).max(8).optional(),
    },
  },
  async ({ actor_id, title, body, tags }) => jsonText({ status: "created", topic: topics.createTopic({ actorId: actor_id, title, body, tags }) }),
);

server.registerTool(
  "join_public_room",
  {
    title: "Join a public discussion room",
    description: "按需加入某个公开话题的讨论房间；房间只支持公开发言，不开启私信。",
    inputSchema: {
      actor_id: z.string().min(1).max(120),
      topic_id: z.string().min(1),
    },
  },
  async ({ actor_id, topic_id }) => jsonText({ status: "joined", room: topics.joinRoom(topic_id, actor_id) }),
);

server.registerTool(
  "get_public_room",
  {
    title: "Read a public discussion room",
    description: "读取一个公开讨论房间及当前可见消息。被拉黑的参与者内容不会返回。",
    inputSchema: {
      actor_id: z.string().min(1).max(120),
      room_id: z.string().min(1),
    },
  },
  async ({ actor_id, room_id }) => jsonText({ status: "ok", room: topics.getRoom(room_id, actor_id) }),
);

server.registerTool(
  "post_public_message",
  {
    title: "Post in a public discussion room",
    description: "在公开讨论房间发言。内容会进入公开审核队列，当前不提供私信。",
    inputSchema: {
      actor_id: z.string().min(1).max(120),
      room_id: z.string().min(1),
      body: z.string().min(1).max(2000),
    },
  },
  async ({ actor_id, room_id, body }) => jsonText({ status: "posted", room: topics.postMessage(room_id, actor_id, body) }),
);

server.registerTool(
  "report_public_content",
  {
    title: "Report public content",
    description: "举报公开话题或公开消息；举报进入审核队列，不会自动将内容判定为违规。",
    inputSchema: {
      reporter_id: z.string().min(1).max(120),
      target_type: z.enum(["topic", "message"]),
      target_id: z.string().min(1),
      reason: z.string().min(3).max(500),
    },
  },
  async ({ reporter_id, target_type, target_id, reason }) => jsonText({
    status: "queued",
    report: topics.report({ reporterId: reporter_id, targetType: target_type, targetId: target_id, reason }),
  }),
);

server.registerTool(
  "list_public_reports",
  {
    title: "List public moderation reports",
    description: "读取本地公开内容审核队列，供明确授权的审核者处理。",
    inputSchema: {
      status: z.enum(["queued", "dismissed", "hidden", "restored"]).optional(),
    },
  },
  async ({ status }) => jsonText({ reports: topics.listReports(status) }),
);

server.registerTool(
  "review_public_report",
  {
    title: "Review a public content report",
    description: "由审核者对公开内容举报作出驳回、隐藏或恢复决定。",
    inputSchema: {
      reviewer_id: z.string().min(1).max(120),
      report_id: z.string().min(1),
      decision: z.enum(["dismiss", "hide", "restore"]),
    },
  },
  async ({ reviewer_id, report_id, decision }) => jsonText({
    status: "reviewed",
    report: topics.reviewReport(report_id, reviewer_id, decision),
  }),
);

server.registerTool(
  "block_public_actor",
  {
    title: "Block a public actor",
    description: "隐藏指定参与者在公开话题和房间中的内容，并阻止双方继续互动。",
    inputSchema: {
      actor_id: z.string().min(1).max(120),
      blocked_actor_id: z.string().min(1).max(120),
    },
  },
  async ({ actor_id, blocked_actor_id }) => jsonText(topics.blockActor(actor_id, blocked_actor_id)),
);

server.registerTool(
  "unblock_public_actor",
  {
    title: "Unblock a public actor",
    description: "恢复查看和参与指定公开参与者内容的能力。",
    inputSchema: {
      actor_id: z.string().min(1).max(120),
      blocked_actor_id: z.string().min(1).max(120),
    },
  },
  async ({ actor_id, blocked_actor_id }) => jsonText(topics.unblockActor(actor_id, blocked_actor_id)),
);

server.registerTool(
  "create_context_envelope",
  {
    title: "Create a portable context envelope",
    description:
      "把用户明确选择共享的兴趣、时间和内容片段封装为可迁移的 Context Envelope。它不读取宿主的完整历史记录。",
    inputSchema: {
      intent: z.string().min(1).max(500).optional(),
      interests: z.array(z.string().min(1).max(100)).max(50).optional(),
      available_time_minutes: z.number().int().min(1).max(1440).optional(),
      social_preference: z.enum(["private", "public_topics", "open_to_people"]).optional(),
      selected_excerpts: z.array(z.string().min(1).max(4000)).max(10).optional(),
      game_preferences: z.array(z.string().min(1).max(80)).max(20).optional(),
      locale: z.string().min(2).max(20).optional(),
      expires_in_minutes: z.number().int().min(1).max(10080).optional().default(60),
    },
  },
  async ({ intent, interests, available_time_minutes, social_preference, selected_excerpts, game_preferences, locale, expires_in_minutes }) => {
    return jsonText({
      status: "ok",
      envelope: createContextEnvelope({
        intent,
        interests,
        availableTimeMinutes: available_time_minutes,
        socialPreference: social_preference,
        selectedExcerpts: selected_excerpts,
        gamePreferences: game_preferences,
        locale,
        expiresInMinutes: expires_in_minutes,
      }),
      portability: "context-only; active consent tokens must be reissued by the target host",
    });
  },
);

server.registerTool(
  "prepare_experience_launch",
  {
    title: "Prepare an experience launch",
    description:
      "为用户选择的体验模块生成一次性、限时授权请求。宿主应先向用户展示权限范围，得到明确同意后再调用 launch_experience。",
    inputSchema: {
      experience_id: z.string().min(1).describe("discover_experiences 返回的模块 id"),
      context_envelope: z.record(z.unknown()).optional().describe("用户明确同意共享的 Context Envelope"),
      requested_scopes: z.array(z.string().min(1).max(100)).max(30).optional().describe("从模块声明的权限中选择的最小范围"),
    },
  },
  async ({ experience_id, context_envelope, requested_scopes }) => {
    return jsonText(runtime.prepareLaunch(experience_id, context_envelope, requested_scopes ?? []));
  },
);

server.registerTool(
  "launch_experience",
  {
    title: "Launch an experience",
    description:
      "使用 prepare_experience_launch 返回的一次性授权令牌启动体验，并创建一个有状态的本地会话。",
    inputSchema: {
      experience_id: z.string().min(1).describe("准备授权时使用的模块 id"),
      consent_token: z.string().min(1).describe("用户确认后允许使用的授权令牌"),
    },
  },
  async ({ experience_id, consent_token }) => {
    return jsonText(await runtime.launch(experience_id, consent_token));
  },
);

server.registerTool(
  "continue_experience",
  {
    title: "Continue an experience",
    description: "读取体验会话的当前状态，用于在对话或网页之间继续一次体验。",
    inputSchema: {
      session_id: z.string().min(1).describe("launch_experience 返回的会话 id"),
    },
  },
  async ({ session_id }) => {
    const snapshot = runtime.getSnapshot(session_id);
    return jsonText(snapshot
      ? { status: "ok", snapshot }
      : { status: "not_found", message: "找不到这个体验会话。" });
  },
);

server.registerTool(
  "submit_experience_event",
  {
    title: "Submit an experience event",
    description: "向有状态的体验提交一个受限事件，例如答案、提示请求或重新开始。",
    inputSchema: {
      session_id: z.string().min(1),
      event_type: z.enum(["answer", "hint", "restart", "finish"]),
      payload: z.record(z.unknown()).optional(),
    },
  },
  async ({ session_id, event_type, payload }) => {
    return jsonText(await runtime.submitEvent(session_id, event_type, payload ?? {}));
  },
);

server.registerTool(
  "finish_experience",
  {
    title: "Finish an experience",
    description: "结束一个体验会话并返回最终状态。",
    inputSchema: {
      session_id: z.string().min(1),
    },
  },
  async ({ session_id }) => {
    return jsonText(await runtime.finish(session_id));
  },
);

server.registerTool(
  "get_consent_status",
  {
    title: "Get consent status",
    description: "查询一次体验授权的当前状态、模块和权限范围，不返回 bearer token。",
    inputSchema: {
      consent_receipt_id: z.string().min(1),
    },
  },
  async ({ consent_receipt_id }) => {
    return jsonText(runtime.getConsentStatus(consent_receipt_id));
  },
);

server.registerTool(
  "revoke_consent",
  {
    title: "Revoke consent",
    description: "撤销尚未使用的体验授权。已使用的会话不会被此工具伪装成未使用。",
    inputSchema: {
      consent_receipt_id: z.string().min(1),
    },
  },
  async ({ consent_receipt_id }) => {
    return jsonText(runtime.revokeConsent(consent_receipt_id));
  },
);

server.registerTool(
  "get_audit_log",
  {
    title: "Get local audit log",
    description: "读取授权和体验会话的本地审计记录，不返回 bearer token 或原始对话内容。",
    inputSchema: {
      limit: z.number().int().min(1).max(500).optional().default(100),
    },
  },
  async ({ limit }) => jsonText({ protocol: "experience-audit/v1", records: await runtime.getAuditLogAsync(limit) }),
);

server.registerTool(
  "create_experience_draft",
  {
    title: "Create an experience draft",
    description:
      "用安全的声明式模板生成一个私人体验草稿。草稿只描述能力和边界，不执行用户提供的代码。",
    inputSchema: {
      name: z.string().min(2).max(60).describe("体验名称"),
      purpose: z.string().min(8).max(300).describe("体验要帮助用户完成什么"),
      category: z.enum(["social", "game", "reflection"]).describe("体验类别"),
      interaction_style: z
        .enum(["inline", "web", "native"])
        .describe("体验希望以哪种界面承载"),
      requested_capabilities: z
        .array(z.string().min(1).max(50))
        .max(8)
        .default([])
        .describe("希望使用的能力名称，而不是可执行代码"),
    },
  },
  async ({ name, purpose, category, interaction_style, requested_capabilities }) => {
    const id = `draft-${randomUUID().slice(0, 8)}`;
    const draft = {
      id,
      version: "0.1.0",
      name,
      tagline: purpose,
      description: purpose,
      category,
      triggers: [],
      capabilities: requested_capabilities,
      riskLevel: "low",
      ui: interaction_style,
      memory: { reads: [], writes: [] },
      status: "draft",
      runtime: "controlled-js",
      publisher: { name: "local-draft" },
      safety: {
        execution: "declarative-only",
        review_required_before_sharing: true,
        user_code_execution: false,
      },
      module_template: {
        entry: "module.mjs",
        exports: ["start(context)", "handleEvent(context, state, event)"],
      },
      next_step: "先由用户审阅能力、记忆范围和风险等级，再接入签名模块或沙盒运行时。",
    };
    return jsonText(draft);
  },
);

async function main(): Promise<void> {
  const modulesDirectory = process.env.EXPERIENCE_MODULES_DIR ?? defaultModulesDirectory();
  await loadTrustedKeysFromEnvironment(registry);
  await registry.loadFromDirectory(modulesDirectory);
  const statePath = process.env.EXPERIENCE_STATE_FILE ?? resolve(process.cwd(), "data", "experience-router.db");
  const store = await createPersistentStore(statePath);
  runtime.attachStore(store);
  topics.attachStore(store);
  await runtime.initialize();
  await topics.initialize();
  const requestedPort = Number.parseInt(process.env.EXPERIENCE_PORT ?? "4317", 10);
  const web = await startExperienceWebServer(runtime, Number.isFinite(requestedPort) ? requestedPort : 4317, topics, registry);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const close = () => {
    web.server.close();
    registry.close();
    void store.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});

function parseAllowedCapabilities(): string[] | undefined {
  const value = process.env.EXPERIENCE_ALLOWED_CAPABILITIES;
  if (!value) return undefined;
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
}
