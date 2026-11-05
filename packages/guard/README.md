---
description: "Package map for the guard family: the repeat-tool reminder, the per-tool-call timeout policy, and the destructive-delete check, for users and maintainers choosing or composing the guards."
kind: "package-group"
---

# guard/ — loop-hygiene guard family

English | [中文](README.zh.md)

## Summary

The `guard/` group watches tool calls for stuck loops, hung calls, and destructive deletes. `repeat-tool-reminder` notices when the model repeats the exact same tool call and reminds it to change approach or finish. `timeout-policy` puts a time limit on tool calls that declare one, so a hung call returns a clear timed-out error. `delete-guard` holds a delete of session storage, a recursive delete outside the workspace, or a recursive delete over its file-count or byte threshold, and asks for confirmation or denies the call. All three ship enabled in the `dsh` base bundle; a composition can tune or remove them.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Three plugins cover the three patterns; each README below explains when to keep, tune, or remove it.

| Package | What it provides |
|---|---|
| [`repeat-tool-reminder/`](repeat-tool-reminder/README.md) | Reminds the model when it repeats the same tool call, so it changes approach or finishes |
| [`timeout-policy/`](timeout-policy/README.md) | Times out tool calls that declare a limit, so the model gets a clear error instead of waiting forever |
| [`delete-guard/`](delete-guard/README.md) | Holds session-storage and large recursive deletes until the user confirms, or denies them when confirmation is unavailable |

-----

<a id="related-documentation"></a>
## Related documentation

Start with the tools subsystem reference for the tool-call pipeline, then the reminder's configuration and the timeout-library decision behind the policy.

- [Tools subsystem reference](../../docs/subsystems/tools.md) — the tool-call pipeline and decisions both guards build on.
- [Generated configuration catalog](../../docs/config-catalog.md#deepseek-aidsh-repeat-tool-reminder) — every accepted field of the repeat-call reminder.
- [Delete guard](delete-guard/README.md) — the session-storage and large-delete check, and its [configuration](../../docs/config-catalog.md#deepseek-aidsh-delete-guard).
- [Timeout deadline library Agent Note](../../.agents/notes/implemented/architecture/2026-07-06-timeout-deadline-library.md) — the timing/termination split `timeout-policy` enforces.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
