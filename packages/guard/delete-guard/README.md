---
description: "Delete check for shell, terminal, and run_code calls that would remove session storage or a large file tree, for users and maintainers composing or tuning the check."
kind: "package-reference"
---

# @deepseek-ai/dsh-delete-guard

English | [中文](README.zh.md)

## Summary

Use this package to hold a delete that would remove stored sessions, recursively leave the workspace, or recursively delete more than the configured file count or byte count. The check runs in `tools/pre-execute` before `bash`, `pwsh`, `terminal_send`, and `run_code` execute. Approval policy `ask` shows the paths, file count, and byte count and continues only after `allowed-once`. Approval policy `never`, including the shipped `danger-full-access` preset, denies the delete. A composition with no approval channel denies it too. The `dsh` base bundle and the sdk-minimal bundle mount the plugin.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin next to the shell tools. The base bundle already does. A command that is not a recognized delete is unchanged.

### When to choose it

Choose it when a model can run a shell, a persistent terminal, or `run_code` against a host filesystem, including under `danger-full-access`. Skip it only in a composition whose tools cannot delete files.

### Setting it up

```yaml
- name: '@deepseek-ai/dsh-delete-guard'
  config:
    fileCountThreshold: 10000
    byteThreshold: 1073741824
    measureEntryCap: 20000
```

| Field | Default | Meaning |
|---|---|---|
| `fileCountThreshold` | `10000` | Hold a recursive in-workspace delete with more files than this |
| `byteThreshold` | `1073741824` | Hold a recursive in-workspace delete with more bytes than this |
| `measureEntryCap` | `20000` | Stop counting after this many visited entries; an unfinished count is held |
| `sessionRoots` | `[]` | Extra absolute session-storage directories. The mounted persistence backend's `sessionStorageRoots()` are always included |

A recursive delete outside the workspace is held even when it is smaller than the thresholds. A delete of a session-storage directory, a path inside it, or a path that contains it is held even when it is one file. Invalid numbers or a relative `sessionRoots` entry fail at plugin load. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-delete-guard) lists every field.

### What you get

The model sees one of three results. Under approval policy `ask`, the user sees the impact and the call runs only after one approval. Under policy `never`, the tool result denies the delete and names the same impact. With no approval service, or no agent on the call, the tool result denies it as well. Nothing is removed in the denied cases.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The listener calls `next()` first, so a later `tools/pre-execute` denial wins without a prompt. It then recognizes deletes in POSIX and PowerShell text, and in `run_code` it also recognizes `rmSync`, `unlinkSync`, `rmtree`, and `os.remove` calls. Relative paths resolve from a `cd` or `Set-Location` earlier in the same command, otherwise from the tool `workdir`, otherwise from the session workspace. The workspace used for inside/outside is the session directory, not `workdir`. Measurement uses `lstat` and does not follow symlinks. The JSONL persistence backend reports its configured root through `sessionStorageRoots()`.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry and `tools/pre-execute` listener |
| [`src/parse.ts`](src/parse.ts) | Shell and program recognition |
| [`src/measure.ts`](src/measure.ts) | Bounded file and byte count |
| [`src/decide.ts`](src/decide.ts) | Hold decision and impact text |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Tool execution pipeline](../../../docs/tool-execution-pipeline.md) — where `tools/pre-execute` sits before the tool body.
- [Permission presets](../../../docs/subsystems/permission-presets.md) — `danger-full-access` pairs full sandbox access with approval policy `never`.
- [Upgrade guide](../../../docs/upgrade-guide/v0.2.1-rc.2/destructive-delete-check/guide.md) — what changes for existing profiles.
- [Delete check note](../../../.agents/notes/implemented/feature/2026-11-05-destructive-delete-check.md) — why full sandbox access does not authorize these deletes.

-----

<a id="model-experience"></a>
## Model Experience

### Conditional tool result

#### What the model sees

This plugin adds no prompt section and no tool schema. A held delete replaces the tool result with one of the sentences below, followed by one bullet per target in the form `- <path>: <count> files, <bytes> bytes (<reasons>)`. An unfinished count says `at least <count> files, at least <bytes> bytes`. A path the check cannot resolve says `file count unavailable`.

##### Confirmation

```markdown
Destructive delete requires confirmation before it runs.
```

##### Denial when approval policy is never

```markdown
Destructive delete blocked. Approval policy "never" does not authorize this delete, including under danger-full-access.
```

##### Denial when no approval channel is available

```markdown
Destructive delete blocked. No approval channel is available, so the delete does not run.
```

#### Token effect

Zero tokens when the command is not a held delete. A denial or confirmation request adds one tool result that lists the paths, file count, and byte count.

#### KV Cache effect

Append-only. The result follows the reusable request prefix and does not rewrite earlier tokens.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits are the cases the check does not cover. They are current package constraints.

- **Static recognition** — encoded commands, aliases defined in an earlier persistent-shell call, and deletes built only at runtime are not recognized. A `cd` is visible only inside the same command string.
- **Policy `never` denies** — the shipped `danger-full-access` preset does not prompt. Confirmation requires approval policy `ask`.
- **No trash or snapshot** — a confirmed delete is permanent. This package does not move files aside.
- **`git clean -f` without a directory flag** — file-only cleans are not held. `git clean -fd` and `git clean -fx` are.
- **Outside the tool pipeline** — a caller of `ctx.shell.execute` that is not `bash` or `pwsh` is not checked. Shipped shell tools enter `tools/pre-execute` first.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
