"""Threshold selection — pure, so it is unit-tested without the model.

The retrieval score of a question does NOT depend on the threshold: retrieval
computes a top similarity, and the threshold only decides
``grounded = top_score >= threshold``. So the harness retrieves each question
once, records its top score, and this module sweeps thresholds over those
recorded scores analytically -- no re-embedding, and no chance of the sweep
leaking into retrieval.

Selection rule: maximise **balanced accuracy** of the answer-vs-refuse decision
on the TUNING scores, then, among the thresholds that tie for the best, take the
midpoint of that plateau. The midpoint sits as far as possible from the nearest
score on either side, which is the choice most likely to generalise -- a max-
margin decision boundary rather than one perched against a training point.
"""

from __future__ import annotations


def grounded_at(top_score: float | None, threshold: float) -> bool:
    """The production rule, isolated: answer iff a chunk cleared the threshold."""
    return top_score is not None and top_score >= threshold


def _mean(xs: list[float]) -> float:
    return sum(xs) / len(xs) if xs else 0.0


def balanced_accuracy(records: list[tuple[bool, bool]]) -> float:
    """Mean of true-positive rate (answerable answered) and true-negative rate
    (unanswerable refused).

    Balanced rather than plain accuracy so an imbalanced mix of answerable and
    unanswerable questions cannot be gamed by always answering (or always
    refusing).
    """
    answerable = [g for a, g in records if a]
    unanswerable = [g for a, g in records if not a]
    tpr = _mean([1.0 if g else 0.0 for g in answerable])          # answered when it should
    tnr = _mean([1.0 if not g else 0.0 for g in unanswerable])    # refused when it should
    return (tpr + tnr) / 2.0


def sweep(
    scored: list[tuple[bool, float | None]], candidates: list[float]
) -> list[tuple[float, float]]:
    """For each candidate threshold, the balanced accuracy over the scored set.

    `scored` is a list of (answerable, top_score) pairs.
    """
    curve: list[tuple[float, float]] = []
    for t in candidates:
        records = [(a, grounded_at(s, t)) for a, s in scored]
        curve.append((t, balanced_accuracy(records)))
    return curve


def select_threshold(
    scored: list[tuple[bool, float | None]], candidates: list[float], *, eps: float = 1e-9
) -> tuple[float, float, list[tuple[float, float]]]:
    """Pick the max-balanced-accuracy threshold, breaking ties to the plateau
    midpoint. Returns (chosen_threshold, best_score, full_curve)."""
    curve = sweep(scored, candidates)
    best = max(v for _, v in curve)
    plateau = [t for t, v in curve if v >= best - eps]
    chosen = plateau[len(plateau) // 2]
    return chosen, best, curve


def default_candidates(lo: float = 0.10, hi: float = 0.60, step: float = 0.005) -> list[float]:
    n = round((hi - lo) / step)
    return [round(lo + i * step, 3) for i in range(n + 1)]
