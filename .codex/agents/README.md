# Repository review agents

These definitions are copied without changes from
[VoltAgent/awesome-codex-subagents](https://github.com/VoltAgent/awesome-codex-subagents)
at commit `9abe3279a0aa4ee518381af800ca1062398f5433`:

- [reviewer.toml](https://github.com/VoltAgent/awesome-codex-subagents/blob/9abe3279a0aa4ee518381af800ca1062398f5433/categories/04-quality-security/reviewer.toml)
- [workflow-orchestrator.toml](https://github.com/VoltAgent/awesome-codex-subagents/blob/9abe3279a0aa4ee518381af800ca1062398f5433/categories/09-meta-orchestration/workflow-orchestrator.toml)

The accompanying [LICENSE](LICENSE) is the unmodified upstream MIT license,
including Copyright (c) 2026 VoltAgent. Retain it with the definitions.
No repository-local agent definitions or customizations existed at installation.
Before updating these files, compare local changes against this pinned source
and preserve any subsequent customizations.

## Execution and compatibility

The repository policy is [Mandatory implementation review](../../AGENTS.md#mandatory-implementation-review).
It requires explicit parent delegation after implementation and verification;
installing these files adds no watcher, automatic trigger, or CI enforcement.

Both agents request `gpt-6.1-sol` with `high` reasoning. Keep that model unless
a deliberate compatibility change is needed. Account access and runtime
support must be checked on each target machine; a catalog entry alone does
not prove an inference request will succeed. Standalone project definitions
are discovered from `.codex/agents/` by name on supported Codex versions;
this integration does not add role registrations or alter personal config.

Current Codex subagents inherit the parent turn's sandbox and approvals.
The upstream `sandbox_mode = "read-only"` field is retained for fidelity;
it does **not** establish an independent read-only sandbox. Set permissions
on the parent before delegation when an enforced read-only sandbox is needed.
See the [Codex subagent documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents).

The parent must tell review instances not to edit files and to recommend
corrections only. This repository's no-edit review rule governs the upstream
reviewer's broader “implement or recommend” wording. The workflow coordinator
provides a plan; the parent remains responsible for execution, integration,
and verification. Higher-priority runtime limits still govern delegation;
use and disclose the policy's sequential fallback when subagents cannot run.
