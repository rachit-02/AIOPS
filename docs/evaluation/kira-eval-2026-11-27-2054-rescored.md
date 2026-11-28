# Kira evaluation — kira-eval-2026-11-27-2054 (re-scored)

- Model: `ollama:qwen2.5:7b` · commit `1fa1164` · 5 run(s) per scenario · question window: last 5m
- Re-scored 2026-11-28T12:48:33.335Z with the corrected scorer (`scripts/eval-kira/score.js`) from the saved answers; no fault was re-run. Original kept as `kira-eval-2026-11-27-2054.md` / `kira-eval-2026-11-27-2054.csv`.
- Answers read from: 34 trace file(s), 0 fixture cop(ies); 1 row(s) had no answer and keep their original verdict.
- **Raw accuracy 19/35 (54%) → corrected 26/35 (74%)**; 7 verdict(s) changed. See "Scorer fix" in [README](README.md).

## Corrected results

| Scenario | Expected | Runs | Correct | Accuracy | Mean score /4 | Mean time to diagnosis | Time to visible | Notes |
|---|---|---|---|---|---|---|---|---|
| HEALTHY | — / none | 5 | 5 | 100% | 4.00 | 73 s | 0 s | all checks passed |
| F1 | order / code-bug | 5 | 4 | 80% | 3.20 | 76 s | 54 s | no answer: Ollama returned 500: {"error":"model runner has unexpectedly stopped, this may be due to resource limitations or an internal error, check ollama server logs for details: CUDA error: out of memory\nCUDA error"} |
| F2 | product / latency | 5 | 0 | 0% | 2.00 | 61 s | 56 s | origin: expected product not named in Root cause and no (origin) marker; category: expected latency, got none; no expected evidence cited |
| F3 | user / crash-loop | 5 | 4 | 80% | 3.80 | 71 s | 26 s | category: expected crash-loop, got bad-config |
| F4 | auth / out-of-memory | 5 | 3 | 60% | 3.60 | 57 s | 87 s | wrong services in blast radius: user |
| F5 | orders / bad-config | 5 | 5 | 100% | 4.00 | 74 s | 26 s | all checks passed |
| F6 | gateway / bad-deploy | 5 | 5 | 100% | 4.00 | 63 s | 16 s | all checks passed |
| **Overall** | | **35** | **26** | **74%** | | | | |

## Verdicts changed by the scorer fix

| Scenario | Run | Raw | Corrected | Raw reason | Warnings |
|---|---|---|---|---|---|
| F1 | 3 | WRONG | CORRECT | origin: expected order, marked order | no Root cause section (format) |
| F4 | 4 | WRONG | CORRECT | origin: expected auth, marked auth | no Root cause section (format) |
| F4 | 5 | WRONG | CORRECT | origin: expected auth, marked auth | no Root cause section (format) |
| F5 | 1 | WRONG | CORRECT | origin: expected orders, marked orders |  |
| F6 | 3 | WRONG | CORRECT | origin: expected gateway, marked gateway | no Root cause section (format) |
| F6 | 4 | WRONG | CORRECT | origin: expected gateway, marked gateway | no Root cause section (format) |
| F6 | 5 | WRONG | CORRECT | origin: expected gateway, marked gateway | prose also calls order the origin; no Root cause section (format) |

## Remaining failures

| Scenario | Run | Score | Reason | Warnings |
|---|---|---|---|---|
| F1 | 4 | 0/4 | no answer: Ollama returned 500: {"error":"model runner has unexpectedly stopped, this may be due to resource limitations or an internal error, check ollama server logs for details: CUDA error: out of memory\nCUDA error"} |  |
| F2 | 1 | 1/4 | origin: expected product not named in Root cause and no (origin) marker; category: expected latency, got none; no expected evidence cited |  |
| F2 | 2 | 3/4 | category: expected latency, got none | no Root cause section (format) |
| F2 | 3 | 2/4 | origin: expected product not named in Root cause (no Root cause section) and no (origin) marker; category: expected latency, got none | no Root cause section (format) |
| F2 | 4 | 2/4 | origin: expected product not named in Root cause (no Root cause section) and no (origin) marker; category: expected latency, got none | no Root cause section (format) |
| F2 | 5 | 2/4 | origin: expected product not named in Root cause (no Root cause section) and no (origin) marker; category: expected latency, got none | no Root cause section (format) |
| F3 | 1 | 3/4 | category: expected crash-loop, got bad-config |  |
| F4 | 1 | 3/4 | wrong services in blast radius: user | no Root cause section (format) |
| F4 | 3 | 3/4 | wrong services in blast radius: user |  |
