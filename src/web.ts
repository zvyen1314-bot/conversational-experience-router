import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createJsonHostAdapter, type ExperienceHostAdapter } from "./host-protocol.js";
import { ModuleRegistry } from "./registry.js";
import { PublicTopicService, type ModerationReportStatus } from "./public-topics.js";
import type { SessionSnapshot } from "./types.js";
import { ExperienceRuntime } from "./runtime.js";

export interface ExperienceWebServer {
  server: Server;
  baseUrl: string;
}

export async function startExperienceWebServer(
  runtime: ExperienceRuntime,
  requestedPort: number,
  topics = new PublicTopicService(),
  registry?: ModuleRegistry,
): Promise<ExperienceWebServer> {
  const hostAdapter = registry ? createJsonHostAdapter(registry, runtime) : undefined;
  const server = createServer((request, response) => {
    void handleRequest(request, response, runtime, topics, hostAdapter);
  });
  const port = await listen(server, requestedPort);
  const baseUrl = `http://127.0.0.1:${port}`;
  runtime.setBaseUrl(baseUrl);
  return { server, baseUrl };
}

async function listen(server: Server, requestedPort: number): Promise<number> {
  try {
    return await listenOn(server, requestedPort);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || requestedPort === 0) throw error;
    return listenOn(server, 0);
  }
}

function listenOn(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  runtime: ExperienceRuntime,
  topics: PublicTopicService,
  hostAdapter?: ExperienceHostAdapter,
): Promise<void> {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;

    if (request.method === "GET" && path === "/health") {
      sendJson(response, 200, { ok: true, service: "experience-runtime" });
      return;
    }

    if (request.method === "POST" && path === "/api/host") {
      if (!hostAdapter) {
        sendJson(response, 503, { error: "host_adapter_unavailable" });
        return;
      }
      sendJson(response, 200, await hostAdapter.handle(await readJson(request)));
      return;
    }

    if (path.startsWith("/api/sessions/")) {
      await handleSessionApi(request, response, runtime, url);
      return;
    }

    if (path === "/api/topics" || path.startsWith("/api/topics/") || path.startsWith("/api/rooms/") || path.startsWith("/api/moderation/")) {
      await handleTopicApi(request, response, topics, url);
      return;
    }

    if (request.method === "GET" && path.startsWith("/experiences/")) {
      const experienceId = decodeURIComponent(path.slice("/experiences/".length));
      const sessionId = url.searchParams.get("session_id");
      if (!sessionId) {
        sendHtml(response, 400, "<h1>缺少 session_id</h1><p>请从 Claude 返回的体验入口打开页面。</p>");
        return;
      }
      const snapshot = runtime.getSnapshot(sessionId);
      if (!snapshot || snapshot.experienceId !== experienceId) {
        sendHtml(response, 404, "<h1>体验会话不存在</h1><p>请重新从 Claude 启动体验。</p>");
        return;
      }
      sendHtml(response, 200, renderExperiencePage(snapshot));
      return;
    }

    sendJson(response, 404, { error: "not_found" });
  } catch (error) {
    sendJson(response, 500, { error: error instanceof Error ? error.message : "internal_error" });
  }
}

async function handleTopicApi(
  request: IncomingMessage,
  response: ServerResponse,
  topics: PublicTopicService,
  url: URL,
): Promise<void> {
  try {
    const parts = url.pathname.split("/").filter(Boolean);
    if (request.method === "GET" && parts.length === 2 && parts[1] === "topics") {
      sendJson(response, 200, {
        protocol: "public-topics/v1",
        topics: topics.discover({
          actorId: url.searchParams.get("actor_id") ?? "local-user",
          query: url.searchParams.get("query") ?? undefined,
          interests: url.searchParams.getAll("interest"),
          limit: Number.parseInt(url.searchParams.get("limit") ?? "10", 10),
        }),
      });
      return;
    }

    if (request.method === "POST" && parts.length === 2 && parts[1] === "topics") {
      const body = await readJson(request);
      sendJson(response, 201, {
        status: "created",
        topic: topics.createTopic({
          actorId: requireString(body.actor_id, "actor_id"),
          title: requireString(body.title, "title"),
          body: requireString(body.body, "body"),
          tags: stringArray(body.tags),
        }),
      });
      return;
    }

    if (request.method === "POST" && parts.length === 4 && parts[1] === "topics" && parts[3] === "join") {
      const body = await readJson(request);
      sendJson(response, 200, {
        status: "joined",
        room: topics.joinRoom(parts[2], requireString(body.actor_id, "actor_id")),
      });
      return;
    }

    if (request.method === "GET" && parts.length === 2 && parts[1] === "rooms") {
      sendJson(response, 400, { error: "missing_room_id" });
      return;
    }

    if (request.method === "GET" && parts.length === 3 && parts[1] === "rooms") {
      sendJson(response, 200, {
        status: "ok",
        room: topics.getRoom(parts[2], url.searchParams.get("actor_id") ?? "local-user"),
      });
      return;
    }

    if (request.method === "POST" && parts.length === 4 && parts[1] === "rooms" && parts[3] === "messages") {
      const body = await readJson(request);
      sendJson(response, 201, {
        status: "posted",
        room: topics.postMessage(parts[2], requireString(body.actor_id, "actor_id"), requireString(body.body, "body")),
      });
      return;
    }

    if (request.method === "GET" && parts.length === 3 && parts[1] === "moderation" && parts[2] === "reports") {
      const status = url.searchParams.get("status");
      const allowedStatuses: ModerationReportStatus[] = ["queued", "dismissed", "hidden", "restored"];
      if (status && !allowedStatuses.includes(status as ModerationReportStatus)) {
        sendJson(response, 400, { error: "unsupported_report_status" });
        return;
      }
      sendJson(response, 200, { reports: topics.listReports(status as ModerationReportStatus | undefined) });
      return;
    }

    if (request.method === "POST" && parts.length === 3 && parts[1] === "moderation" && parts[2] === "reports") {
      const body = await readJson(request);
      sendJson(response, 201, {
        status: "queued",
        report: topics.report({
          reporterId: requireString(body.reporter_id, "reporter_id"),
          targetType: body.target_type === "message" ? "message" : "topic",
          targetId: requireString(body.target_id, "target_id"),
          reason: requireString(body.reason, "reason"),
        }),
      });
      return;
    }

    if (request.method === "POST" && parts.length === 5 && parts[1] === "moderation" && parts[2] === "reports" && parts[4] === "review") {
      const body = await readJson(request);
      const decision = body.decision;
      if (decision !== "dismiss" && decision !== "hide" && decision !== "restore") {
        sendJson(response, 400, { error: "unsupported_review_decision" });
        return;
      }
      sendJson(response, 200, {
        status: "reviewed",
        report: topics.reviewReport(parts[3], requireString(body.reviewer_id, "reviewer_id"), decision),
      });
      return;
    }

    if (request.method === "POST" && parts.length === 3 && parts[1] === "moderation" && parts[2] === "blocks") {
      const body = await readJson(request);
      sendJson(response, 200, topics.blockActor(requireString(body.actor_id, "actor_id"), requireString(body.blocked_actor_id, "blocked_actor_id")));
      return;
    }

    if (request.method === "DELETE" && parts.length === 3 && parts[1] === "moderation" && parts[2] === "blocks") {
      const actorId = url.searchParams.get("actor_id");
      const blockedActorId = url.searchParams.get("blocked_actor_id");
      if (!actorId || !blockedActorId) {
        sendJson(response, 400, { error: "missing_actor_id" });
        return;
      }
      sendJson(response, 200, topics.unblockActor(actorId, blockedActorId));
      return;
    }

    sendJson(response, 404, { error: "not_found" });
  } catch (error) {
    sendJson(response, 400, { error: error instanceof Error ? error.message : "invalid_request" });
  }
}

async function handleSessionApi(
  request: IncomingMessage,
  response: ServerResponse,
  runtime: ExperienceRuntime,
  url: URL,
): Promise<void> {
  const parts = url.pathname.split("/").filter(Boolean);
  const sessionId = parts[2];
  if (!sessionId) {
    sendJson(response, 400, { error: "missing_session_id" });
    return;
  }

  if (request.method === "GET" && parts.length === 3) {
    const snapshot = runtime.getSnapshot(sessionId);
    if (!snapshot) sendJson(response, 404, { error: "session_not_found" });
    else sendJson(response, 200, snapshot);
    return;
  }

  if (request.method === "POST" && parts.length === 4 && parts[3] === "events") {
    const body = await readJson(request);
    const type = body.type;
    if (type !== "answer" && type !== "hint" && type !== "restart" && type !== "finish") {
      sendJson(response, 400, { error: "unsupported_event_type" });
      return;
    }
    const result = await runtime.submitEvent(sessionId, type, isRecord(body.payload) ? body.payload : {});
    sendJson(response, result.status === "invalid" ? 400 : 200, result);
    return;
  }

  if (request.method === "POST" && parts.length === 4 && parts[3] === "finish") {
    sendJson(response, 200, await runtime.finish(sessionId));
    return;
  }

  sendJson(response, 404, { error: "not_found" });
}

function renderExperiencePage(snapshot: SessionSnapshot): string {
  if (snapshot.experienceId !== "three-minute-mystery") {
    return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${escapeHtml(snapshot.title)}</title><body><main><h1>${escapeHtml(snapshot.title)}</h1><p>这个体验已经启动，会话状态：${escapeHtml(snapshot.status)}。</p></main></body></html>`;
  }

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Three Minute Mystery</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #f4f6f8; color: #17212b; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: #f4f6f8; }
    main { width: min(680px, calc(100% - 32px)); margin: 0 auto; padding: 48px 0; }
    header { display: flex; justify-content: space-between; align-items: start; gap: 24px; margin-bottom: 24px; }
    h1 { margin: 0 0 8px; font-size: clamp(26px, 5vw, 38px); letter-spacing: 0; }
    .eyebrow { margin: 0 0 8px; color: #53707d; font-size: 13px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    .timer { min-width: 82px; padding: 10px 12px; border: 1px solid #c9d3d8; border-radius: 6px; background: #fff; text-align: center; font-variant-numeric: tabular-nums; }
    .panel { border: 1px solid #c9d3d8; border-radius: 8px; background: #fff; padding: 24px; box-shadow: 0 8px 24px rgba(28, 49, 61, .06); }
    .puzzle { margin: 0 0 24px; font-size: 20px; line-height: 1.6; }
    label { display: block; margin-bottom: 8px; color: #53707d; font-size: 14px; font-weight: 700; }
    textarea { display: block; width: 100%; min-height: 120px; resize: vertical; padding: 12px; border: 1px solid #aebdc4; border-radius: 6px; color: #17212b; font: inherit; line-height: 1.5; }
    textarea:focus { outline: 3px solid #c6e5ec; border-color: #147d8d; }
    .actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 16px; }
    button { min-height: 42px; padding: 0 16px; border: 1px solid #176b78; border-radius: 6px; background: #176b78; color: #fff; font: inherit; font-weight: 700; cursor: pointer; }
    button.secondary { border-color: #aebdc4; background: #fff; color: #24404a; }
    button:disabled { cursor: not-allowed; opacity: .45; }
    .meta { display: flex; gap: 16px; margin-top: 18px; color: #53707d; font-size: 14px; }
    .feedback { min-height: 28px; margin: 20px 0 0; color: #176b78; line-height: 1.5; }
    .hint { margin-top: 12px; padding: 12px; border-left: 3px solid #e5a72b; background: #fff8e8; color: #6d5015; line-height: 1.5; }
    .complete { border-color: #6a9f7a; background: #f2faf4; }
    .muted { color: #53707d; }
    @media (max-width: 520px) { main { padding: 28px 0; } header { display: block; } .timer { margin-top: 16px; width: fit-content; } .panel { padding: 18px; } }
  </style>
</head>
<body>
  <main>
    <header>
      <div><p class="eyebrow">Three Minute Mystery</p><h1>灯与开关</h1><p class="muted">用几分钟破解一个经典小谜题。</p></div>
      <div class="timer" aria-label="剩余时间"><span id="timer">10:00</span></div>
    </header>
    <section class="panel" id="panel">
      <p class="puzzle" id="puzzle"></p>
      <label for="answer">你的方案</label>
      <textarea id="answer" placeholder="写下你会怎么做……"></textarea>
      <div class="actions">
        <button id="submit">提交答案</button>
        <button class="secondary" id="hint">获取提示</button>
        <button class="secondary" id="finish">结束体验</button>
      </div>
      <p class="feedback" id="feedback" role="status"></p>
      <div class="hint" id="hintBox" hidden></div>
      <div class="meta"><span>得分：<strong id="score">0</strong></span><span>状态：<strong id="status">进行中</strong></span></div>
    </section>
  </main>
  <script>
    const sessionId = ${JSON.stringify(snapshot.id)};
    let current;
    const $ = (id) => document.getElementById(id);
    async function request(path, options) {
      const response = await fetch(path, options);
      const body = await response.json();
      if (!response.ok) throw new Error(body.message || body.error || '请求失败');
      return body;
    }
    function render() {
      if (!current) return;
      $('puzzle').textContent = current.state.puzzle || '体验已准备好。';
      $('score').textContent = String(current.state.score || 0);
      $('status').textContent = current.status === 'active' ? '进行中' : current.status === 'completed' ? '已完成' : '已结束';
      $('feedback').textContent = current.state.feedback || '把你的第一步写下来。';
      $('hintBox').textContent = current.state.hint || '';
      $('hintBox').hidden = !current.state.hint;
      const disabled = current.status !== 'active';
      $('answer').disabled = disabled;
      $('submit').disabled = disabled;
      $('hint').disabled = disabled || Boolean(current.state.hint);
      $('panel').classList.toggle('complete', current.status === 'completed');
    }
    function renderTimer() {
      if (!current) return;
      const remaining = Math.max(0, Math.ceil((Date.parse(current.expiresAt) - Date.now()) / 1000));
      $('timer').textContent = Math.floor(remaining / 60) + ':' + String(remaining % 60).padStart(2, '0');
    }
    async function refresh() {
      try { current = await request('/api/sessions/' + encodeURIComponent(sessionId)); render(); renderTimer(); }
      catch (error) { $('feedback').textContent = error.message; }
    }
    async function submit(type, payload) {
      try {
        const result = await request('/api/sessions/' + encodeURIComponent(sessionId) + '/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type, payload }) });
        current = result.snapshot || current; render(); renderTimer();
        if (type === 'answer' && current.status === 'completed') $('answer').value = '';
      } catch (error) { $('feedback').textContent = error.message; }
    }
    $('submit').addEventListener('click', () => submit('answer', { answer: $('answer').value }));
    $('hint').addEventListener('click', () => submit('hint'));
    $('finish').addEventListener('click', () => submit('finish'));
    refresh();
    setInterval(renderTimer, 1000);
  </script>
</body>
</html>`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value;
}

function stringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error("tags must be an array of strings");
  return value;
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) throw new Error("request_too_large");
    chunks.push(buffer);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  return isRecord(parsed) ? parsed : {};
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function sendHtml(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(body);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}
