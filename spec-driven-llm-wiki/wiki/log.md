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

## [2026-04-28] wiki | Batch wiki expansion — all modules documented

Added 11 component pages: swarm-orchestrator, autonomous-mode-ask-gate, mmx-tools, provider-client, config-manager, profile-engine, state-manager, self-improve-engine, daemon, coding-tools, secrets-storage.

Added 5 decision pages: in-process-subagents, deterministic-policy-before-reviewer, fallback-chain-pattern, json-audit-trail, promise-allsettled-swarm.

Added 5 pattern pages: fallback-chain, worker-pool-sandbox, pareto-frontier, deferred-questions, growth-gate.

Updated wiki/index.md and wiki/overview.md with all new pages.

Rewrote AGENTS.md from 181 to 585 lines: added REVIEW workflow, HANDOVER workflow, Graph Schema, Wikilink Syntax, Wiki Page Conventions, Spec Conventions, Parent Project Integration, Agent-Specific Integrations, Configuration, Failure Recovery, Testing, Log Format sections.

## [2026-04-28] spec + implement | MCP + Skills integration (specs 009/010/011)

Created specs:
- `spec/009.mcp-protocol-client.md` — MCP protocol client with stdio + HTTP transport, tool bridge, agent integration
- `spec/010.mcp-commands.md` — /mcp chat commands + CLI subcommands for MCP server management
- `spec/011.skills-system.md` — Skills discovery (6 dirs), SKILL.md parsing, tool registration, /skills commands

Implemented:
- `src/mcp-transport.js` — StdioTransport (JSON-RPC Content-Length framing), HTTPTransport (POST + env interpolation)
- `src/mcp-client.js` — MCPClient (init/tools/list/call), MCPManager (multi-server), convertInputSchema, buildMcpToolBridge
- `src/skills.js` — discoverSkills, parseSkillFrontmatter, loadSkill, enableSkill, disableSkill, getSkillTools
- Modified `src/state.js` — loadMcpConfig, saveMcpConfig, getActiveSkills, setActiveSkills, init mcp.json
- Modified `src/agent.js` — MCP+skills tool merging in runAgentTask, /mcp and /skills slash commands, skills prompt injection
- Modified `bin/self-improve-cli.js` — mcp add/remove/list, skills list/enable/disable CLI subcommands

Tests: 74/76 pass (19 new tests, 2 pre-existing failures). No regressions.

## [2026-04-28] fix | P0 bug fixes + spec status cleanup

Fixed critical bugs:
- `src/skills.js` `parseSkillFrontmatter` — closing `---` now matched on own line only (was matching `---` anywhere in body)
- `src/skills.js` `discoverSkills` — dedup now uses parsed skill `name` not directory `entry.name`
- `src/skills.js` `loadSkill` — handlers.js only loaded from project-local dirs; global skills with handlers.js get security warning
- `src/agent.js` `/mcp reload` — implemented actual reconnect (loads config, creates MCPManager, discovers, prints status, cleans up)
- `.gitignore` — added `session-*.md` and `pi-session-*.html` to prevent accidental commit of session data
- `test/self-improve.test.js` — fixed 2 failing tests: test data used `args`, implementation reads `raw_args`
- `test/mcp-skills.test.js` — added test for `---` inside body frontmatter edge case

Spec status updates (all 11 specs):
- 001-007: `IMPLEMENTED` → `COMPLETED`
- 008-011: `DRAFT` → `COMPLETED`

Result: 77/77 tests pass, 0 failures, 0 regressions.
