"""Unit tests for the evaluation metric maths. Fully offline -- no model.

The harness that feeds these functions needs the embedding model and is slow;
the maths does not, so it is pinned down here where it runs in milliseconds.
"""

from evaluation.metrics import (
    answer_contains,
    citations_in_range,
    cited_expected_doc,
    hit,
    parse_citations,
    reciprocal_rank,
    refusal_outcome,
    summarize_refusal,
)


def test_hit_is_membership():
    assert hit(["handbook.md", "faq.md"], "handbook.md") is True
    assert hit(["faq.md"], "handbook.md") is False


def test_reciprocal_rank_rewards_higher_placement():
    assert reciprocal_rank(["handbook.md", "faq.md"], "handbook.md") == 1.0
    assert reciprocal_rank(["faq.md", "handbook.md"], "handbook.md") == 0.5
    assert reciprocal_rank(["faq.md", "sec.md"], "handbook.md") == 0.0


def test_refusal_outcome_classification():
    assert refusal_outcome(True, True) == "correct_answer"
    assert refusal_outcome(False, False) == "correct_refusal"
    # The dangerous one: unanswerable, yet answered.
    assert refusal_outcome(False, True) == "false_answer"
    assert refusal_outcome(True, False) == "over_refusal"


def test_summarize_refusal_rates():
    # 2 answerable (one answered, one over-refused), 2 unanswerable (one refused,
    # one false-answered).
    records = [(True, True), (True, False), (False, False), (False, True)]
    s = summarize_refusal(records)
    assert s["accuracy"] == 0.5
    assert s["false_answer_rate"] == 0.5  # 1 of 2 unanswerable slipped through
    assert s["over_refusal_rate"] == 0.5  # 1 of 2 answerable wrongly refused
    assert s["false_answers"] == 1
    assert s["correct_refusals"] == 1


def test_parse_citations_dedupes_in_order():
    assert parse_citations("A [1] and B [3], also [1] again.") == [1, 3]
    assert parse_citations("no citations here") == []


def test_citations_in_range_flags_fabrication():
    assert citations_in_range([1, 3], 3) is True
    assert citations_in_range([4], 3) is False  # invented a 4th source
    assert citations_in_range([], 3) is True  # nothing cited is not a fabrication


def test_cited_expected_doc_maps_index_to_source():
    sources = ["handbook.md", "faq.md", "handbook.md"]
    assert cited_expected_doc([2], sources, "handbook.md") is False  # source 2 is faq
    assert cited_expected_doc([1], sources, "handbook.md") is True
    assert cited_expected_doc([9], sources, "handbook.md") is False  # out of range


def test_answer_contains_requires_all_case_insensitive():
    assert answer_contains("You get 20 days of leave.", ["20 days"]) is True
    assert answer_contains("Export as csv or json.", ["CSV", "JSON"]) is True
    assert answer_contains("Only CSV is supported.", ["CSV", "JSON"]) is False
