# Meta-Harness Paper Notes

Paper: arxiv 2603.28052 — "Meta-Harness: End-to-End Optimization of Model Harnesses"
Authors: Yoonho Lee, Roshen Nair, Qizheng Zhang, Kangwook Lee, Omar Khattab, Chelsea Finn (Stanford/MIT/KRAFTON)

---

## Core Insight

Existing text optimizers compress feedback too aggressively:
- OPRO: 0.002 MTok/iter (window of past pairs)
- TextGrad: 0.015 MTok/iter (textual feedback)
- AlphaEvolve: 0.022 MTok/iter (program DB + scores)
- GEPA: 0.008 MTok/iter (reflective summaries)
- **Meta-Harness: 10.0 MTok/iter** (all logs and scores)

**Key finding**: Raw execution traces >> compressed summaries. Ablation (Table 3):
- Scores only: median 34.6, best 41.3
- Scores + Summary: median 34.9, best 38.7
- **Meta-Harness (full traces)**: median 50.0, best 56.7

---

## Algorithm 1 (Outer Loop)

```
Input: tasks X, LLM M, proposer P, iterations N
Initialize: population H from baseline harnesses
Initialize: filesystem D = empty (stores code, scores, traces)
for H in H do
    E_H <- Evaluate(H, M, X)
    D <- D union {(H, E_H)}
for t = 1 ... N do
    Proposer P queries filesystem D (inspect prior harnesses + scores)
    Proposer P proposes k new harnesses {H_1, ..., H_k}
    for H in {H_1, ..., H_k} do
        if H passes interface validation then
            D <- D union {(H, Evaluate(H, M, X))}
return Pareto frontier of harnesses in D
```

**Key design**: No parent-selection rule. Proposer can inspect ANY prior harness. This is deliberate — leaves diagnosis to the agent rather than hard-coding search heuristics.

---

## Filesystem Structure (Per Candidate)

```
run_001/
  harness.py          # source code (single-file Python program)
  scores.json         # evaluation metrics
  traces/
    task_001.json    # per-example execution trace (raw prompts, tool calls, outputs)
    task_002.json
    ...
```

- Proposer reads median **82 files per iteration** (41% source code, 40% traces, 6% scores, 13% other)
- Referenced over 20 prior candidates per step
- Single evaluation can produce up to **10M tokens** of diagnostic information

---

## Proposer Interface

Minimal domain-specific **skill** (guidance for Claude Code proposer):
- Where to write new harnesses
- How to inspect previous harnesses and execution traces
- What files it CANNOT modify
- Role: agentic coding tool with developer tools + filesystem access via grep/cat

**What proposer does NOT receive:**
- No fixed prompt assembled by outer loop
- No pre-digested summaries
- No parent-selection heuristics
- Its only feedback: search-set evaluations + execution traces from those runs

**What proposer DOES receive:**
- Full filesystem access to all prior candidate code, scores, and traces
- Decides itself what to inspect (selective filesystem queries via grep/cat)

---

## Three Experimental Domains

### 1. Online Text Classification (GPT-OSS-120B)
- 3 datasets: LawBench (215 classes), Symptom2Disease (22), USPTO-50k (180)
- Meta-Harness: 48.6% accuracy (+7.7 over ACE) using 11.4K context tokens (vs 50.8K ACE)
- Pareto frontier: accuracy vs context tokens

### 2. Retrieval-Augmented Math Reasoning
- 250-problem search set (OlympiadBench + Omni-MATH hard)
- 200 held-out IMO-level problems
- **+4.7 points average across 5 held-out models**
- Meta-harness discovers retrieval policy that outperforms BM25

### 3. TerminalBench-2 Agentic Coding (89 tasks)
- Opus 4.6: 76.4% (#2 on leaderboard, surpasses Terminus-KIRA at 74.7%)
- Haiku 4.5: 37.6% (#1 among Haiku agents)
- Key discovered: bootstrap with env snapshot before agent loop

---

## Appendix D: Practical Implementation Tips

1. **Write a good skill** — primary interface. Specifies forbidden behaviors, required artifacts, objectives. Iterating on skill > changing iteration count or population size. Run 3-5 short evolution runs to debug skill first.

2. **Start with baseline + hard search set** — simple baseline, filter search set for examples baseline gets wrong. Keep search set small (~50 evaluations per run).

3. **Log everything in queryable format** — JSON, hierarchical organization, consistent naming, regex-friendly filenames.

4. **Small CLI for logs** — list Pareto frontier, show top-k harnesses, diff code/results.

5. **Lightweight validation before expensive benchmarks** — small test script imports module, instantiates class, calls methods on tiny set. Catches malformed candidates in seconds.

6. **Automate evaluation outside proposer** — separate harness scores candidates. Proposer should not do evaluation.

---

## Key Terminology

| Term | Definition |
|------|-----------|
| **Harness** | Code that wraps a fixed base model — determines what context model sees at each step |
| **Inner loop** | One task execution: harness constructs prompts, model responds, harness updates state |
| **Outer loop** | Search over harness candidates using feedback from inner loop runs |
| **Search set** | Task instances used to evaluate candidate harnesses during search |
| **Pareto frontier** | Set of harnesses where no objective (e.g., accuracy) can be improved without worsening another (e.g., context cost) |
| **Interface validation** | Checks that a candidate harness is structurally sound before expensive evaluation |
| **Proposer** | Coding agent that reads filesystem of prior candidates and proposes new ones |

---

## Relevance to self-improve-cli

- self-improve-cli IS a coding harness (agent.js wraps the model)
- The outer loop (self-improve propose) needs tool access to read raw traces + prior harness code
- Current traces.jsonl is too shallow — needs raw tool arguments + responses
- Current outer loop uses regex heuristics — needs model-driven diagnosis
- `evaluateAppliedPatch` calls `recordFailedPatch` but NOT `rollbackToBackup`
- Backup chain (.bak.0, .bak.1, .bak.2) not yet implemented
- Candidate storage structure exists (`.selfimprove/candidates/`) but empty

---

## What Makes Meta-Harness Work

1. **Filesystem as feedback channel** — not lossy compression, proposer selectively inspects
2. **No parent-selection rule** — proposer free to build on any prior candidate
3. **Raw traces** — the actual evidence for diagnosis, not summaries
4. **Minimum outer-loop structure** — diagnosis delegated to proposer
5. **Coding agent as proposer** — aligned with read/write/execute workflows
6. **Interface validation** — cheap sanity check before expensive benchmark run
