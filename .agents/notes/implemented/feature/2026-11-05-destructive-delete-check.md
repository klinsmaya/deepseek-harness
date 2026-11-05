# Agent Note: Destructive delete check

Status: implemented

English | [中文](2026-11-05-destructive-delete-check.zh.md)

## Problem

`danger-full-access` skips filesystem confinement, and the shipped preset pairs it with approval policy `never`. A shell command such as `rm -rf` therefore runs with no prompt. That can remove the session-storage directory and large trees outside the workspace, including data that belongs to another tool on the same machine. Full sandbox access was being treated as permission to delete those trees.

## Decision

`@deepseek-ai/dsh-delete-guard` listens on `tools/pre-execute` and holds three kinds of delete before `bash`, `pwsh`, `terminal_send`, or `run_code` runs: a path that is, contains, or sits inside a session-storage root; a recursive delete outside the session workspace; and a recursive in-workspace delete over the configured file-count or byte threshold. The impact text lists paths, file count, and byte count when the walk can produce them. Approval policy `ask` confirms the call once. Policy `never`, and a missing approval channel, deny it. The JSONL backend reports its directory through `SessionPersistence.sessionStorageRoots()`. The base bundle and sdk-minimal mount the plugin. There is no trash or snapshot step.

## Recognition

The check tokenizes the command and recognizes `rm -r`, `find -delete`, `git clean` with a directory flag, PowerShell `Remove-Item -Recurse`, and common `rmSync` / `rmtree` calls. An expansion or a `cd` it cannot place stays unresolved and the recursive delete is held. A `cd` from an earlier persistent-shell call is not visible.

## Alternatives considered

**Match only the text `rm -rf`.** That misses `-fr`, `--recursive`, `find -delete`, PowerShell, and `run_code`, and it does not know whether the target is session storage.

**Prompt even when approval policy is `never`.** The approval service rejects `never` before any answerer so that unattended runs cannot be granted by a listener. A second prompt path would break that promise. The delete is denied instead, and the result tells the model to switch the session to `ask` or narrow the command.

**Add a trash or snapshot store.** The repository has no recovery store for arbitrary deletes. A new one would be a second persistence system. Confirmed deletes stay permanent.

## Consequences

`danger-full-access` still skips confinement for ordinary writes, and it no longer runs these deletes silently. sdk-minimal has no approval service, so the same deletes are denied there rather than confirmed. Obfuscated commands can still pass the static check. A recursive in-workspace delete at or under 10000 files and 1 GiB still runs, which leaves ordinary small cleans unchanged and does not by itself stop a delete that stays just under the thresholds.
