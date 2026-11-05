---
kind: upgrade-guide
description: "删除会话存储或大范围文件树的 shell、终端与 run_code 调用现在需要确认，否则会被拒绝。"
---

# 破坏性删除需要确认

[English](guide.md) | 中文

## 变更

包含基础组合包或 sdk-minimal 的随附 `dsh` profile 现在会挂载 `@deepseek-ai/dsh-delete-guard`。删除会话存储、在工作区外递归删除，或在工作区内递归删除超过 10000 个文件或 1 GiB 的 `bash`、`pwsh`、`terminal_send` 或 `run_code` 调用不再立即运行。审批策略 `ask` 会展示路径、文件数和字节数，并且只有在一次批准之后才继续。审批策略 `never`（包括 `danger-full-access` 预设）会拒绝该删除。没有审批通道的 profile（包括 sdk-minimal）也会拒绝。其他命令不变。

## 迁移

1. 保留 `packages/bundle/base/cordis.patch.yml` 或 `packages/bundle/sdk-minimal/cordis.patch.yml` 里新的 `delete-guard` 行。自己运行 shell 的组合加上 `- name: '@deepseek-ai/dsh-delete-guard'`。
2. 要确认其中一次删除，把会话审批策略设为 `ask`（`workspace-write` 或 `auto` 预设）并批准提示。把删除缩小到阈值以下，并且留在工作区内、离开会话存储，就可以不经提示运行。
3. 可选阈值写在该行上：`fileCountThreshold`、`byteThreshold`、`measureEntryCap`，以及额外的 `sessionRoots`。确认以前允许的、针对会话目录或大范围目录的 `rm -rf` 现在会停下或询问，而 `ls` 仍然运行。
