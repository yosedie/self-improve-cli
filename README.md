# self-improve-cli

A minimal, cross-platform starter repo for building a lightweight self-improving agentic coding CLI.

The MVP keeps model/provider work optional and improves the surrounding behavior first:
- JSON profile rules
- tool policy
- durable memory/lessons
- growth gates
- event and patch audit logs

## Design goals
- Plain JavaScript only
- No Bash, PowerShell, or AppleScript in the core loop
- Works on Linux, macOS, and Windows
- Manual by default
- Optional auto-apply only when profile growth policy allows it
- Low memory: no Electron, no default indexer, no LSP/embeddings/watchers by default

## What this runs

Current MVP can run an interactive coding chat loop, call local tools, and record observed failures into `.selfimprove/events.jsonl`. Tests validate profile, config, and tool behavior.

## Files
- `AGENTS.md` project rules for agents working in this repo
- `bin/self-improve-cli.js` zero-dependency CLI entrypoint
- `src/profile.js` profile validation, prompt compilation, JSON patch, growth gates
- `src/state.js` `.selfimprove/` state, event log, patch audit, overlay mutation
- `src/config.js` provider/model config in `.selfimprove/config.json`
- `src/provider.js` OpenAI-compatible Chat Completions client
- `src/agent.js` chat loop and tool-call dispatcher
- `src/tools.js` lightweight file read, search, command, and exact edit tools
- `profiles/default.profile.json` immutable default profile template
- `test/profile.test.js` built-in Node tests
- `spec-driven-llm-wiki/` spec-driven project memory

## Manual use
From the repo root:

```bash
npm test
node bin/self-improve-cli.js init
node bin/self-improve-cli.js status
node bin/self-improve-cli.js config show
node bin/self-improve-cli.js profile --prompt
node bin/self-improve-cli.js improve --type failure --message "edited file without reading context first"
node bin/self-improve-cli.js improve --type failure --message "edited file without reading context first" --apply
node bin/self-improve-cli.js self-improve status
node bin/self-improve-cli.js self-improve demo
node bin/self-improve-cli.js self-improve demo --apply
```

Optional local install:

```bash
npm link
sicli status
```

## Chat setup

Set provider config. API key stays in env; it is not written to config.

```bash
node bin/self-improve-cli.js config set model gpt-4o-mini
node bin/self-improve-cli.js config set api_key_env OPENAI_API_KEY
node bin/self-improve-cli.js config set base_url https://api.openai.com/v1
```

Start one-shot chat:

```bash
node bin/self-improve-cli.js chat "read README and summarize this project"
```

Start interactive chat:

```bash
node bin/self-improve-cli.js chat
# or after npm link:
sicli
```

Inside chat, configure provider/model before first prompt. `/connect` asks for API key with hidden input and stores it in `.selfimprove/secrets.json`.

```text
sicli> /connect
sicli> /connect minimax
API key for MiniMax Coding Plan (empty to skip): 
sicli> /connect zai
API key for Z.AI Coding Plan (empty to skip): 
sicli> /key
sicli> /models
sicli> /models MiniMax-M2.7-highspeed
sicli> /models GLM-5.1
sicli> /permissions
sicli> /permissions secure
sicli> /permissions partial_secure
sicli> /permissions ai_reviewed
sicli> /permissions auto_approve
sicli> /self-improve
sicli> /self-improve enable
sicli> /self-improve growth medium --auto-apply true
sicli> /self-improve demo
sicli> /self-improve demo --apply
sicli> /self-improve learn agent repeated bad tool call --apply
sicli> /config
```

Built-in provider presets:

| Provider | Base URL | API key env | Models |
| --- | --- | --- | --- |
| OpenAI Compatible | `https://api.openai.com/v1` | `OPENAI_API_KEY` | `gpt-4o-mini`, `gpt-4.1-mini`, `gpt-4.1` |
| MiniMax Coding Plan | `https://api.minimax.io/v1` | `MINIMAX_API_KEY` | `MiniMax-M2.7`, `MiniMax-M2.7-highspeed` |
| Z.AI Coding Plan | `https://api.z.ai/api/coding/paas/v4` | `ZAI_API_KEY` | `GLM-5.1`, `GLM-5`, `GLM-5-Turbo`, `GLM-4.7`, `GLM-4.5-air` |

Secret storage:

- API keys are stored in `.selfimprove/secrets.json`, never `.selfimprove/config.json`.
- `.selfimprove/` is gitignored.
- CLI applies best-effort permissions: directory `0700`, secret file `0600`.
- `/config` only shows `stored_api_key: true/false`, not the key.
- Env vars still work as fallback, but are no longer required.

File creation uses direct `write_file`, so the model should not use shell redirection like `cat > file` or `printf > file`.

Permission modes:

| Mode | Behavior |
| --- | --- |
| `secure` | Ask before every tool call. |
| `partial_secure` | Allow read/search and git-reversible file writes/edits; ask otherwise. Default. |
| `ai_reviewed` | Clean-context model reviews action tools; asks user if rejected or review fails. Costs extra API calls. |
| `auto_approve` | Autopilot: allow profile-permitted tools until completion. |

Set mode from CLI:

```bash
node bin/self-improve-cli.js permissions secure
node bin/self-improve-cli.js permissions auto_approve
```

Commands that need approval by current permission mode ask interactively unless `--yes` is set:

```bash
node bin/self-improve-cli.js chat --yes "run tests and report result"
```

## Self-improve flow

Self-improve is background harness/profile evolution, not model fine-tuning.

```text
each chat task
→ append trace to .selfimprove/traces.jsonl
→ background reviewer scans new traces
→ failures become .selfimprove/events.jsonl
→ proposed JSON patch
→ .selfimprove/patches.jsonl audit
→ optional apply into .selfimprove/overlay.profile.json
→ future prompts use new profile rules/memory
```

It does not block the main chat flow. The background reviewer runs after tasks when `self_improve_background=true`.

Try it without API key:

```bash
node bin/self-improve-cli.js self-improve status
node bin/self-improve-cli.js self-improve demo
node bin/self-improve-cli.js self-improve demo --apply
node bin/self-improve-cli.js self-improve background-run
node bin/self-improve-cli.js profile --prompt
```

Config knobs:

```bash
node bin/self-improve-cli.js config set self_improve_background true
node bin/self-improve-cli.js config set self_improve_review_every 1
```

Enable automatic profile patching after failures:

```bash
node bin/self-improve-cli.js growth medium --auto-apply true
```

Inside chat:

```text
sicli> /self-improve enable
sicli> /self-improve
sicli> /self-improve demo --apply
```

`/self-improve enable` sets:

```txt
self_improve_background=true
self_improve_review_every=1
growth=medium auto_apply=true
```

Active profile lives in `.selfimprove/base.profile.json` + `.selfimprove/overlay.profile.json`.

## Growth policy


- `none`: no profile mutation
- `low`: propose only; human may apply safe patches
- `medium`: can auto-apply safe rule/memory patches when `auto_apply=true`
- `high`: can also patch style/tool policy
- `very_high`: broader patch surface, still protected from self-escalating growth level

Change local growth level:

```bash
node bin/self-improve-cli.js growth medium --auto-apply true
```

## Coding tools

```bash
node bin/self-improve-cli.js tool read README.md
node bin/self-improve-cli.js tool search profile .
node bin/self-improve-cli.js tool run npm test
node bin/self-improve-cli.js tool write hello.md "# Hello"
node bin/self-improve-cli.js tool edit README.md old_text new_text
```

`tool run` uses `child_process.spawn` with `shell: false`.

## Notes for Windows
This repo avoids platform-specific shell scripts and runs with Node.js on Windows, Linux, and macOS.
