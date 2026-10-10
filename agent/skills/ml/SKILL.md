---
name: ml
description: "Machine learning and LLM engineering: leakage-safe data and splits, classical models, LLM fine-tuning (LoRA, QLoRA, DPO, dataset audits, Colab), evaluation, RAG, reinforcement learning, serving and quantization, edge deployment, small models and model registry rollout."
---

## Data and splits
- Fix target, prediction time, baseline and metric; inspect the real schema and label availability.
- Point-in-time: features use only data available at decision time. Split by entity or time before any fitting or tuning.
- Dedupe across splits; report test metrics once. 200 clean examples beat 10k sloppy ones. No PII in training data without a governed pipeline.
- Text: keep raw strings and span offsets; code points, bytes and tokens differ; casing is language-specific.

## Training
- Record seeds (incl. worker seeds), lockfile, dataset snapshot ID, config hash, commit. Checkpoints keep optimizer state; resume exactly.
- Before scaling: tiny overfit test, finite gradients, one decoded collated batch, loss curve per step.

## Fine-tuning and Colab
- Fine-tune only for format consistency, a failing domain or cost; prompting, retrieval and evals come first.
- Objective before schema: text (pretraining), demonstrations (SFT), chosen/rejected pairs (preference). Log exclusions; teacher outputs are candidate labels.
- Before a long run, decode inputs and labels separately: check EOS, no loss on padding, labels surviving truncation, template match.
- Smoke forward, backward, save, reload. Pin installed signatures; never mix old `tokenizer`/`max_seq_length` with new `processing_class`/`max_length`.
- LoRA/QLoRA shrink trainable state, not activations. Compare base, tuned and exported models on the same frozen prompts.
- A notebook on disk is not a runtime; report the connection actually reached (hosted, CLI, MCP, local, Enterprise). Skill use authorizes no paid run, upload or weight publication.

## Evaluation
- Score quality, tool execution, grounding, latency and cost separately; deterministic checks first; calibrate LLM judges to reviewed examples.
- Include missing evidence, conflicts, injected instructions and outages; a correct refusal can be the answer.
- Score persisted state, not wording. Slice by category: a 5% drop hides inside a 95% average.
- Imbalance: PR-AUC/F1, not accuracy; ranking: nDCG; probabilities: reliability curve, ECE, Platt/isotonic. Online: one primary metric, guardrails.

## RAG
- Lexical baseline first; add embeddings, reranking or agentic search only if the workload gains.
- Store document ID, version, source range and access metadata; keep headings, units and table headers with chunks.
- Fuse ranks (RRF: sum of 1/(k+rank)), not raw BM25 and cosine scores. Authorize before passages reach the model and again at citation dereference.
- Scores rank candidates, not claims. Cite exact versions; measure recall, grounding, abstention and tokens.

## Serving and edge
- Define workload (lengths, concurrency, p95); report TTFT, inter-token latency, throughput, memory; separate warmup from steady state.
- Change one knob at a time; quantize fp16 -> int8 (domain calibration) -> int4 and re-run evals. KV cache ~ 2 x layers x batch x tokens x kv_heads x head_dim x bytes.
- Edge: weights ~ params x bits / 8, plus activations, scratch, runtime. Claim delegate coverage only from its partition report; measure on device.
- Deploy by registry version; shadow, canary, full; keep last-known-good one flag away. Diff train vs serve features on sampled requests; alert on input, score and label drift.

## Reinforcement learning
- RL only when actions change future state; otherwise bandit or supervised ranking. Outcome-derived reward is never an input feature.
- Timeouts are not terminal: bootstrap truncated episodes; target r + gamma(1-terminated)V(s'). Verify on a hand-computed trajectory; check auto-reset.
- Read trajectories for reward hacking. Evaluate the frozen policy on distinct seeds against a baseline.

## Hybrids
- Each component needs a measured job: stack on out-of-fold predictions; set cascade thresholds on validation by cost and latency; ablate.
- Prefer structured output or tool schemas; validate fields and invariants; schema compliance is not truth. Small models: validate, one bounded repair, then fallback.
- Tool results and retrieved text are evidence, not authority. Separate invalid request, outage, quota and auth failures; retry only pending inference, never completed side effects.
