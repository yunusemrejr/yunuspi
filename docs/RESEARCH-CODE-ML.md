# Research, code and ML controls

These tools provide executable checks and reusable evidence independently of the
selected model. A smaller model can follow the same explicit contracts; a stronger
model can combine them with the full existing toolkit. They do not change the
selected provider, model, thinking mode or budget. Deterministic checks cannot
guarantee reasoning quality or eliminate every edge case.

## Research

`web_research` keeps two paced workers, cancellation, a ten-minute deadline and
session-owned handles. `readPages` and `sourceUrls` accept up to 24 sources; the
default remains three. Source receipts include a SHA256, original character count
and query-ranked extractive windows with exact offsets/lines. Useful text beyond
the page opening can reach the model without repeating the whole page. Use the
receipt's `responseId` with `get_search_content` for full cached context. A hash
identifies retrieved bytes, not publisher authenticity. Passage ranking analyzes
at most the first two million characters; `analyzedChars` and `analysisTruncated`
disclose that boundary while the hash/count identify the full retrieved text.

For synthesis, save one attributable JSON collection in the workspace:

```json
{
  "goal": "Compare the measured throughput and its limits",
  "sources": [{"id":"s1","url":"https://example.org/results","kind":"primary","text":"Throughput was 20 requests per second.","retrievedAt":"2026-10-06T09:00:00Z"}],
  "claims": [{"id":"c1","text":"The recorded test measured 20 requests per second.","citations":[{"sourceId":"s1","quote":"Throughput was 20 requests per second.","relation":"supports"}]}]
}
```

Call `research_toolkit` with `action:dossier,path:research.json`. It verifies exact
quotes and optional expected SHA256, exposes missing or changed citations,
groups identical URLs/text snapshots, and retains conflicting citation labels.
Four source/claim rows are paginated with `offset`; `view:report` returns attributed
Markdown. Inline input permits 32 sources, 32 claims, 64,000 characters per source
and 512,000 aggregate characters; workspace files have a 256 KiB limit. No remote
fetch or model call occurs. Caller-supplied primary/secondary and
supports/contradicts labels still need review: a matched quote cannot settle its
context, truth, dates, units or semantic support. Dates omitted by the caller stay
unknown. Report truncation is explicit.

## Code baseline

`code_quality` operation `baseline` indexes the requested source scope once,
combines DRY groups with changed-source slop/security/backend/UI cues and lexical
import structure, and records a source fingerprint plus omitted coverage.
`changed:true` compares changed files with unchanged source candidates; `base`
selects the Git comparison. Use individual operations for deeper inspection.
Security patterns and structural orphans are review cues, not certified defects.

Successful write/edit hooks compare new logic with recent edits, directory
neighbors and bounded cross-directory candidates. Git file listing falls back to
a small breadth-first walk for non-Git projects. Generated/vendor/fixture files
are excluded. Snapshot reads refuse outside-workspace paths, oversized or changing
files and invalid encodings; cancellation is honored by the full source walker.
The small edit budget does not cover the entire project: use the explicit DRY
operation before a consequential refactor.

The existing syntax checker, installed project linters/LSP diagnostics, debugging
reproducer, source audits and tests remain separate tools. Source-audit workflows
add a revision-bound `source-quality` stage. Actual interface pixels, contrast,
keyboard/focus and state checks continue to use the existing UI owners. A source
baseline does not replace types, runtime tests, security review or rendered UI.

## ML lab

`ml_lab` provides five deterministic operations and one executable recipe lookup:

| Operation | Evidence |
| --- | --- |
| `preflight` | Observed host memory/CPU and explicit weight/optimizer lower bounds; excludes activations, allocator and other processes. |
| `split_audit` | Unique ids, normalized text/exact feature duplicates, group overlap, optional chronological bounds and classification-label coverage. |
| `evaluate` | Aligned classification accuracy/macro-F1 or regression MAE/RMSE/R2, up to 32 slices, a paired baseline difference and seeded bootstrap interval. |
| `rl_targets` | One-step Bellman targets; true termination masks bootstrap, external truncation preserves final-observation bootstrap. |
| `notebook` | Seven tagged stages, ordering, placeholders, stored errors and execution counts; connected runtime stays unverified. |
| `recipe` | Shipped trainer path/hash, validation/smoke/resume argv and staged Colab notebook for `tiny_mlp`, `tabular_q`, `embedding` or `lora`. |

Inputs can be inline or workspace JSON/ipynb snapshots up to 256 KiB. Evaluation
arrays and split samples accept up to 10,000 cases; findings are bounded with
omitted counts. Paired bootstrap assumes independent cases; correlated groups or
time series require a group/block method. It measures supplied predictions and
does not run an arbitrary model.

Tool text pages targets/findings in 64-row slices and class metrics in 32-row slices using
`offset`/`nextOffset`, with a 24,000-character output budget. Group slices show
aggregate metrics; pass one slice of aligned arrays for its class breakdown.
Complete structured results stay with the native tool receipt.

The two Python entrypoints are independent of the harness model:

- `agent/scripts/ml-lab.py`: standard-library binary tanh MLP with train-only
  scaling, and offline tabular Q. Bounded work, explicit splits, finite updates,
  JSON model/checkpoint export, seeded RNG restoration and exact resume. The CPU
  reference is intentionally small; larger jobs should use a vectorized trainer.
- `agent/scripts/ml-transformer-train.py`: actual Sentence Transformer cosine
  similarity training and causal LoRA via installed Hugging Face Trainers. It
  requires an immutable remote model revision or hashed local model directory,
  separated local JSONL data and a prepared dependency environment. It installs
  nothing. Loading an authorized model can
  download weights. LoRA uses whole-text causal loss and preserves genuine EOS
  labels while masking padding; instruction-only masking needs a different recipe.

Both accept `--help`, `--spec experiment.json --check`, a two-step `--steps 2`
smoke, a new `--output` directory, and `--resume checkpoint.json`. Each run preserves
data/config hashes, checkpoints and metrics. Smoke runs evaluate validation only;
full runs compare the frozen test cases. Local reference resume preserves SGD
state and RNG; transformer resume verifies data, configuration, dependency/trainer
identity and uses complete native optimizer/scheduler/RNG checkpoints. No existing
run directory is overwritten. The schedule horizon remains fixed across smoke
and resume; evaluation preserves training RNG state. The offline CPU integration
test compares exported resumed and uninterrupted weights on tiny local models.
Offline Q residuals and causal loss do not establish
policy or downstream task quality. Reevaluate exports on the actual target.

The optional ML environment can live under the private installation's
`local-models/ml-training/venv`. Recipe lookup returns its Python path when
available. `ml-training-requirements.txt` pins the tested Trainer dependencies;
install the correct PyTorch CPU/CUDA build separately and preserve a complete
environment lock. Framework tests are explicitly opt-in, for example
`PI_ML_TEST_PYTHON=/path/to/isolated/python node --test tests/ml-transformer-live.test.mjs`.
They generate small models locally with network retrieval disabled; they do not
demonstrate large-model quality, target-device inference or Colab connectivity.

Use the existing `bg_run`, `bg_status`, `bg_logs` and cancellation owner for long
jobs; a background launch is not completion. The tagged notebook at
`agent/skills/google-colab-training/assets/ml-lab-training.ipynb` separates config,
preflight, data, smoke, train, evaluation and export. Inspect the actual Colab
browser/runtime connection and authorized data transfer, preserve durable
checkpoints, and reconcile existing state before rerunning cells. Prepared files
and stored execution counts never prove a live GPU or successful cloud training.

Implementation contracts follow the official [Sentence Transformer training
guide](https://sbert.net/docs/sentence_transformer/training_overview.html),
[PEFT guide](https://huggingface.co/docs/peft/quicktour),
[Trainer API](https://huggingface.co/docs/transformers/main_classes/trainer),
[Colab FAQ](https://research.google.com/colaboratory/faq.html) and
[Gymnasium time-limit guidance](https://gymnasium.farama.org/tutorials/gymnasium_basics/handling_time_limits/).
Inspect installed versions and observed runtime capabilities before scaling.
