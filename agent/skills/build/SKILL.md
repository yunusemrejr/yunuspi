---
name: build
description: "Code, systems, APIs, data and ML — one short method for building and verifying software."
---

# Build — code, systems, data, ML

- Follow the existing owner and conventions; smallest general fix; read the exact region before editing.
- Parse unknown input into typed values at boundaries; one writer per contended state.
- Test public behavior: happy path, one failure, one boundary. Rerun after the last edit and state what is unverified.
- Profile before optimizing; report p95/p99, never averages alone.
- Git: never commit/push/rewrite history unless asked. Databases: safe migrations, explicit transactions.
- ML: leakage-safe splits, calibrated metrics, no silent model swaps — the picked model runs the work.
