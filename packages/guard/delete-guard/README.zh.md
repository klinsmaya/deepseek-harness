---
description: "针对会删除会话存储或大范围文件树的 shell、终端与 run_code 调用的删除检查，供组合或调优该检查的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-delete-guard

[English](README.md) | 中文

## 概述

用这个包拦住会清掉已存储会话、递归离开工作区，或递归删除超过配置的文件数或字节数的删除。检查在 `bash`、`pwsh`、`terminal_send` 和 `run_code` 执行前的 `tools/pre-execute` 中运行。审批策略 `ask` 会展示路径、文件数和字节数，并且只有在 `allowed-once` 之后才继续。审批策略 `never`（包括随附的 `danger-full-access` 预设）拒绝该删除。没有审批通道的组合也会拒绝。`dsh` 基础组合包和 sdk-minimal 组合包都会挂载这个插件。

## 目录

- [使用这个包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与推迟的工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用这个包

把插件和 shell 工具一起挂载。基础组合包已经这样做了。不是已识别删除的命令保持不变。

### 何时选择它

当模型可以通过 shell、持久终端或 `run_code` 改宿主机文件系统时选择它，包括在 `danger-full-access` 下。只有工具不能删除文件的组合才跳过它。

### 配置

```yaml
- name: '@deepseek-ai/dsh-delete-guard'
  config:
    fileCountThreshold: 10000
    byteThreshold: 1073741824
    measureEntryCap: 20000
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `fileCountThreshold` | `10000` | 工作区内递归删除的文件数超过该值时拦住 |
| `byteThreshold` | `1073741824` | 工作区内递归删除的字节数超过该值时拦住 |
| `measureEntryCap` | `20000` | 访问这么多个条目后停止计数；未完成的计数也会被拦住 |
| `sessionRoots` | `[]` | 额外的绝对会话存储目录。已挂载持久化后端的 `sessionStorageRoots()` 总会被计入 |

工作区外的递归删除即使小于这些阈值也会被拦住。会话存储目录、其内部路径，或包含它的路径，即使只删一个文件也会被拦住。非法数字或相对的 `sessionRoots` 条目会在插件加载时失败。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-delete-guard)列出每个字段。

### 你会得到什么

模型会看到三种结果之一。审批策略为 `ask` 时，用户看到影响范围，调用只在一次批准后运行。策略为 `never` 时，工具结果拒绝删除并给出同样的影响范围。没有审批服务，或这次调用没有 agent 时，工具结果同样拒绝。被拒绝时不会删除任何文件。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

监听器先调用 `next()`，因此更后面的 `tools/pre-execute` 拒绝优先，并且不会弹出确认。然后它识别 POSIX 与 PowerShell 文本中的删除；对 `run_code` 还会识别 `rmSync`、`unlinkSync`、`rmtree` 和 `os.remove` 调用。相对路径先按同一条命令里更早的 `cd` 或 `Set-Location` 解析，否则按工具的 `workdir`，否则按会话工作区。判断内外所用的工作区是会话目录，不是 `workdir`。计数使用 `lstat`，不跟随符号链接。JSONL 持久化后端通过 `sessionStorageRoots()` 报告它配置的根目录。

### 源文件

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口和 `tools/pre-execute` 监听器 |
| [`src/parse.ts`](src/parse.ts) | shell 与程序识别 |
| [`src/measure.ts`](src/measure.ts) | 有上限的文件数与字节数 |
| [`src/decide.ts`](src/decide.ts) | 拦截决定与影响范围文本 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [工具执行流水线](../../../docs/tool-execution-pipeline.zh.md) — `tools/pre-execute` 位于工具主体之前的位置。
- [权限预设](../../../docs/subsystems/permission-presets.zh.md) — `danger-full-access` 把完全沙箱访问和审批策略 `never` 配在一起。
- [升级指南](../../../docs/upgrade-guide/v0.2.1-rc.2/destructive-delete-check/guide.zh.md) — 现有 profile 会遇到的变化。
- [删除检查笔记](../../../.agents/notes/implemented/feature/2026-11-05-destructive-delete-check.zh.md) — 为什么完全沙箱访问并不授权这些删除。

-----

<a id="model-experience"></a>
## 模型体验

### 条件工具结果

#### 模型看到什么

这个插件不增加提示词段落，也不增加工具 schema。被拦住的删除会把工具结果换成下面其中一句，然后每个目标一行，格式为 `- <path>: <count> files, <bytes> bytes (<reasons>)`。未完成的计数写作 `at least <count> files, at least <bytes> bytes`。检查无法解析的路径写作 `file count unavailable`。

##### 确认

```markdown
Destructive delete requires confirmation before it runs.
```

##### 审批策略为 never 时的拒绝

```markdown
Destructive delete blocked. Approval policy "never" does not authorize this delete, including under danger-full-access.
```

##### 没有审批通道时的拒绝

```markdown
Destructive delete blocked. No approval channel is available, so the delete does not run.
```

#### Token 影响

命令不是被拦住的删除时，token 为零。拒绝或确认请求会增加一条列出路径、文件数和字节数的工具结果。

#### KV Cache 影响

只追加。结果跟在可复用的请求前缀之后，不改写更早的 token。

## 已知限制与推迟的工作

<a id="known-limitations-and-deferred-work"></a>

这些限制是检查覆盖不到的情况。它们是当前的包约束。

- **静态识别** — 编码后的命令、在更早的持久 shell 调用里定义的别名，以及只在运行时拼出来的删除不会被识别。`cd` 只在同一条命令字符串里可见。
- **策略 `never` 会拒绝** — 随附的 `danger-full-access` 预设不会弹出确认。确认需要审批策略 `ask`。
- **没有回收站或快照** — 已确认的删除是永久的。这个包不会把文件挪到一边。
- **不带目录标志的 `git clean -f`** — 只删文件的 clean 不会被拦住。`git clean -fd` 和 `git clean -fx` 会被拦住。
- **工具流水线之外** — 不是 `bash` 或 `pwsh` 的 `ctx.shell.execute` 调用方不会被检查。随附的 shell 工具会先进入 `tools/pre-execute`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
