import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExperienceRuntime } from "../dist/runtime.js";
import { defaultModulesDirectory, loadDefaultModuleRegistry, ModuleRegistry } from "../dist/registry.js";
import { PublicTopicService } from "../dist/public-topics.js";
import { createPersistentStore } from "../dist/persistence.js";
import { createJsonHostAdapter } from "../dist/host-protocol.js";
import { startExperienceWebServer } from "../dist/web.js";

test("runtime state and audit records survive a restart", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "experience-alpha-state-"));
  try {
    const store = await createPersistentStore(join(temporaryRoot, "state.db"));
    const registry = await loadDefaultModuleRegistry();
    const first = new ExperienceRuntime(registry);
    first.attachStore(store);
    await first.initialize();
    const request = first.prepareLaunch("three-minute-mystery");
    assert.equal(request.status, "consent_required");
    const launch = await first.launch(request.experienceId, request.consentToken);
    assert.equal(launch.status, "launched");
    await waitForPersistence();

    const second = new ExperienceRuntime(await loadDefaultModuleRegistry());
    second.attachStore(await createPersistentStore(join(temporaryRoot, "state.db")));
    await second.initialize();
    assert.equal(second.getConsentStatus(request.consentReceiptId).status, "used");
    assert.equal(second.getSnapshot(launch.sessionId).status, "active");
    assert.ok(second.getAuditLog(10).some((record) => record.action === "consent.prepared"));
    await store.close();
    await second.store?.close?.();
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("public topics and moderation state survive a restart", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "experience-alpha-topics-"));
  try {
    const store = await createPersistentStore(join(temporaryRoot, "state.db"));
    const first = new PublicTopicService();
    first.attachStore(store);
    await first.initialize();
    const topic = first.createTopic({ actorId: "alice", title: "持久化公开话题", body: "重启后仍然可见。", tags: ["alpha"] });
    const room = first.joinRoom(topic.id, "bob");
    first.postMessage(room.id, "bob", "公开发言仍然存在。");
    await waitForPersistence();

    const second = new PublicTopicService();
    second.attachStore(await createPersistentStore(join(temporaryRoot, "state.db")));
    await second.initialize();
    const restored = second.discover({ actorId: "carol", query: "持久化" });
    assert.equal(restored[0].id, topic.id);
    assert.equal(second.getRoom(room.id, "carol").messages.length, 1);
    await store.close();
    await second.store?.close?.();
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("capability policy blocks modules outside the host allowlist", async () => {
  const registry = await loadDefaultModuleRegistry();
  const runtime = new ExperienceRuntime(registry, { allowedCapabilities: ["text_game", "session_scoring", "adaptive_difficulty"] });
  const result = runtime.prepareLaunch("social-pulse");
  assert.equal(result.status, "invalid_capability");
  assert.match(result.message, /topic_recommendation/);
});

test("isolated module registry runs module lifecycle outside the host process", async () => {
  const registry = new ModuleRegistry({ isolateModules: true });
  await registry.loadFromDirectory(defaultModulesDirectory());
  try {
    const runtime = new ExperienceRuntime(registry);
    const request = runtime.prepareLaunch("three-minute-mystery");
    const launch = await runtime.launch(request.experienceId, request.consentToken);
    assert.equal(launch.status, "launched");
    const hint = await runtime.submitEvent(launch.sessionId, "hint");
    assert.equal(hint.status, "ok");
    assert.equal(hint.snapshot.state.hintUsed, true);
  } finally {
    registry.close();
  }
});

test("generic host adapter exposes a stable JSON protocol", async () => {
  const registry = await loadDefaultModuleRegistry();
  const runtime = new ExperienceRuntime(registry);
  const adapter = createJsonHostAdapter(registry, runtime);
  const discovered = await adapter.handle({
    protocol: "experience-host/v1",
    request_id: "req-1",
    action: "discover_experiences",
    payload: { intent: "我很无聊", max_results: 2 },
  });
  assert.equal(discovered.ok, true);
  assert.equal(discovered.protocol, "experience-host/v1");
  assert.equal(discovered.request_id, "req-1");
  assert.equal(discovered.result.recommendations.length, 2);

  const mismatch = await adapter.handle({ protocol: "wrong/v1", request_id: "req-2", action: "discover_experiences", payload: {} });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.error.code, "protocol_mismatch");
});

test("generic host protocol is available through the HTTP adapter", async () => {
  const registry = await loadDefaultModuleRegistry();
  const runtime = new ExperienceRuntime(registry);
  const web = await startExperienceWebServer(runtime, 0, new PublicTopicService(), registry);
  try {
    const response = await fetch(`${web.baseUrl}/api/host`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        protocol: "experience-host/v1",
        request_id: "http-1",
        action: "discover_experiences",
        payload: { intent: "我很无聊" },
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.request_id, "http-1");
  } finally {
    await new Promise((resolve) => web.server.close(resolve));
  }
});

function waitForPersistence() {
  return new Promise((resolve) => setTimeout(resolve, 80));
}
