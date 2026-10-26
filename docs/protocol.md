# Portable Experience Protocols / 可移植体验协议

> English | [简体中文](#portable-experience-protocols--可移植体验协议-1)

This project has five public protocol surfaces. They are JSON contracts that can be implemented by a Claude adapter, another MCP host, or a future non-MCP host.

## Experience Manifest

Every installed module has `manifest.json`:

```json
{
  "id": "my-module",
  "version": "0.1.0",
  "name": "My Module",
  "tagline": "A short user-facing purpose",
  "description": "What the module does",
  "category": "reflection",
  "triggers": ["help me think"],
  "capabilities": ["reflection"],
  "riskLevel": "low",
  "ui": "inline",
  "memory": {
    "reads": ["selected_excerpts"],
    "writes": ["approved_notes"]
  },
  "status": "ready",
  "runtime": "controlled-js",
  "publisher": { "name": "example" },
  "starterPrompt": "Start with one question."
}
```

The `memory.reads` and `memory.writes` values are capability scope names. A module receives only read scopes granted by its current consent policy.

## Module Signature

The signature is stored beside the manifest as `signature.json`; it is not embedded in the manifest, so signing does not create a self-referential document. The signature covers the canonical manifest digest, the module entry digest, the module id and version, and the publisher key id:

```json
{
  "protocol": "experience-signature/v1",
  "algorithm": "ed25519",
  "key_id": "example-main",
  "public_key": "base64url-encoded-spki-public-key",
  "module_id": "my-module",
  "module_version": "0.1.0",
  "manifest_sha256": "...",
  "entry_sha256": "...",
  "signature": "base64url-encoded-signature",
  "signed_at": "2026-10-17T10:00:00.000Z"
}
```

The registry reports four states: `trusted` means the signature is valid and its public key matches the configured trust map; `signed` means the cryptographic signature is valid but the key is not in that trust map; `unsigned` means no signature file exists; `invalid` means the signature or covered files do not verify. A valid signature without a trust root proves integrity, not publisher identity.

## Experience Registry

`experience-registry/v1` is a generated, shareable index. Its entries expose the fields a host needs before showing a module to a user:

```json
{
  "protocol": "experience-registry/v1",
  "generated_at": "2026-10-17T10:00:00.000Z",
  "entries": [
    {
      "id": "my-module",
      "version": "0.1.0",
      "category": "reflection",
      "capabilities": ["reflection"],
      "risk_level": "low",
      "memory": { "reads": ["selected_excerpts"], "writes": [] },
      "publisher": { "name": "example" },
      "signature_status": "trusted",
      "versions": []
    }
  ]
}
```

The `versions` array retains the published digest and signature status for each observed version. `build-registry-index` merges the previous index when generating a new one; the current reference implementation still stores the index locally and does not provide a remote package server.

## Context Envelope

The portable context object contains user-selected signals, not a host's complete conversation history:

```json
{
  "protocol": "experience-context/v1",
  "issued_at": "2026-10-17T10:00:00.000Z",
  "expires_at": "2026-10-17T11:00:00.000Z",
  "source": "user-selected",
  "fields": {
    "intent": "I'm bored, ten minutes to spare",
    "interests": ["AI product design"],
    "available_time_minutes": 10,
    "social_preference": "public_topics",
    "selected_excerpts": ["a snippet the user explicitly chose"]
  }
}
```

The current schema supports intent, interests, available time, social preference, selected excerpts, game preferences, and locale. New fields should be versioned rather than silently adding arbitrary data.

## Consent Policy

The policy is the portable description of what the user allows for a module:

```json
{
  "protocol": "experience-consent/v1",
  "experience_id": "my-module",
  "allowed_reads": ["selected_excerpts"],
  "allowed_writes": ["approved_notes"],
  "purpose": "Run the \"My Module\" experience",
  "issued_at": "2026-10-17T10:00:00.000Z",
  "expires_at": "2026-10-17T10:05:00.000Z",
  "token_portability": "reissue-only"
}
```

The active bearer token is deliberately not portable. When the user moves to another host, that host may reuse the policy after user review, then issue a new token bound to its own module session.

The runtime exposes `get_consent_status` and `revoke_consent` using the non-secret `consent_receipt_id`. Revocation never returns or reconstructs the bearer token.

## Public Topics

Public topics use `public-topics/v1` semantics. A topic has a public title, body, tags, pseudonymous `author_id`, status, and optional discussion room. A room contains public messages and participant ids. The current service is local and in-memory; `actor_id` is supplied by the host and is not an account or identity proof.

The moderation lifecycle is explicit:

```text
create topic
  -> discover topic
  -> optionally join room
  -> post public message
  -> report topic/message
  -> reviewer dismisses, hides, or restores report
  -> actor may block or unblock another actor
```

The MCP adapter exposes `discover_public_topics`, `create_public_topic`, `join_public_room`, `get_public_room`, `post_public_message`, `report_public_content`, `list_public_reports`, `review_public_report`, `block_public_actor`, and `unblock_public_actor`. The local HTTP adapter mirrors these under `/api/topics`, `/api/rooms`, and `/api/moderation`.

## Host Adapter

`experience-host/v1` is the host-neutral JSON envelope. MCP is one adapter; the reference JSON adapter is available at `POST /api/host` and uses the same action names:

```json
{
  "protocol": "experience-host/v1",
  "request_id": "req-123",
  "action": "discover_experiences",
  "payload": { "intent": "我很无聊", "max_results": 2 }
}
```

Every response preserves `protocol` and `request_id`, and returns either `{ "ok": true, "result": ... }` or `{ "ok": false, "error": { "code", "message" } }`. A host can implement this envelope without depending on the MCP SDK. Bearer tokens remain host and session scoped even when the context and consent policy are portable.

## Durable State and Audit

The service stores runtime state under `EXPERIENCE_STATE_FILE` (default `./data/experience-router.db`). Node.js 22.5+ uses the built-in SQLite backend with WAL; Node.js 20 falls back to an atomic JSON document store. Stored runtime state contains consent metadata and sessions, never the plaintext bearer token. The same store keeps public topics, rooms, reports, blocks, and a bounded audit log.

Audit records describe consent, session, topic, message, moderation, and block transitions. The `get_audit_log` MCP action and host action return records without bearer tokens or raw conversation history. The local store is not encrypted in Alpha; production deployment must protect the file and add encrypted export.

## Capability Policy and Isolation

`EXPERIENCE_ALLOWED_CAPABILITIES` is an optional comma-separated host allowlist. A module whose manifest declares a capability outside the allowlist is rejected before a consent token is issued. The service entrypoint runs modules in a child process and communicates through a small lifecycle RPC; `EXPERIENCE_ISOLATE_MODULES=0` disables that boundary for debugging. Child-process isolation limits crash propagation but is not an OS-level security sandbox.

## Module lifecycle

```text
discover
  -> create or import Context Envelope
  -> prepare launch and show Consent Policy
  -> user confirms
  -> launch with a host/session-bound token
  -> module.start(context)
  -> module.handleEvent(context, state, event)
  -> continue or finish
```

## Current limitations

`controlled-js` modules are local and run in a child process when started through the service entrypoint. Signatures detect changes and trust maps identify configured publisher keys, but neither signatures nor child processes replace an OS-level sandbox. The Alpha store is local and unencrypted by default; the public topic service has no account identity, remote registry, or private messaging.

---

# Portable Experience Protocols / 可移植体验协议

> [English](#portable-experience-protocols--可移植体验协议) | 简体中文

本项目固定五层公开协议。它们都是 JSON 契约，可由 Claude 适配器、其他 MCP 宿主或未来的非 MCP 宿主实现。

## Experience Manifest（体验清单）

每个已安装模块都有一个 `manifest.json`（字段见上方英文示例）。`memory.reads` 与 `memory.writes` 的值是能力作用域名称；模块只会获得当前授权策略授予的读作用域。

## Module Signature（模块签名）

签名存放在 manifest 旁边的 `signature.json`，不嵌入 manifest，因此签名不会产生自引用文档。签名覆盖规范化后的 manifest 摘要、模块入口摘要、模块 id 与版本、发布者 key id（结构见上方英文示例）。

注册表区分四种状态：`trusted`（签名有效且公钥匹配信任表）、`signed`（密码学签名有效但公钥不在信任表）、`unsigned`（无签名文件）、`invalid`（签名或覆盖的文件校验失败）。没有信任根的有效签名只能证明完整性，不能证明发布者身份。

## Experience Registry（体验注册表）

`experience-registry/v1` 是生成的、可分享的索引，条目暴露宿主在向用户展示模块前所需的字段（示例见上方英文部分）。`versions` 数组保留每个已观察版本的发布摘要与签名状态。`build-registry-index` 生成新索引时会合并旧索引；当前参考实现仍只把索引存在本地，不提供远程包服务。

## Context Envelope（上下文信封）

可移植的上下文对象包含用户选择的信号，而非宿主的完整对话历史。当前 schema 支持 intent、interests、可用时长、社交偏好、选定摘录、游戏偏好与 locale。新字段应走版本化，而不是静默塞入任意数据。

## Consent Policy（授权策略）

策略是"用户允许某个模块做什么"的可移植描述（字段见上方英文示例）。实际 bearer token 刻意不可移植：用户迁移到其他宿主后，该宿主可在用户复核后复用策略，再签发一个绑定到自身模块会话的新 token。

运行时通过非敏感的 `consent_receipt_id` 暴露 `get_consent_status` 与 `revoke_consent`。撤销操作永不返回或重建 bearer token。

## Public Topics（公开话题）

公开话题采用 `public-topics/v1` 语义。话题有公开标题、正文、标签、化名 `author_id`、状态和可选讨论房间；房间包含公开消息和参与者 id。当前服务是本地内存实现；`actor_id` 由宿主提供，不构成账号或身份证明。

审核生命周期是显式的：

```text
创建话题
  -> 发现话题
  -> 按需加入房间
  -> 发布公开消息
  -> 举报话题/消息
  -> 审核者驳回、隐藏或恢复举报
  -> 参与者可拉黑或恢复另一参与者
```

MCP 适配器暴露 `discover_public_topics`、`create_public_topic`、`join_public_room`、`get_public_room`、`post_public_message`、`report_public_content`、`list_public_reports`、`review_public_report`、`block_public_actor`、`unblock_public_actor`。本地 HTTP 适配器在 `/api/topics`、`/api/rooms`、`/api/moderation` 下镜像这些能力。

## Module lifecycle（模块生命周期）

```text
发现
  -> 创建或导入 Context Envelope
  -> 准备启动并展示 Consent Policy
  -> 用户确认
  -> 用绑定宿主/会话的 token 启动
  -> module.start(context)
  -> module.handleEvent(context, state, event)
  -> 继续或结束
```

## 当前限制

通过服务入口启动时，`controlled-js` 模块会在子进程运行。签名能发现改动、信任表能识别已配置的发布者密钥，但签名和子进程都不能替代 OS 级沙盒。Alpha 的本地存储默认不加密；公开话题服务没有账号身份、远程注册表或私信。
