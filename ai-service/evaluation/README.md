# RAG evaluation harness

Turns *"the RAG pipeline works"* into *"we can tell when it gets worse."* It runs
a fixed, hand-labelled question set through the **real** pipeline (the shipping
extractor, chunker, embedder, vector store, retriever, prompt, and generator)
and scores retrieval quality, refusal accuracy, citation correctness, and answer
correctness against a saved baseline.

## Run it

```bash
cd ai-service
python -m evaluation.run                  # Tier A: retrieval + refusal
python -m evaluation.run --generation     # + Tier B: citations + answer quality (needs a live LLM)
python -m evaluation.run --write-baseline # save Tier A as the regression baseline
python -m evaluation.run --check          # exit 1 if Tier A regressed vs baseline.json
python -m evaluation.run --tune           # select threshold on the tune split, validate on holdout
```

The first run downloads the embedding model (~90 MB). The corpus is indexed into
a **throwaway** temp Chroma directory, so a run never touches real vector data.

## The two tiers, and why they're separate

**Tier A — retrieval & refusal.** Deterministic given the fixed embedding model:
the same questions produce the same scores every time. This is what `--check`
gates on. Metrics:

- **`retrieval_hit_rate`** — for each answerable question, did the expected
  document appear in the top-k? (recall@k)
- **`retrieval_mrr`** — mean reciprocal rank of the expected document (rewards
  ranking it *first*, not just retrieving it).
- **`refusal_accuracy`** — did the grounding threshold make the right
  answer-vs-refuse call?
- **`false_answer_rate`** — of the questions the corpus *can't* answer, how many
  cleared the threshold anyway. **The metric that matters most:** a rising
  false-answer rate is the system starting to hallucinate.
- **`over_refusal_rate`** — of the answerable questions, how many were wrongly
  refused.

**Tier B — generation quality.** Needs a live LLM, so it's **opt-in and
nondeterministic** — reported, never gated. Metrics:

- **`citation_validity_rate`** — every `[n]` in the answer points at a real
  source (no fabricated citations). A groundedness check that needs no judge.
- **`cited_correct_source_rate`** — at least one citation points at the expected
  document.
- **`answer_correct_rate`** — the answer contains the known-correct fact.
- **`second_layer_refusal_rate`** — for questions that leaked past the threshold,
  did the *prompt* refuse them anyway (the second line of defence)?

Full RAGAS-style faithfulness/answer-relevancy scoring would add an LLM-as-judge
step on top of Tier B; the citation-validity and answer-correct checks here are
the deterministic subset of that, chosen because they don't inherit the judge's
nondeterminism.

## What the harness revealed

Retrieval is strong — `hit_rate 1.00`, `MRR 0.90`: the right document is
retrieved and usually ranked first, including on the *semantic* questions that
share no words with the source (the whole case for embeddings over keyword
search).

The interesting finding is about the **threshold**, and `--tune` investigated it
properly. The golden set was expanded to 39 questions and split into a fixed
tuning (21) and held-out (18) partition. Selecting on tuning chose `0.38` — but
on the **held-out** set it did **not** beat the shipped `0.35` (balanced accuracy
0.625 vs 0.667), so the change was rejected rather than shipped. That is the
held-out split doing its job: the single-set finding was noise.

The deeper result is that **no single threshold can fix this.** The score
distributions overlap: seven genuinely answerable questions score *below* 0.35
(down to 0.234), while several unanswerable-but-topically-related questions score
*above* it (`adv-price` 0.575, `un-founded` 0.432 — "Acme Corp" is all over the
corpus). Raising the threshold trades over-refusals for false-answers one for
one. So the threshold stays a cheap **pre-filter** (it cleanly rejects scores
below ~0.2), the overlap is the **generation layer's** job (the grounded-refusal
prompt), and the real next step is a **re-ranker**, not a better constant. This
is recorded in [ADR 015](../../docs/adr/015-threshold-held-out-tuning.md).

## Adding to the set

Edit `dataset.py`. Each question needs: the text, whether it's `answerable`, its
`kind` (for grouping), its `split` (`tune` / `holdout`), the `expected_doc`, and
— for Tier B — the `must_contain` substrings a correct answer must include. Keep
the split fixed and stratified, the corpus (`corpus/*.md`) small, and the labels
trustworthy; a golden set is only as good as its labels.

## Note on this machine

Tier B needs a working generation provider. On the current machine Ollama's GPU
`llama-server` crashes with a CUDA toolchain/driver mismatch (`the provided PTX
was compiled with an unsupported toolchain`), so live Tier B answers come back
empty here — the harness reports that gracefully rather than crashing. Tier B
runs cleanly once the provider is healthy (update the GPU driver, or run Ollama
CPU-only with `OLLAMA_NUM_GPU=0`).
