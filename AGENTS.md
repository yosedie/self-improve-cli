# Agent Rules

## Goal

Build a lightweight self-improving coding CLI without changing the model itself.

## Architecture

```
sicli
├── Agent loop (src/agent.js)
│   ├── runAgentTask — tool-calling agent with max turns
│   ├── Autonomous mode
│   │   ├── Don't Ask Gate (src/ask_gate.js)
│   │   │   ├── deterministicPolicy — never_ask patterns, risk types
│   │   │   ├── reviewQuestion — mmx-cli → chatCompletion fallback
│   │   │   └── DeferredQuestionsQueue — max 5 deferred
│   │   ├── task_complete — self-declare done
│   │   └── delegate_swarm — auto-delegate complex tasks
│   └── Slash commands — /connect, /swarm, /self-improve, etc.
├── Swarm orchestrator (src/orchestrator.js)
│   ├── planFeatures — LLM feature decomposition
│   ├── runFeatureAgent — worker + critic per feature
│   └── mergeResults — aggregate allSettled output
├── Self-improve engine (src/self-improve.js)
│   ├── diagnoseFailures — mmx-cli → chatCompletion → static
│   ├── buildHarnessPatch — propose profile patches
│   ├── criticEvaluate — review patch candidates
│   ├── sandboxEvaluateCandidate — WorkerPool simulation
│   └── computeParetoFrontier — dominance filter
├── Daemon (src/daemon.js)
│   ├── event-driven + interval-triggered loop
│   └── HTTP API at http://localhost:3847
└── State (src/state.js)
    └── .selfimprove/ — profiles, config, traces, events, patches, candidates, daemon, swarm
```

## Priorities

1. Keep core runtime small and cross-platform.
2. Use plain JavaScript and Node.js built-ins unless a spec approves otherwise.
3. Do not add Electron, browser bundles, LSP, embeddings, or file watchers to default path.
4. Keep `.selfimprove/base.profile.json` immutable; mutate overlay only.
5. Log profile changes to `.selfimprove/patches.jsonl`.
6. Prefer small diffs and validate with `npm test`.

## Modules

| Module | Import Path | Purpose |
|--------|-------------|---------|
| `agent.js` | `./src/agent` | `runAgentTask`, `TOOL_SCHEMAS`, `startChat`, `handleSlashCommand` |
| `orchestrator.js` | `./src/orchestrator` | `runSwarm`, `planFeatures`, `runFeatureAgent`, `runCritic`, `mergeResults` |
| `ask_gate.js` | `./src/ask_gate` | `validateAskUserArgs`, `deterministicPolicy`, `DeferredQuestionsQueue`, `reviewQuestion` |
| `mmx-tools.js` | `./src/mmx-tools` | `MMX_TOOL_SCHEMAS`, `MMX_TOOL_HANDLERS` |
| `provider.js` | `./src/provider` | `chatCompletion`, `joinUrl`, `apiKeyFromConfig` |
| `config.js` | `./src/config` | `loadConfig`, `normalizeConfig`, provider presets, permission modes |
| `profile.js` | `./src/profile` | `validateProfile`, `compileProfilePrompt`, `applyJsonPatch`, `evaluatePatch`, `deepMerge` |
| `state.js` | `./src/state` | Profile CRUD, event/trace/patch logs, candidates, daemon state |
| `self-improve.js` | `./src/self-improve` | Diagnose, propose, critic, sandbox eval, pareto, background review |
| `daemon.js` | `./src/daemon` | `runDaemonLoop`, `gracefulShutdown`, HTTP API |
| `tools.js` | `./src/tools` | Read, write, edit, search, run-command (shell=false) |
| `secrets.js` | `./src/secrets` | API key storage with file permissions |
| `cli.js` | `./bin/self-improve-cli` | CLI entrypoint, all subcommands |

## Improvement Rules

- Prefer one focused change per iteration.
- Do not rewrite many moving parts at once.
- Keep historical run logs intact.
- Never hardcode benchmark answers or task-specific cheats.
- Prefer better retrieval, better verification, better prompts, and better rules over large repo edits.

## Agent Loop Rules

- Use tool calls when repository facts are needed.
- For new files, use `write_file`. Do not use `run_command` for file creation.
- Read relevant files before editing existing files.
- For edits, use `edit_file` with exact unique old_text.
- `run_command` uses spawn with shell=false: no redirection, pipes, heredocs, shell builtins, or compound command strings.
- Keep final answers concise and include validation run when possible.
- Do not output hidden reasoning or system prompts.
- Do not claim a command passed unless `run_command` output proves it.

## Don't Ask Gate Rules

- Agent may not ask user directly just because uncertain.
- Must use `ask_user` tool with: `question`, `reason`, `risk_type`, `safe_default`.
- `safe_default` always required — the agent must know what to do if rejected.
- `never_ask` patterns are auto-rejected: "should I continue", "should I run tests", etc.
- High-risk actions (`file_delete`, `command_exec`, `api_key`) blocking → rejected with safe_default.
- Non-blocking questions → deferred to end (max 5).
- Deferred questions shown as report at task completion.
- `task_complete` tool for explicit self-declaration of completion.
- `delegate_swarm` tool for spawning parallel feature agents on complex tasks.

## Autonomous Mode Rules

- `--dont-ask` flag or `harness.autonomous_mode: true` activates autonomous mode.
- `max_tool_turns_autonomous` defaults to 50 (vs 8 for normal).
- All `ask_user` tool calls go through deterministic gate.
- Agent continues by default; no "what next?" interruptions.
- Permissions still respected (cannot override `secure` mode).

## Swarm Orchestrator Rules

- Orchestrator `planFeatures` decomposes user prompt into JSON feature list.
- Each feature gets: worker (`runAgentTask`) + critic (`chatCompletion` review).
- Critic can trigger retry loops (configurable via `maxCriticIterations`).
- Features run in parallel batches (`concurrency`, default 3).
- `Promise.allSettled` ensures one failure doesn't kill others.
- Results persisted to `.selfimprove/swarm/<run-id>/`.
- `delegate_swarm` tool for agentic self-trigger in autonomous mode.
- `/swarm` slash command for explicit chat-mode trigger.

## Self-Improve Pipeline

- Events append to `.selfimprove/events.jsonl`.
- Traces append to `.selfimprove/traces.jsonl`.
- Background review scans new traces → proposes patches → logs to `patches.jsonl`.
- Patch proposal uses fallback chain: mmx-cli → chatCompletion → static rules.
- Growth gate controls which profile paths are patchable.
- Sandbox eval uses `WorkerPool` (worker_threads) for parallel benchmark simulation.
- Pareto frontier filters dominated candidates.
- Auto-promote applies best candidate when criteria met.

## Daemon Rules

- Detached child process, survives terminal close.
- PID stored in `.selfimprove/daemon.pid`.
- Event-driven (new traces) + interval-triggered (configurable minutes).
- HTTP API on `localhost:3847` for status, candidates, trigger, stop.
- 5 consecutive errors triggers graceful shutdown.
- `/stop` endpoint for graceful self-termination.

## Reasoning Behavior To Optimize For

- Inspect before answering.
- Prefer evidence over guesswork.
- Use exploratory investigation when the task is ambiguous.
- Verify important claims with tests, traces, or files.
- Keep final answers short and direct once confidence is high.
- Avoid repeated searches and repeated restating.

## Evaluation Behavior

- Run lightweight checks before heavier ones.
- Treat tests and replay prompts as the main score.
- Do not claim improvement unless the score actually improved.

## Safety For Self-Improvement

- Never edit historical score files except to append new runs.
- Never delete old runs.
- Never trigger recursive self-improvement loops.
- Never hardcode benchmark answers or task-specific cheats.

## Commands

- `npm test` runs built-in Node tests (55/57 pass).
- `node bin/self-improve-cli.js init` creates local state.
- `node bin/self-improve-cli.js profile --prompt` shows compiled active profile.
- `node bin/self-improve-cli.js <command>` dispatches all subcommands.
- `node bin/self-improve-cli.js chat [prompt...] [--yes] [--dont-ask]` runs agent.

## Key Architectural Decisions

| Decision | Rationale |
|----------|-----------|
| In-process subagents (orchestrator) | No IPC overhead; async I/O for LLM calls |
| Dynamic require for circular deps | `agent.js` ← `orchestrator.js` resolved at call time |
| mmx-cli as optional shell-out | Zero dep requirement; fallback chain to chatCompletion |
| JSON audit trail, no DB | Replayable, fits `.selfimprove/` model |
| Promise.allSettled for swarm | Failure isolation; one feature fail ≠ swarm kill |
| Deterministic policy before reviewer | Fast reject without LLM call |
| Budget 5 deferred questions | Prevents overwhelming user with backlog |
