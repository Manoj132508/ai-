# ADR 015: Retrieval threshold kept at 0.35 after held-out tuning

**Status:** Accepted · **Phase:** post-project (eval-driven) · **Refines:**
[ADR 008](008-retrieval-threshold.md)

## Context

ADR 008 shipped the grounding threshold at **0.35**, "to be tuned." The
[evaluation harness](../../ai-service/evaluation/) then flagged that 0.35
over-refuses some answerable questions. The temptation was to nudge the number
until the harness looked better — which is overfitting to one set.

So instead: expand the golden set to **39 questions** across six documents and
three domains, split it into a fixed, committed **tuning (21)** and **held-out
(18)** partition — stratified so every question `kind` appears in both — select
the threshold on the tuning split only, and evaluate **once** on the holdout.
Retrieval score is threshold-independent (the threshold only decides
`grounded = top_score ≥ t`), so each question is retrieved once and thresholds
are swept analytically over the recorded scores; nothing leaks.

## Decision

**Keep the threshold at 0.35.** Selection on the tuning split (maximise balanced
accuracy, tie-break to the plateau midpoint) chose **0.38** — but on the
held-out set 0.38 **did not beat 0.35** (balanced accuracy 0.625 vs 0.667). The
held-out validation rejected the change, so it was not made. The apparent
single-set finding was noise.

## Why no threshold can fix this

The score distributions **overlap**, and the eval makes it visible:

- Seven genuinely answerable questions score **below** 0.35 (down to `bf-refund`
  at 0.234).
- Several unanswerable questions score **above** it because they are topically
  related to the corpus — `adv-price` 0.575, `un-founded` 0.432 ("Acme Corp" is
  all over the documents), `adv-buy-leave` 0.410.

`adv-price` (unanswerable) scores higher than most answerable questions. No
single global cosine-similarity cutoff separates "answerable" from "on-topic but
unanswerable"; raising the threshold trades over-refusals for false-answers
one-for-one.

## Consequences

**The threshold is a pre-filter, not the precision mechanism.** It cleanly
rejects the truly off-topic (scores below ~0.2: capital of France, boiling point
of water) and avoids an LLM call for them. The overlap region is resolved by the
**second layer** — the grounded-refusal prompt, which refuses when the sources
do not contain the answer — exactly the two-layer design ADR 008 and ADR 011
already describe.

**The real next step is a re-ranker or a small answerability classifier**, not a
better constant. That is what could separate the overlap region; a scalar
threshold provably cannot.

**A recall-first lower threshold is defensible** in the two-layer system (let
borderline questions reach the LLM, which refuses the unanswerable ones), but
adopting it responsibly needs evidence that the prompt layer catches the extra
borderline cases — the harness's **Tier B** `second_layer_refusal_rate`. That
measurement needs a working generation provider, currently blocked on this
machine by an Ollama GPU/CUDA fault, so the conservative 0.35 stands until it
can be validated.

## Alternatives considered

- **Adopt the tuned 0.38.** Rejected: it failed held-out validation. Shipping it
  would be the exact overfitting this ADR exists to avoid.
- **Lower the threshold now for recall.** Deferred, not rejected — it needs Tier B
  evidence that the prompt layer compensates, which is currently unmeasurable.
- **Keep tuning until the holdout improves.** That is p-hacking the holdout;
  the split is only honest if it is looked at once.
