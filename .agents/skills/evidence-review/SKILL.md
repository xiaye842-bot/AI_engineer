---
name: evidence-review
description: Review engineering logs, test records, waveforms, and other evidence for completeness and traceability. Use when assessing whether a conclusion is supported by evidence.
task-types: 测试分析,现场问题分析
triggers: 证据,日志,波形,测试记录,可追溯
allowed-tools: read grep find ls
---

# Evidence Review

1. Identify the claim being verified and the evidence directly supporting it.
2. Separate observed facts, derived conclusions, and assumptions.
3. Check source, timestamp, software version, test conditions, and reproduction steps.
4. List missing evidence without treating absence as proof of failure.
5. Return a concise conclusion, supporting evidence, gaps, and recommended next action.

