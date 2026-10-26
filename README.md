# Conversational Experience Router

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A520-brightgreen)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-compatible-7c3aed)](https://modelcontextprotocol.io)

> [简体中文](#conversational-experience-router-1) | English

An open experience layer for conversational AI. It routes user intents — "I'm bored", "help me organize this idea", "I want to chat about something" — into experiences that can start right away.

Claude is the first AI host; other MCP-compatible or similar-protocol hosts can be added later.

Current release: **V1.0 Alpha 1**. It adds durable local state, audit records, capability allowlists, an isolated module process boundary, and the host-neutral `experience-host/v1` JSON adapter. The alpha is ready for protocol and developer integration testing; it is not a hosted public service.

## Features

- **Intent to experience**: discover and recommend experience modules from the current intent and user-approved interest signals.
- **Explicit consent**: before launching, issue a one-time, short-lived consent token for the chosen module; the experience starts only after the user confirms.
- **Stateful sessions**: each experience runs as a short session, with continue, submit-event, and finish.
- **Extensible**: add a module by dropping it into `experiences/`; no core changes.
- **Verifiable registry**: Ed25519 module signing, trusted publishers, permission/risk display, and a version-history index.
- **Public topics foundation**: public topics, optional discussion rooms, reporting, moderation, and blocking — no automatic private messaging or real-person matching.
- **Local-first**: the experience web server listens on localhost only and is account-free.

## Built-in modules

- `social-pulse`: public topics and potential conversation directions (demo data for now; real matching and private messaging are a later phase).
- `three-minute-mystery`: a three-minute text deduction game.
- `thought-garden`: turn scattered ideas into a core thought, assumptions, and next steps.

## Install and run

Requires Node.js 20 or newer. Node.js 22.5+ uses the built-in SQLite backend; Node.js 20 falls back to an atomic JSON document store.

```bash
npm install
npm run build
```

Then:

```bash
node dist/index.js
```

The MCP service talks over stdio and also starts a localhost-only web server and public-topics HTTP API at `http://127.0.0.1:4317` by default. If the port is taken, an available port is chosen automatically and returned in the `launch_experience` `entrypoint` field; set `EXPERIENCE_PORT` to pin the port.

Alpha runtime settings:

```text
EXPERIENCE_STATE_FILE=./data/experience-router.db
EXPERIENCE_TRUSTED_KEYS=./keys/trusted-keys.json
EXPERIENCE_ALLOWED_CAPABILITIES=text_game,reflection,topic_recommendation
EXPERIENCE_ISOLATE_MODULES=1
EXPERIENCE_MODULES_DIR=./experiences
```

The service exposes the host-neutral adapter at `POST /api/host`; its request and response envelope is documented as `experience-host/v1` in [`docs/protocol.md`](docs/protocol.md).

## Connect to Claude

### Claude Desktop

Add this to Claude Desktop's MCP config, replacing the path with your local absolute path:

```json
{
  "mcpServers": {
    "experience-router": {
      "command": "node",
      "args": [
        "C:\\path\\to\\conversational-experience-router\\dist\\index.js"
      ]
    }
  }
}
```

### Claude Code

```bash
claude mcp add experience-router -- node C:\\path\\to\\conversational-experience-router\\dist\\index.js
```

Then, for example:

> I'm bored and I have three minutes — find me something I can start right now.

## Workflow

1. `discover_experiences`: recommend modules from intent and interest signals.
2. `prepare_experience_launch`: issue a one-time, short-lived consent token for the chosen module.
3. `launch_experience`: start the experience with the confirmed token.
4. Continue or end via `continue_experience` / `submit_experience_event` / `finish_experience`.

## Tool list

| Tool | Purpose |
| --- | --- |
| `discover_experiences` | Recommend modules from the current intent and user-approved interest signals |
| `list_public_modules` | Show module versions, permissions, risk, publisher, and signature status |
| `create_context_envelope` | Wrap user-selected shared context into a portable object |
| `prepare_experience_launch` | Issue a one-time, short-lived consent request for the chosen module |
| `launch_experience` | Start a stateful experience with the confirmed token |
| `get_consent_status` | Query consent state and scope; never returns the token |
| `revoke_consent` | Revoke an unused experience consent |
| `get_audit_log` | Read local consent and session audit records without secrets |
| `continue_experience` | Read current experience session state |
| `submit_experience_event` | Submit an answer, hint, restart, or end event |
| `finish_experience` | End an experience session |
| `create_experience_draft` | Create a private module draft from a safe template |
| `discover_public_topics` | Discover public topics without reading full conversation history |
| `create_public_topic` | Create a public topic |
| `join_public_room` / `get_public_room` | Join or read a public discussion room on demand |
| `post_public_message` | Post in a public discussion room |
| `report_public_content` | Report a public topic or message |
| `list_public_reports` / `review_public_report` | View and process the local moderation queue |
| `block_public_actor` / `unblock_public_actor` | Block or restore a public participant |

## Developers: write a module

A module does not modify the core router. Drop a module directory into `experiences/` and restart the service to auto-load it:

```text
experiences/
  my-module/
    manifest.json
    module.mjs
```

`manifest.json` describes module identity, version, capabilities, risk, and memory boundaries; `module.mjs` exports two lifecycle functions:

```js
export default {
  async start(context) {
    return { round: 1, score: 0 };
  },
  async handleEvent(context, state, event) {
    return { state: { ...state }, status: "active" };
  }
};
```

Validate locally:

```bash
npm run validate-module -- ./experiences/my-module
```

Scaffold a new module:

```bash
npm run create-module -- --id focus-sprint --name "Focus Sprint" --purpose "Turn a vague task into one next step" --category reflection --capabilities reflection --reads selected_excerpts
npm run validate-module -- ./experiences/focus-sprint
```

The scaffold writes `manifest.json`, `module.mjs`, and a module README; it refuses to overwrite an existing directory unless `--force` is passed.

Import an externally produced module without executing it — copy and validate the manifest first:

```bash
npm run import-module -- --source ./path/to/my-module
npm run validate-module -- ./experiences/my-module
```

`import-module` only copies `manifest.json`, `module.mjs`/`module.js`, an optional `signature.json`, and a README; it never runs external code. `validate-module` imports the module to check its lifecycle exports, so review it first.

Sign a module and build the public registry:

```bash
npm run create-publisher-key -- --key-id example-main --out-dir ./keys --trust-file ./keys/trusted-keys.json
npm run sign-module -- --module ./experiences/my-module --private-key ./keys/example-main.private.pem --key-id example-main
npm run verify-module -- --module ./experiences/my-module --trusted-keys ./keys/trusted-keys.json
npm run build-registry-index -- --root ./experiences --output ./registry/index.json --trusted-keys ./keys/trusted-keys.json
```

`signature.json` covers the canonical manifest digest and the entry-code digest. The registry distinguishes `trusted`, `signed`, `unsigned`, and `invalid`; set `EXPERIENCE_TRUSTED_KEYS` at runtime so public discovery can identify trusted publishers.

Run tests:

```bash
npm test
```

The current runtime supports local `controlled-js` modules and is meant for code the developer has reviewed. Remote GitHub install, a remote registry service, persistent moderation, and sandboxed execution are not implemented yet; the router never auto-executes code from an untrusted repository.

## Public protocols

The project fixes five public protocol surfaces:

- `Experience Manifest`: module identity, version, capabilities, risk, and read/write scope.
- `Context Envelope`: user-selected context fields that can migrate between hosts.
- `Consent Policy`: the read/write scope a module is currently allowed. The actual bearer token is bound to the current host and session, and can only be reissued, not migrated.
- `Module Signature`: an Ed25519 signature object covering the manifest and entry-code digests.
- `Experience Registry` / `Public Topics`: public module index, version history, public topics, rooms, and moderation objects.

Call `create_context_envelope` to build the context, then pass the returned envelope to `prepare_experience_launch`. Full fields and JSON examples are in [`docs/protocol.md`](docs/protocol.md).

## Security and boundaries

- The router never auto-reads conversation history and never fetches phone or account data without call parameters; the host should only pass interest signals the user explicitly agreed to share.
- The one-time, short-lived consent token issued by `prepare_experience_launch` is the user control point. It is bound to one module and invalidates after use; experience sessions expire after 10 minutes by default.
- `create_experience_draft` only produces a declarative draft and never executes user-uploaded native code.
- The production entrypoint runs `controlled-js` modules in a child process by default; this is a crash and execution boundary, not a complete OS-level sandbox. Set `EXPERIENCE_ISOLATE_MODULES=0` only for local debugging.
- Runtime sessions, consent records, audit events, public topics, rooms, reports, and blocks persist in the configured local store. The local store is not encrypted by default.
- `EXPERIENCE_ALLOWED_CAPABILITIES` can restrict module capability names before consent is issued; an empty value keeps the development default of allowing declared capabilities.
- Public topics remain account-free and pseudonymous. Real-person matching, private messaging, and dating recommendations are not provided.
- This is a protocol alpha, not a hosted public service or an AI phone operating system.

## Project structure

```text
src/
  catalog.ts       built-in module manifests and matching
  index.ts         MCP stdio server and tool registration
  runtime.ts       consent tokens, experience sessions, and event state
  registry.ts      module registration and discovery
  signature.ts     module signing and digest verification
  public-topics.ts public topics, rooms, and moderation state
  module-api.ts    module lifecycle API
  protocol.ts      Manifest, Context Envelope, and Consent Policy protocols
  host-protocol.ts host-neutral JSON adapter protocol
  persistence.ts   SQLite / JSON durable document store and audit log
  module-worker-host.ts child-process module boundary
  types.ts         shared types
  web.ts           local experience web server and session API
experiences/       built-in modules (manifest + module.mjs)
scripts/           module create, import, sign, and registry commands
docs/              protocol and roadmap
```

## License

[MIT](LICENSE)

---

# Conversational Experience Router

> English | [简体中文](#conversational-experience-router-1)

一个面向对话式 AI 的开放体验层。它把用户说出的「我很无聊」「帮我整理这个想法」「我想找点话题聊」等意图，路由到可以立即开始的体验模块。

Claude 是首个接入的 AI 宿主，未来可扩展到其他支持 MCP 或类似工具协议的宿主。

## 特性

- **意图到体验**：根据当前意图和用户明确授权的兴趣线索，发现并推荐体验模块。
- **显式授权**：启动体验前，为选定模块生成一次性、限时的授权令牌，用户确认后才启动。
- **有状态会话**：每个体验以短会话运行，支持继续、提交事件、结束。
- **可扩展**：新增模块只需放进 `experiences/` 目录，无需改动核心代码。
- **可验证注册表**：支持 Ed25519 模块签名、可信发布者、权限/风险展示和版本历史索引。
- **公开话题基础能力**：支持公开话题、可选讨论房间、举报、审核和拉黑，不自动私信或真人匹配。
- **本地优先**：体验网页只监听本机，不依赖账号。

## 内置模块

- `social-pulse`：公共话题与潜在聊天方向推荐（当前为演示数据，真人匹配与私信属后续阶段）。
- `three-minute-mystery`：三分钟文字推理小游戏。
- `thought-garden`：把散乱想法整理成核心想法、假设和下一步。

## 安装与运行

需要 Node.js 20 或更高版本。

```bash
npm install
npm run build
```

构建后运行：

```bash
node dist/index.js
```

MCP 服务通过 stdio 与宿主通信，同时启动一个只监听本机的体验网页和公开话题 HTTP API，默认地址为 `http://127.0.0.1:4317`。端口被占用时会自动选择一个可用端口，并通过 `launch_experience` 的 `entrypoint` 字段返回实际地址；也可用环境变量 `EXPERIENCE_PORT` 指定端口。

## 接入 Claude

### Claude Desktop

把下面的条目加入 Claude Desktop 的 MCP 配置文件，并将路径改为本机项目的绝对路径：

```json
{
  "mcpServers": {
    "experience-router": {
      "command": "node",
      "args": [
        "C:\\path\\to\\conversational-experience-router\\dist\\index.js"
      ]
    }
  }
}
```

### Claude Code

```bash
claude mcp add experience-router -- node C:\\path\\to\\conversational-experience-router\\dist\\index.js
```

重启宿主后即可使用。例如对 Claude 说：

> 我很无聊，只有三分钟，给我找点可以马上开始的东西。

## 使用流程

1. `discover_experiences`：根据意图和兴趣线索推荐模块。
2. `prepare_experience_launch`：为选定模块生成一次性、限时的授权令牌。
3. `launch_experience`：用户确认后，用授权令牌启动体验。
4. 通过 `continue_experience` / `submit_experience_event` / `finish_experience` 继续或结束会话。

## 工具列表

| 工具 | 作用 |
| --- | --- |
| `discover_experiences` | 根据当前意图和用户同意提供的兴趣线索推荐模块 |
| `list_public_modules` | 展示模块版本、权限、风险、发布者和签名状态 |
| `create_context_envelope` | 将用户明确选择共享的上下文封装为可迁移对象 |
| `prepare_experience_launch` | 为已选模块生成一次性、限时授权请求 |
| `launch_experience` | 使用用户确认后的授权令牌启动有状态体验 |
| `get_consent_status` | 查询授权状态和权限范围，不返回 token |
| `revoke_consent` | 撤销尚未使用的体验授权 |
| `get_audit_log` | 读取不含 token 和原始对话的本地审计记录 |
| `continue_experience` | 读取当前体验会话状态 |
| `submit_experience_event` | 提交答案、提示、重启或结束事件 |
| `finish_experience` | 结束一个体验会话 |
| `create_experience_draft` | 用安全模板创建私人模块草稿 |
| `discover_public_topics` | 发现公开话题，不读取完整对话历史 |
| `create_public_topic` | 创建公开话题 |
| `join_public_room` / `get_public_room` | 按需加入或读取公开讨论房间 |
| `post_public_message` | 在公开讨论房间发言 |
| `report_public_content` | 举报公开话题或消息 |
| `list_public_reports` / `review_public_report` | 查看和处理本地审核队列 |
| `block_public_actor` / `unblock_public_actor` | 拉黑或恢复公开参与者 |

## 开发者：写一个模块

模块不需要修改核心路由器。把一个模块目录放进 `experiences/`，重启服务后会自动加载：

```text
experiences/
  my-module/
    manifest.json
    module.mjs
```

`manifest.json` 描述模块身份、版本、能力、风险和记忆边界；`module.mjs` 导出两个生命周期函数：

```js
export default {
  async start(context) {
    return { round: 1, score: 0 };
  },
  async handleEvent(context, state, event) {
    return { state: { ...state }, status: "active" };
  }
};
```

本地校验模块：

```bash
npm run validate-module -- ./experiences/my-module
```

也可以用脚手架快速创建一个可校验模块：

```bash
npm run create-module -- --id focus-sprint --name "Focus Sprint" --purpose "把模糊任务拆成一个可执行的下一步" --category reflection --capabilities reflection --reads selected_excerpts
npm run validate-module -- ./experiences/focus-sprint
```

脚手架会生成 `manifest.json`、`module.mjs` 和模块 README；如果目录已经存在，命令会拒绝覆盖，除非显式加入 `--force`。

导入外部生成的本地模块时，可以先只复制并校验 manifest，不执行模块代码：

```bash
npm run import-module -- --source ./path/to/my-module
npm run validate-module -- ./experiences/my-module
```

`import-module` 只复制 `manifest.json`、`module.mjs`/`module.js`、可选的 `signature.json` 和 README；它不会导入执行外部代码。`validate-module` 会为了检查生命周期导出而加载模块，因此应在人工审阅之后运行。

为模块签名并生成公开注册表：

```bash
npm run create-publisher-key -- --key-id example-main --out-dir ./keys --trust-file ./keys/trusted-keys.json
npm run sign-module -- --module ./experiences/my-module --private-key ./keys/example-main.private.pem --key-id example-main
npm run verify-module -- --module ./experiences/my-module --trusted-keys ./keys/trusted-keys.json
npm run build-registry-index -- --root ./experiences --output ./registry/index.json --trusted-keys ./keys/trusted-keys.json
```

`signature.json` 覆盖规范化后的 manifest 和入口代码摘要。注册表会区分 `trusted`、`signed`、`unsigned` 和 `invalid`；运行服务时可设置 `EXPERIENCE_TRUSTED_KEYS`，让 MCP 的公开发现结果识别可信发布者。

运行测试：

```bash
npm test
```

当前支持本地 `controlled-js` 模块，适合开发者审阅后导入；远程 GitHub 安装、远程注册表服务和 OS 级沙盒仍属于后续工作，当前不会自动执行陌生仓库中的代码。

## 公共协议

项目现在固定五层公共协议：

- `Experience Manifest`：模块身份、版本、能力、风险和读写范围。
- `Context Envelope`：用户明确选择共享、可在宿主之间迁移的上下文字段。
- `Consent Policy`：当前模块允许读取和写入的范围。实际 bearer token 绑定当前宿主和会话，只能重新签发，不能直接迁移。
- `Module Signature`：使用 Ed25519 覆盖 manifest 和入口代码摘要的签名对象。
- `Experience Registry` / `Public Topics`：公开模块索引、版本历史、公开话题、房间和审核对象。

可以先调用 `create_context_envelope` 生成上下文，再把返回的 envelope 传给 `prepare_experience_launch`。完整字段和 JSON 示例见 [`docs/protocol.md`](docs/protocol.md)。

## 安全与边界

- 不会自动读取对话历史，也不会在没有调用参数的情况下获取手机或账户数据；宿主只应传入用户明确同意共享的兴趣线索。
- `prepare_experience_launch` 生成的一次性、限时授权令牌是当前原型的用户控制点。令牌绑定具体模块、使用后立即失效；体验会话默认 10 分钟后过期。
- `create_experience_draft` 只生成声明式草稿，不会执行用户上传的原生代码。
- 服务入口默认在子进程中运行 `controlled-js` 模块；这是崩溃和执行边界，还不能替代 OS 级沙盒。调试时可设置 `EXPERIENCE_ISOLATE_MODULES=0`。
- 体验会话、授权、审计、公开话题、房间、举报和拉黑关系会保存到本地存储，默认不加密。
- 可用 `EXPERIENCE_ALLOWED_CAPABILITIES` 在签发授权前限制模块能力；不设置时保留开发模式的声明能力。
- 公开话题仍是无账号的化名服务，暂不提供真人匹配、私信或约会推荐。
- 本仓库是协议 Alpha，不是托管公共服务，也不是 AI 手机操作系统。

## 项目结构

```text
src/
  catalog.ts      内置模块 manifest 和匹配逻辑
  index.ts        MCP stdio server 和工具注册
  runtime.ts      授权令牌、体验会话和事件状态
  registry.ts     模块注册与发现
  signature.ts    模块签名和摘要验证
  public-topics.ts 公开话题、房间和审核状态
  module-api.ts   模块生命周期 API
  protocol.ts     Manifest、Context Envelope 和 Consent Policy 协议
  types.ts        共享类型
  web.ts          本地体验网页和会话 API
experiences/      内置模块（manifest + module.mjs）
scripts/          模块创建、导入、签名和注册表命令
docs/             协议和路线图
```

## License

[MIT](LICENSE)
