# Agent Note: Destructive delete check

Status: implemented

[English](2026-11-05-destructive-delete-check.md) | 中文

## 问题

`danger-full-access` 会跳过文件系统隔离，随附预设又把它和审批策略 `never` 配在一起。因此 `rm -rf` 这类 shell 命令会在没有提示的情况下运行。这可以清掉会话存储目录和工作区外的大范围目录，包括同一台机器上属于其他工具的数据。完全沙箱访问被当成了删除这些目录的许可。

## 决定

`@deepseek-ai/dsh-delete-guard` 监听 `tools/pre-execute`，并在 `bash`、`pwsh`、`terminal_send` 或 `run_code` 运行前拦住三类删除：等于、包含或位于会话存储根之内的路径；会话工作区之外的递归删除；以及超过配置的文件数或字节阈值的工作区内递归删除。影响范围文本在计数走得完时列出路径、文件数和字节数。审批策略 `ask` 对这次调用确认一次。策略 `never` 以及缺少审批通道时拒绝它。JSONL 后端通过 `SessionPersistence.sessionStorageRoots()` 报告自己的目录。基础组合包和 sdk-minimal 挂载这个插件。没有回收站或快照步骤。

## 识别

检查会切分命令，并识别 `rm -r`、`find -delete`、带目录标志的 `git clean`、PowerShell 的 `Remove-Item -Recurse`，以及常见的 `rmSync` / `rmtree` 调用。无法定位的展开或 `cd` 保持未解析，递归删除会被拦住。更早一次持久 shell 调用里的 `cd` 不可见。

## 考虑过的替代方案

**只匹配文本 `rm -rf`。** 那会漏掉 `-fr`、`--recursive`、`find -delete`、PowerShell 和 `run_code`，也不知道目标是不是会话存储。

**即使审批策略是 `never` 也弹出确认。** 审批服务在任何应答者之前就拒绝 `never`，这样无人值守的运行不能被某个监听器批准。再开一条提示路径会打破这个承诺。因此删除被拒绝，结果告诉模型把会话换成 `ask` 或缩小命令。

**增加回收站或快照存储。** 仓库里没有针对任意删除的恢复存储。新做一套会变成第二套持久化系统。已确认的删除保持永久。

## 后果

`danger-full-access` 对普通写入仍然跳过隔离，而这些删除不再静默运行。sdk-minimal 没有审批服务，因此同样的删除在那里被拒绝而不是被确认。混淆过的命令仍然可以通过静态检查。工作区内、不超过 10000 个文件且不超过 1 GiB 的递归删除仍然运行，因此普通的小清理不变，仅靠阈值也挡不住刚好停在阈值以下的删除。
