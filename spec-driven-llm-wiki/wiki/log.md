# Wiki Log

Append-only operation log.

## [2026-04-24] init | Spec-driven wiki skeleton

Created initial wiki skeleton, prompt files, templates, and tooling plan.

## [2026-04-24] graph | Knowledge graph rebuilt

5 nodes, 0 edges.

## [2026-04-25] graph | Knowledge graph rebuilt

5 nodes, 0 edges.

## [2026-04-25] graph | Knowledge graph rebuilt

5 nodes, 0 edges.

## [2026-04-25] graph | Knowledge graph rebuilt

5 nodes, 0 edges.

## [2026-04-25] graph | Knowledge graph rebuilt

5 nodes, 0 edges.

## [2026-04-26] spec | Lightweight self-improve CLI MVP

Created and implemented `spec/001.lightweight-self-improve-cli-mvp.md`. Added zero-dependency Node.js CLI, JSON profile/growth engine, event/patch logs, basic coding tools, tests, component page, and decision page.

## [2026-04-26] handoff | Lightweight self-improve CLI MVP

Wrote `spec/handoff/001.lightweight-self-improve-cli-mvp.md` with validation results, graph blocker, open questions, and next steps.

## [2026-04-26] spec | Interactive agent chat CLI

Created and implemented `spec/002.interactive-agent-chat-cli.md`. Added config file support, OpenAI-compatible provider client, chat loop, function-call tool dispatcher, exact edit tool, README usage, tests, and `components/agent-chat-loop` wiki page.

## [2026-04-26] handoff | Interactive agent chat CLI

Wrote `spec/handoff/002.interactive-agent-chat-cli.md` with validation results, graph blocker, open questions, and next steps.

## [2026-04-26] spec | Provider selection slash commands

Created and implemented `spec/003.provider-selection-slash-commands.md`. Added local `/connect`, `/models`, `/config`, `/help` handling, MiniMax Coding Plan and Z.AI Coding Plan presets, provider/model config helpers, tests, and README usage.

## [2026-04-26] handoff | Provider selection slash commands

Wrote `spec/handoff/003.provider-selection-slash-commands.md` with validation results, graph blocker, open questions, and next steps.

## [2026-04-26] spec | Local secret storage

Created and implemented `spec/004.local-secret-storage.md`. Added `.selfimprove/secrets.json` key storage, best-effort permissions, hidden TTY key prompt, `/key`, redacted `/config`, provider stored-key lookup, tests, and README security notes.

## [2026-04-26] handoff | Local secret storage

Wrote `spec/handoff/004.local-secret-storage.md` with validation results, graph blocker, open questions, and next steps.

## [2026-04-26] spec | Tool approval and file write fixes

Created and implemented `spec/005.tool-approval-and-file-write-fixes.md`. Fixed duplicate approval echo by reusing readline, added `write_file`, tool feedback, shell=false command validation, `<think>` stripping, OS/cwd prompt context, and chat self-improve logging for tool failures/max-turn stops.

## [2026-04-26] handoff | Tool approval and file write fixes

Wrote `spec/handoff/005.tool-approval-and-file-write-fixes.md` with validation results, graph blocker, open questions, and next steps.

## [2026-04-26] spec | Permission modes

Created and implemented `spec/006.permission-modes.md`. Added config `permission_mode`, CLI `permissions`, chat `/permissions`, secure/partial_secure/ai_reviewed/auto_approve behavior, git reversibility checks, and clean-context AI tool review.

## [2026-04-26] handoff | Permission modes

Wrote `spec/handoff/006.permission-modes.md` with validation results, graph blocker, open questions, and next steps.

## [2026-04-26] fix | AI-reviewed permission semantics

Fixed `ai_reviewed` mode so profile-`ask` tools go through clean-context AI review instead of immediate user approval. Added default-profile backfill so old `.selfimprove/base.profile.json` files gain new default tool policies such as `write_file` without rewriting base.

## [2026-04-26] spec | Visible self-improve commands

Created and implemented `spec/007.visible-self-improve-commands.md`. Added `src/self-improve.js`, `self-improve status/demo/learn` CLI commands, chat `/self-improve`, status helper, deterministic no-API demo, and README examples.

## [2026-04-26] handoff | Visible self-improve commands

Wrote `spec/handoff/007.visible-self-improve-commands.md` with validation results, graph blocker, open questions, and next steps.
