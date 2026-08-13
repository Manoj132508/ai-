"""Metric functions for the RAG evaluation.

Deliberately pure: no model, no network, no I/O. Everything here takes plain
data and returns a number, so the metric maths is unit-tested offline
(tests/test_eval_metrics.py) independently of the slow, model-dependent harness
that produces the inputs.
"""

from __future__ import annotations

import re

_CITATION = re.compile(r"\[(\d+)\]")


# --- retrieval ---------------------------------------------------------------


def hit(retrieved_docs: list[str], expected_doc: str) -> bool:
    """Did the expected document appear anywhere in the retrieved list? (hit@k)"""
    return expected_doc in retrieved_docs


def reciprocal_rank(retrieved_docs: list[str], expected_doc: str) -> float:
    """1 / (rank of the first chunk from the expected doc), or 0 if absent.

    The basis of MRR. Rank is 1-based, so a first-place hit scores 1.0, second
    place 0.5, and a miss 0.0 -- rewarding not just finding the right document
    but ranking it highly.
    """
    for position, doc in enumerate(retrieved_docs, start=1):
        if doc == expected_doc:
            return 1.0 / position
    return 0.0


# --- refusal -----------------------------------------------------------------


def refusal_outcome(answerable: bool, grounded: bool) -> str:
    """Classifies one question's refusal decision.

    Framed around whether the system chose to ANSWER (grounded=True):
    - correct_answer:  answerable and it answered.
    - correct_refusal: unanswerable and it refused.
    - false_answer:    unanswerable but it answered -- the dangerous failure,
                       the one that produces a confident, ungrounded reply.
    - over_refusal:    answerable but it refused -- annoying, not dangerous.
    """
    if answerable and grounded:
        return "correct_answer"
    if not answerable and not grounded:
        return "correct_refusal"
    if not answerable and grounded:
        return "false_answer"
    return "over_refusal"


def summarize_refusal(records: list[tuple[bool, bool]]) -> dict[str, float]:
    """Aggregates (answerable, grounded) pairs into refusal metrics."""
    outcomes = [refusal_outcome(a, g) for a, g in records]
    n = len(outcomes) or 1
    answerable_n = sum(1 for a, _ in records if a) or 1
    unanswerable_n = sum(1 for a, _ in records if not a) or 1

    correct = sum(1 for o in outcomes if o in ("correct_answer", "correct_refusal"))
    false_answers = sum(1 for o in outcomes if o == "false_answer")
    over_refusals = sum(1 for o in outcomes if o == "over_refusal")

    return {
        "accuracy": correct / n,
        # Of everything that should have been refused, how much slipped through
        # and got answered. The metric that matters most -- a rising
        # false-answer rate is the system starting to hallucinate.
        "false_answer_rate": false_answers / unanswerable_n,
        # Of everything answerable, how much got wrongly refused.
        "over_refusal_rate": over_refusals / answerable_n,
        "correct_answers": sum(1 for o in outcomes if o == "correct_answer"),
        "correct_refusals": sum(1 for o in outcomes if o == "correct_refusal"),
        "false_answers": false_answers,
        "over_refusals": over_refusals,
    }


# --- citations / answer content ----------------------------------------------


def parse_citations(answer: str) -> list[int]:
    """Extracts the [n] citation indices from an answer, de-duplicated, in order."""
    seen: list[int] = []
    for match in _CITATION.finditer(answer):
        n = int(match.group(1))
        if n not in seen:
            seen.append(n)
    return seen


def citations_in_range(cited: list[int], n_sources: int) -> bool:
    """Every citation points at a real source (1..n_sources) -- none fabricated.

    A [4] when only three sources were provided is a fabricated citation: the
    model invented a reference. This is a groundedness failure that needs no
    LLM to detect.
    """
    return all(1 <= n <= n_sources for n in cited)


def cited_expected_doc(cited: list[int], source_docs: list[str], expected_doc: str) -> bool:
    """Did at least one citation point at a chunk from the expected document?

    `source_docs` is the ordered list of document names for the sources shown to
    the model, so citation n refers to source_docs[n-1].
    """
    for n in cited:
        if 1 <= n <= len(source_docs) and source_docs[n - 1] == expected_doc:
            return True
    return False


def answer_contains(answer: str, must_contain: list[str]) -> bool:
    """Every required substring appears in the answer (case-insensitive)."""
    low = answer.lower()
    return all(sub.lower() in low for sub in must_contain)


def mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0
