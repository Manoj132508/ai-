"""CLI for the RAG evaluation harness.

    python -m evaluation.run                 # retrieval + refusal (Tier A)
    python -m evaluation.run --generation    # also citation + answer quality (Tier B)
    python -m evaluation.run --write-baseline # save Tier A as the regression baseline
    python -m evaluation.run --check         # fail (exit 1) if Tier A regressed

Tier A is deterministic given the fixed embedding model, so it is what --check
gates on. Tier B needs a live LLM, is nondeterministic, and is reported but
never gated.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import tempfile
from pathlib import Path

import chromadb
from app.core.config import get_settings
from app.pipeline.embedder import LocalEmbeddingProvider
from app.pipeline.prompt import REFUSAL_TEXT
from app.pipeline.vector_store import ChromaVectorStore
from chromadb.config import Settings as ChromaSettings

from evaluation import metrics, tuning
from evaluation.harness import QuestionResult, index_corpus, run_generation, run_retrieval

BASELINE_PATH = Path(__file__).parent / "baseline.json"

# Metric direction for the regression check: +1 higher-is-better, -1 lower-is-better.
TIER_A_DIRECTION = {
    "retrieval_hit_rate": +1,
    "retrieval_mrr": +1,
    "refusal_accuracy": +1,
    "false_answer_rate": -1,
    "over_refusal_rate": -1,
}


def tier_a_metrics(results: list[QuestionResult]) -> dict[str, float]:
    answerable = [r for r in results if r.q.answerable]
    hits = [metrics.hit(r.retrieved_docs, r.q.expected_doc) for r in answerable]
    rr = [metrics.reciprocal_rank(r.retrieved_docs, r.q.expected_doc) for r in answerable]
    refusal = metrics.summarize_refusal([(r.q.answerable, r.grounded) for r in results])
    return {
        "retrieval_hit_rate": metrics.mean([1.0 if h else 0.0 for h in hits]),
        "retrieval_mrr": metrics.mean(rr),
        "refusal_accuracy": refusal["accuracy"],
        "false_answer_rate": refusal["false_answer_rate"],
        "over_refusal_rate": refusal["over_refusal_rate"],
        "_counts": {
            "false_answers": refusal["false_answers"],
            "over_refusals": refusal["over_refusals"],
            "correct_refusals": refusal["correct_refusals"],
            "correct_answers": refusal["correct_answers"],
        },
    }


def tier_b_metrics(results: list[QuestionResult]) -> dict[str, float]:
    gen_answerable = [r for r in results if r.generated and r.q.answerable]
    valid, correct_src, answer_ok = [], [], []
    for r in gen_answerable:
        cited = metrics.parse_citations(r.answer or "")
        valid.append(1.0 if metrics.citations_in_range(cited, len(r.retrieved_docs)) else 0.0)
        correct_src.append(
            1.0 if metrics.cited_expected_doc(cited, r.retrieved_docs, r.q.expected_doc) else 0.0
        )
        answer_ok.append(1.0 if metrics.answer_contains(r.answer or "", r.q.must_contain) else 0.0)

    # Second-layer refusal: unanswerable questions that cleared the threshold
    # (a false_answer at Tier A) but that the prompt still refused at generation.
    leaked = [r for r in results if r.generated and not r.q.answerable]
    second_layer = [
        1.0 if REFUSAL_TEXT.lower() in (r.answer or "").lower() else 0.0 for r in leaked
    ]
    return {
        "citation_validity_rate": metrics.mean(valid),
        "cited_correct_source_rate": metrics.mean(correct_src),
        "answer_correct_rate": metrics.mean(answer_ok),
        "second_layer_refusal_rate": metrics.mean(second_layer),
        "_generated": len(gen_answerable),
        "_leaked_to_generation": len(leaked),
    }


def _bar(value: float) -> str:
    filled = round(value * 20)
    return "█" * filled + "·" * (20 - filled)


def print_report(results, tier_a, tier_b, settings) -> None:
    print("\n" + "=" * 72)
    print("  RAG EVALUATION")
    print("=" * 72)
    print(
        f"  model={settings.embedding_model.split('/')[-1]}  "
        f"threshold={settings.retrieval_score_threshold}  top_k={settings.retrieval_top_k}  "
        f"questions={len(results)}"
    )

    print("\n  TIER A — retrieval & refusal (deterministic, gates CI)")
    for key in ("retrieval_hit_rate", "retrieval_mrr", "refusal_accuracy"):
        print(f"    {key:<22} {tier_a[key]:.3f}  {_bar(tier_a[key])}")
    far, orr = tier_a["false_answer_rate"], tier_a["over_refusal_rate"]
    fa_n, or_n = tier_a["_counts"]["false_answers"], tier_a["_counts"]["over_refusals"]
    print(f"    {'false_answer_rate':<22} {far:.3f}  {_bar(far)}  (lower better — {fa_n} leaked)")
    print(f"    {'over_refusal_rate':<22} {orr:.3f}  {_bar(orr)}  (lower better — {or_n} refused)")

    if tier_b is not None:
        print("\n  TIER B — generation quality (needs a live LLM, NOT gated)")
        print(f"    (generated {tier_b['_generated']} answerable, "
              f"{tier_b['_leaked_to_generation']} threshold-leaked)")
        for key in (
            "citation_validity_rate",
            "cited_correct_source_rate",
            "answer_correct_rate",
            "second_layer_refusal_rate",
        ):
            print(f"    {key:<26} {tier_b[key]:.3f}  {_bar(tier_b[key])}")

    print("\n  PER-QUESTION")
    for r in results:
        correct = metrics.refusal_outcome(r.q.answerable, r.grounded).startswith("correct")
        mark = "ok " if correct else "!! "
        score = f"{r.top_score:.3f}" if r.top_score is not None else " -- "
        decision = "answer" if r.grounded else "refuse"
        print(f"    {mark}{r.q.id:<18} score={score} → {decision:<6} [{r.q.kind}]")
    print("=" * 72 + "\n")


def run_tuning(results: list[QuestionResult], settings) -> None:
    """Select the threshold on the tuning split, then evaluate ONCE on holdout.

    The tuning scores choose the threshold; the holdout scores are touched only
    at the end, at that single chosen value, so the reported holdout numbers are
    an honest estimate of how the threshold generalises to unseen questions."""
    tune = [(r.q.answerable, r.top_score) for r in results if r.q.split == "tune"]
    hold = [(r.q.answerable, r.top_score) for r in results if r.q.split == "holdout"]
    candidates = tuning.default_candidates()
    chosen, best_tune, _curve = tuning.select_threshold(tune, candidates)
    old = settings.retrieval_score_threshold

    def holdout_at(t: float) -> dict:
        recs = [(a, tuning.grounded_at(s, t)) for a, s in hold]
        m = metrics.summarize_refusal(recs)
        m["balanced_accuracy"] = tuning.balanced_accuracy(recs)
        return m

    old_h, new_h = holdout_at(old), holdout_at(chosen)

    print("\n" + "=" * 72)
    print("  THRESHOLD TUNING")
    print("=" * 72)
    print(f"  tuning questions:  {len(tune)}   holdout questions: {len(hold)}")
    print(f"  selected on TUNING: threshold={chosen:.3f}  (balanced acc {best_tune:.3f})")
    print("\n  HELD-OUT VALIDATION (evaluated once, never used for selection)")
    print(f"    {'metric':<22}{'@ 0.350 (old)':>16}{'@ ' + format(chosen, '.3f') + ' (new)':>16}")
    for key, label in (
        ("balanced_accuracy", "balanced_accuracy"),
        ("accuracy", "accuracy"),
        ("false_answer_rate", "false_answer_rate"),
        ("over_refusal_rate", "over_refusal_rate"),
    ):
        print(f"    {label:<22}{old_h[key]:>16.3f}{new_h[key]:>16.3f}")
    better = new_h["balanced_accuracy"] >= old_h["balanced_accuracy"]
    verdict = "generalises (>= old on holdout)" if better else "does NOT beat old on holdout"
    print(f"\n  verdict: threshold {chosen:.3f} {verdict}")
    print("  (apply by setting RETRIEVAL_SCORE_THRESHOLD / the config default, then re-baseline)")
    print("=" * 72 + "\n")


def save_baseline(tier_a, settings) -> None:
    payload = {
        "embedding_model": settings.embedding_model,
        "threshold": settings.retrieval_score_threshold,
        "top_k": settings.retrieval_top_k,
        "metrics": {k: tier_a[k] for k in TIER_A_DIRECTION},
    }
    BASELINE_PATH.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"  baseline written to {BASELINE_PATH.name}")


def check_baseline(tier_a, tolerance: float = 0.02) -> bool:
    if not BASELINE_PATH.exists():
        print("  no baseline.json — run with --write-baseline first.")
        return False
    base = json.loads(BASELINE_PATH.read_text(encoding="utf-8"))["metrics"]
    ok = True
    print("\n  REGRESSION CHECK (vs baseline.json)")
    for key, direction in TIER_A_DIRECTION.items():
        now, was = tier_a[key], base[key]
        # A regression is a move in the wrong direction beyond the tolerance.
        regressed = (direction * (now - was)) < -tolerance
        flag = "REGRESSED" if regressed else "ok"
        print(f"    {key:<22} {was:.3f} → {now:.3f}   {flag}")
        ok = ok and not regressed
    print(f"  result: {'PASS' if ok else 'FAIL'}\n")
    return ok


def main() -> int:
    parser = argparse.ArgumentParser(description="RAG evaluation harness")
    parser.add_argument("--generation", action="store_true", help="also run Tier B (live LLM)")
    parser.add_argument("--write-baseline", action="store_true", help="save Tier A as the baseline")
    parser.add_argument("--check", action="store_true", help="fail if Tier A regressed vs baseline")
    parser.add_argument("--tune", action="store_true", help="select threshold on tune split, "
                        "validate on holdout")
    args = parser.parse_args()

    settings = get_settings()
    print("  loading embedding model (first run downloads ~90 MB)…")
    embedder = LocalEmbeddingProvider(settings.embedding_model)
    embedder.warm_up()

    tmp = tempfile.mkdtemp(prefix="aika-eval-")
    try:
        client = chromadb.PersistentClient(
            path=tmp, settings=ChromaSettings(anonymized_telemetry=False)
        )
        store = ChromaVectorStore(client)
        chunks = index_corpus(embedder, store, settings)
        print(f"  indexed {chunks} chunks from the corpus")

        results = run_retrieval(embedder, store, settings)

        if args.tune:
            run_tuning(results, settings)
            return 0

        tier_a = tier_a_metrics(results)

        tier_b = None
        if args.generation:
            run_generation(results, settings)
            tier_b = tier_b_metrics(results)

        print_report(results, tier_a, tier_b, settings)

        if args.write_baseline:
            save_baseline(tier_a, settings)
        if args.check:
            return 0 if check_baseline(tier_a) else 1
        return 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
