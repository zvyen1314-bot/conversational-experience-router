# Local Experience Modules / 本地体验模块

> English | [简体中文](#local-experience-modules--本地体验模块-1)

Each child directory is a locally installed experience module. The router loads `manifest.json` and `module.mjs` at startup; no core source file needs to be edited.

Create a starter module from the project root:

```bash
npm run create-module -- --id focus-sprint --name "Focus Sprint" --purpose "Turn a vague task into one next step"
npm run validate-module -- ./experiences/focus-sprint
```

Import a module produced elsewhere without executing its implementation. An optional `signature.json` is preserved:

```bash
npm run import-module -- --source ./path/to/my-module
npm run validate-module -- ./experiences/my-module
```

Review `module.mjs` before running `validate-module`; the latter imports the implementation to check its lifecycle exports.

```text
experiences/
  your-module/
    manifest.json
    module.mjs
    README.md
```

`module.mjs` exports a default object with two functions:

```js
export default {
  async start(context) {
    return { round: 1, score: 0, hintUsed: false };
  },

  async handleEvent(context, state, event) {
    return {
      state: { ...state, feedback: "updated" },
      status: "active",
      message: "updated",
    };
  },
};
```

The current loader supports local `controlled-js` modules. These modules run in the same Node.js process as the MCP server, so only modules the user has reviewed should be installed. Remote GitHub installation, signature verification, and sandboxing are later steps.

Modules receive only the context allowed by the consent policy:

```js
{
  sessionId: "session-...",
  experienceId: "your-module",
  approvedContext: { interests: ["..."], available_time_minutes: 10 },
  consentPolicy: { protocol: "experience-consent/v1", token_portability: "reissue-only" }
}
```

The portable object is the `Context Envelope`; the active consent token is always reissued for the current host and session.

---

# Local Experience Modules / 本地体验模块

> [English](#local-experience-modules--本地体验模块) | 简体中文

每个子目录都是一个本地安装的体验模块。路由器在启动时加载 `manifest.json` 和 `module.mjs`，无需改动任何核心源文件。

从项目根目录创建起步模块：

```bash
npm run create-module -- --id focus-sprint --name "Focus Sprint" --purpose "Turn a vague task into one next step"
npm run validate-module -- ./experiences/focus-sprint
```

导入其他工具产出的模块而不执行其实现，可选的 `signature.json` 会被保留：

```bash
npm run import-module -- --source ./path/to/my-module
npm run validate-module -- ./experiences/my-module
```

运行 `validate-module` 前先审阅 `module.mjs`；后者会导入实现以检查其生命周期导出。

```text
experiences/
  your-module/
    manifest.json
    module.mjs
    README.md
```

`module.mjs` 导出一个带两个函数的默认对象：

```js
export default {
  async start(context) {
    return { round: 1, score: 0, hintUsed: false };
  },

  async handleEvent(context, state, event) {
    return {
      state: { ...state, feedback: "updated" },
      status: "active",
      message: "updated",
    };
  },
};
```

当前服务入口默认把本地 `controlled-js` 模块放在独立子进程中运行，以隔离模块崩溃和宿主状态；这不是完整的 OS 级沙盒，因此仍只应安装用户已审阅并验证签名的模块。远程 GitHub 安装、远程注册表和更强沙盒属于后续步骤。

模块只会收到授权策略允许的上下文：

```js
{
  sessionId: "session-...",
  experienceId: "your-module",
  approvedContext: { interests: ["..."], available_time_minutes: 10 },
  consentPolicy: { protocol: "experience-consent/v1", token_portability: "reissue-only" }
}
```

可移植对象是 `Context Envelope`；实际的授权 token 始终为当前宿主和会话重新签发。
