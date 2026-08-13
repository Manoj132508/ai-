"""The fixed evaluation set.

A golden set of questions with known answers, deliberately small and hand-built
so every label is trustworthy. Each entry says whether the corpus can answer it,
which document holds the answer, and (for the generation tier) substrings the
answer must contain.

`kind` groups questions in the report:
- lexical:     the answer shares words with the question (easy retrieval).
- semantic:    the answer means the same thing in different words (the case
               that justifies embeddings over keyword search).
- unanswerable: clearly outside the corpus; the system MUST refuse.
- adversarial: lexically close to the corpus but not actually answerable
               (e.g. shares the word "password"); the honest hard case.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class EvalQuestion:
    id: str
    question: str
    answerable: bool
    kind: str
    expected_doc: str | None = None
    # Substrings that a correct answer must contain (case-insensitive). Used
    # only by the generation tier; the retrieval/refusal tier ignores them.
    must_contain: list[str] = field(default_factory=list)


DATASET: list[EvalQuestion] = [
    # --- handbook -----------------------------------------------------------
    EvalQuestion(
        "hb-notice", "How much notice must I give when I resign?",
        True, "lexical", "handbook.md", ["30 days"],
    ),
    EvalQuestion(
        "hb-leave", "How many days of paid annual leave do full-time employees get?",
        True, "lexical", "handbook.md", ["20 days"],
    ),
    EvalQuestion(
        "hb-expenses", "What is the deadline for submitting an expense claim?",
        True, "lexical", "handbook.md", ["60 days"],
    ),
    EvalQuestion(
        # No lexical overlap with "30 days' written notice" -- this one only
        # works if retrieval understands meaning, not vocabulary.
        "hb-quit-semantic",
        "I want to quit my job. How far in advance do I have to tell my boss?",
        True, "semantic", "handbook.md", ["30 days"],
    ),
    # --- security policy ----------------------------------------------------
    EvalQuestion(
        "sec-pwlen", "What is the minimum password length?",
        True, "lexical", "security-policy.md", ["12"],
    ),
    EvalQuestion(
        "sec-mfa", "Which accounts are required to use multi-factor authentication?",
        True, "lexical", "security-policy.md", ["administrator"],
    ),
    EvalQuestion(
        "sec-retention", "How long is customer data kept after an account is closed?",
        True, "lexical", "security-policy.md", ["24 months"],
    ),
    EvalQuestion(
        "sec-access-semantic",
        "How often does the company check who can get into production systems?",
        True, "semantic", "security-policy.md", ["quarterly"],
    ),
    # --- product FAQ --------------------------------------------------------
    EvalQuestion(
        "faq-trial", "How long is the free trial?",
        True, "lexical", "product-faq.md", ["14"],
    ),
    EvalQuestion(
        "faq-export", "What formats can I export my data in?",
        True, "lexical", "product-faq.md", ["CSV", "JSON"],
    ),
    EvalQuestion(
        "faq-integrations", "Which accounting tools does Ledgerly work with?",
        True, "semantic", "product-faq.md", ["Stripe", "QuickBooks", "Xero"],
    ),
    # --- unanswerable: MUST be refused --------------------------------------
    EvalQuestion("un-france", "What is the capital of France?", False, "unanswerable"),
    EvalQuestion("un-worldcup", "Who won the 2018 football World Cup?", False, "unanswerable"),
    EvalQuestion("un-boiling", "What is the boiling point of water?", False, "unanswerable"),
    EvalQuestion("un-ceo-pay", "What is the CEO's annual salary?", False, "unanswerable"),
    # --- adversarial: lexically close, still unanswerable -------------------
    EvalQuestion(
        # Shares "password" with the security policy, but the corpus never says
        # how to RESET one. The threshold (and, failing that, the prompt) must
        # still refuse. The honest hard case.
        "adv-netflix", "How do I reset my Netflix password?", False, "adversarial",
    ),
    EvalQuestion(
        # Shares "export" / product vocabulary but asks something not covered.
        "adv-price", "How much does Ledgerly's enterprise plan cost per month?",
        False, "adversarial",
    ),
]
