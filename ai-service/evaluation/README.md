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

## What the baseline already revealed

Retrieval is strong — `hit_rate 1.00`, `MRR 0.95`: the right document is
retrieved and usually ranked first, including on the *semantic* questions that
share no words with the source (which is the whole case for embeddings over
keyword search).

The harness's first real finding is about the **threshold**. At the shipped
`0.35`, three answerable questions scored just under it (`0.297`–`0.302`) and
were **over-refused**, while one out-of-scope question scored high and **leaked**.
That's the precision/recall trade of a single global threshold, made concrete.
The baseline records this honestly rather than hiding it — and deliberately does
**not** retune the threshold, because tuning it on 17 questions would be
overfitting. The right follow-up is a larger labelled set and a threshold swept
against it; the harness is what makes that measurable.

## Adding to the set

Edit `dataset.py`. Each question needs: the text, whether it's `answerable`, its
`kind` (for grouping), the `expected_doc`, and — for Tier B — the `must_contain`
substrings a correct answer must include. Keep the corpus (`corpus/*.md`)
small and the labels trustworthy; a golden set is only as good as its labels.

## Note on this machine

Tier B needs a working generation provider. On the current machine Ollama's GPU
`llama-server` crashes with a CUDA toolchain/driver mismatch (`the provided PTX
was compiled with an unsupported toolchain`), so live Tier B answers come back
empty here — the harness reports that gracefully rather than crashing. Tier B
runs cleanly once the provider is healthy (update the GPU driver, or run Ollama
CPU-only with `OLLAMA_NUM_GPU=0`).
