"""Unit tests for threshold selection. Pure and offline -- no model."""

from evaluation.tuning import (
    balanced_accuracy,
    default_candidates,
    grounded_at,
    select_threshold,
    sweep,
)


def test_grounded_at_rule():
    assert grounded_at(0.40, 0.35) is True
    assert grounded_at(0.30, 0.35) is False
    assert grounded_at(None, 0.35) is False  # empty retrieval never grounds


def test_balanced_accuracy_extremes():
    # perfect: every answerable answered, every unanswerable refused.
    assert balanced_accuracy([(True, True), (False, False)]) == 1.0
    # always-answer: TPR 1, TNR 0 -> 0.5, not gamed to look good.
    assert balanced_accuracy([(True, True), (False, True)]) == 0.5


def test_sweep_shapes_with_candidates():
    scored = [(True, 0.6), (False, 0.1)]
    curve = sweep(scored, [0.2, 0.5, 0.7])
    # at 0.2: answerable answered, unanswerable refused -> 1.0
    # at 0.7: answerable now refused (0.6<0.7) -> TPR 0, TNR 1 -> 0.5
    assert dict(curve)[0.2] == 1.0
    assert dict(curve)[0.7] == 0.5


def test_select_picks_plateau_midpoint():
    # answerable high (0.5, 0.6), unanswerable low (0.1, 0.2). Balanced accuracy
    # is 1.0 for every threshold in (0.2, 0.5]; the midpoint of that plateau is
    # chosen for maximum margin.
    scored = [(True, 0.5), (True, 0.6), (False, 0.1), (False, 0.2)]
    candidates = [0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50, 0.55]
    chosen, best, _ = select_threshold(scored, candidates)
    assert best == 1.0
    assert 0.25 <= chosen <= 0.50, "chosen inside the perfect-separation plateau"
    # and it is not jammed against either boundary
    assert chosen not in (0.20, 0.50)


def test_default_candidates_are_ordered_and_bounded():
    cands = default_candidates(0.10, 0.60, 0.05)
    assert cands[0] == 0.10
    assert cands[-1] == 0.60
    assert cands == sorted(cands)
