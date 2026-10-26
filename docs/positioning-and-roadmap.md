# Roadmap / 路线图

> English | [简体中文](#roadmap--路线图-1)

## Current version (V1.0 Alpha 1)

The local-first experience runtime, module publishing infrastructure, public-topics foundation, and first host-neutral adapter are complete:

- `three-minute-mystery` is a real stateful experience with a local web interface.
- `launch_experience` returns `session_id`, `entrypoint`, and an expiry time.
- `continue_experience`, `submit_experience_event`, and `finish_experience` are available.
- `prepare_experience_launch` issues a one-time confirmation token instead of a boolean `confirmed`.
- `Context Envelope`, `Consent Policy`, consent-status query, and revocation are fixed as public protocols.
- `create-module`, `import-module`, and `validate-module` support module creation, import, and review.
- Ed25519 module signing, trusted keys, signature verification, and the `experience-registry/v1` version index are available.
- MCP and the local HTTP API support public topics, discussion rooms, public posting, reporting, moderation, and blocking.
- SQLite / JSON persistence stores consent, sessions, public topics, and moderation state, with audit records that exclude bearer tokens.
- `EXPERIENCE_ALLOWED_CAPABILITIES` provides a host capability allowlist; the service entrypoint runs modules through child-process RPC by default.
- `experience-host/v1` provides a JSON adapter and HTTP `/api/host` endpoint for a second non-MCP host type.
- Runtime tests cover consent, signature tamper detection, the registry, public topics, and the HTTP API.

## Version progress

- **V0.3 Module authoring**: manifest schema, `validate-module`, `create-module` scaffolding, `import-module` local import, a module README template, the lifecycle API, and `experiences/` auto-discovery.
- **V0.4 Portable context and consent**: `Context Envelope`, `Consent Policy`, one-time bearer tokens, consent-status query and revocation; raw conversation history is not uploaded by default.
- **V0.5 Registry and public topics**: signing/verification, trusted-publisher status, permission/risk display, version index, public topics, discussion rooms, reporting, moderation, and blocking.

## Alpha follow-up

- **V1.0 Beta**: OS-level sandboxing, encrypted storage and export, module resource limits, independent module tests, a remote registry, and update rollback.
- **V1.0 Stable**: at least two real host adapters, protocol compatibility tests, publisher identity, reviewer identity, deployment monitoring, backup recovery, and a security audit.

## Principles

- Ship public topics and controlled rooms first, then real social data, accounts, and real-person matching.
- Never start with automatic private messaging or dating recommendations.

---

# Roadmap / 路线图

> [English](#roadmap--路线图) | 简体中文

## 当前版本（V1.0 Alpha 1）

已完成本地优先的体验运行时、模块发布基础设施、公开话题基础能力和第一版宿主中立协议：

- `three-minute-mystery` 成为真实的有状态体验，提供本地网页界面。
- `launch_experience` 返回 `session_id`、`entrypoint` 和过期时间。
- 支持 `continue_experience`、`submit_experience_event`、`finish_experience`。
- `prepare_experience_launch` 签发一次性确认令牌，取代布尔值 `confirmed`。
- `Context Envelope`、`Consent Policy`、授权状态查询和撤销已经固定为公开协议。
- `create-module`、`import-module`、`validate-module` 支持模块创建、导入和审阅。
- Ed25519 模块签名、可信密钥、签名验证和 `experience-registry/v1` 版本索引已经可用。
- MCP 和本地 HTTP API 支持公开话题、讨论房间、公开发言、举报、审核和拉黑。
- SQLite / JSON 持久化授权、会话、公开话题和审核状态，并记录不包含 bearer token 的审计事件。
- `EXPERIENCE_ALLOWED_CAPABILITIES` 支持宿主能力白名单；服务入口默认通过子进程 RPC 执行模块。
- `experience-host/v1` JSON 协议和 HTTP `/api/host` 适配器可以承载第二类非 MCP 宿主。
- 运行时测试覆盖授权、模块签名篡改检测、注册表、公共话题和 HTTP API。

## 版本进展

- **V0.3 模块创作**：已提供 manifest schema、`validate-module`、`create-module` 脚手架、`import-module` 本地导入、模块 README 模板、生命周期 API 和 `experiences/` 自动发现。
- **V0.4 可移植上下文与授权**：已提供 `Context Envelope`、`Consent Policy`、一次性 bearer token、授权状态查询和撤销；默认不上传原始对话历史。
- **V0.5 注册表与公共话题**：已提供签名/验证、可信发布者状态、权限/风险展示、版本索引、公开话题、讨论房间、举报、审核和拉黑。

## Alpha 后续计划

- **V1.0 Beta**：OS 级沙盒、加密存储和导出、模块资源限额、独立模块测试、远程注册表和更新回滚。
- **V1.0 Stable**：至少两个真实宿主适配器、协议兼容性测试、发布者身份验证、审核者身份、部署监控、备份恢复和安全审计。

## 原则

- 先提供公开话题和可控房间，再引入真实社交数据、账号体系和真人匹配。
- 不以自动私信或约会匹配起步。
