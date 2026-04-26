---
title: "Agent Chat Loop"
type: component
tags: [chat, provider, tools]
last_updated: 2026-04-26
---

# Agent Chat Loop

`[[components/agent-chat-loop]]` tracks interactive and one-shot coding chat support.

## Responsibilities

- Start `sicli chat` REPL or run `sicli chat "prompt"` one-shot tasks.
- Load active profile from `[[components/lightweight-cli-core]]`.
- Load `.selfimprove/config.json` provider settings.
- Call OpenAI-compatible Chat Completions via native `fetch`.
- Expose local tools as function-call schemas.
- Enforce profile tool policy: `allow`, `deny`, `ask`.
- Handle local slash commands before provider calls: `/connect`, `/models`, `/config`, `/help`, `/exit`.
- Keep session history small and in memory only.

## Tools

- `read_file`: capped UTF-8 file read.
- `search`: literal workspace search, skipping heavy directories.
- `run_command`: `spawn` with `shell: false`; no shell redirection/pipes/heredocs.
- `write_file`: direct UTF-8 file creation/overwrite.
- `edit_file`: exact unique text replacement.

## Provider Presets

- OpenAI Compatible: `https://api.openai.com/v1`, `OPENAI_API_KEY`, models `gpt-4o-mini`, `gpt-4.1-mini`, `gpt-4.1`.
- MiniMax Coding Plan: `https://api.minimax.io/v1`, `MINIMAX_API_KEY`, models `MiniMax-M2.7`, `MiniMax-M2.7-highspeed`.
- Z.AI Coding Plan: `https://api.z.ai/api/coding/paas/v4`, `ZAI_API_KEY`, models `GLM-5.1`, `GLM-5`, `GLM-5-Turbo`, `GLM-4.7`, `GLM-4.5-air`.

## Constraints

- API keys stored only in `.selfimprove/secrets.json`, not config.
- Secret file uses best-effort permissions: directory `0700`, file `0600`.
- `/config` redacts secrets and shows only `stored_api_key`.
- No dependency added.
- No TUI, watcher, indexer, LSP, or embeddings.
- Chat and tool approvals share one readline instance to avoid duplicate echo.
- Tool failures and max-turn stops are logged into `.selfimprove/events.jsonl` and `.selfimprove/patches.jsonl` for self-improvement.
- Visible self-improve commands: `self-improve status`, `self-improve demo`, `self-improve learn`, `self-improve background-run`, and chat `/self-improve`.
- Chat task traces are appended to `.selfimprove/traces.jsonl`; background reviewer scans new traces without blocking chat.
- Permission modes: `secure`, `partial_secure`, `ai_reviewed`, `auto_approve`.
- `partial_secure` allows only read/search and git-reversible file writes/edits without asking.
- `ai_reviewed` uses a clean-context reviewer call for action tools and asks user on denial/error.

## Related

- [[components/lightweight-cli-core]]
- [[002.interactive-agent-chat-cli]]
