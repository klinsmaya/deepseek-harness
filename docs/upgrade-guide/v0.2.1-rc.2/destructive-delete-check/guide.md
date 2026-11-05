---
kind: upgrade-guide
description: "Shell, terminal, and run_code deletes of session storage or large file trees now require confirmation or are denied."
---

# Destructive deletes require confirmation

English | [中文](guide.zh.md)

## Change

Shipped `dsh` profiles that include the base bundle or sdk-minimal now mount `@deepseek-ai/dsh-delete-guard`. A `bash`, `pwsh`, `terminal_send`, or `run_code` call that deletes session storage, recursively deletes outside the workspace, or recursively deletes more than 10000 files or 1 GiB inside the workspace no longer runs immediately. Approval policy `ask` shows the paths, file count, and byte count and continues only after one approval. Approval policy `never`, including the `danger-full-access` preset, denies the delete. A profile with no approval channel, including sdk-minimal, denies it. Other commands are unchanged.

## Migration

1. Keep the new `delete-guard` row in `packages/bundle/base/cordis.patch.yml` or `packages/bundle/sdk-minimal/cordis.patch.yml`. A custom composition that runs a shell adds `- name: '@deepseek-ai/dsh-delete-guard'`.
2. To confirm one of these deletes, set the session approval policy to `ask` (the `workspace-write` or `auto` preset) and approve the prompt. Narrowing the delete below the thresholds, and keeping it inside the workspace and away from session storage, lets it run without a prompt.
3. Optional thresholds live on that row: `fileCountThreshold`, `byteThreshold`, `measureEntryCap`, and extra `sessionRoots`. Confirm a previously allowed `rm -rf` of a session directory or a large tree now stops or asks, and that `ls` still runs.
