"""The fixed evaluation set, split into tuning and held-out validation.

A golden set of questions with known answers, hand-built so every label is
trustworthy. Each entry says whether the corpus can answer it, which document
holds the answer, and (for the generation tier) substrings the answer must
contain.

`split` is FIXED and committed, not randomised per run: the threshold is chosen
on the `tune` questions only, and evaluated ONCE on the `holdout` questions, so
the reported generalisation is honest and reproducible. The split is stratified
-- every `kind` appears in both halves -- so neither half is all-easy or
all-hard.

`kind` groups questions in the report:
- lexical:      the answer shares words with the question (easy retrieval).
- semantic:     the answer means the same thing in different words (the case
                that justifies embeddings over keyword search).
- unanswerable: clearly outside the corpus; the system MUST refuse.
- adversarial:  lexically close to the corpus but not actually answerable; the
                honest hard case, where the threshold alone often cannot decide
                and the prompt layer must catch it.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class EvalQuestion:
    id: str
    question: str
    answerable: bool
    kind: str
    split: str  # "tune" | "holdout"
    expected_doc: str | None = None
    must_contain: list[str] = field(default_factory=list)


DATASET: list[EvalQuestion] = [
    # === handbook.md ========================================================
    EvalQuestion("hb-notice", "How much notice must I give when I resign?",
                 True, "lexical", "tune", "handbook.md", ["30 days"]),
    EvalQuestion("hb-leave", "How many days of paid annual leave do full-time employees get?",
                 True, "lexical", "holdout", "handbook.md", ["20 days"]),
    EvalQuestion("hb-expenses", "What is the deadline for submitting an expense claim?",
                 True, "lexical", "tune", "handbook.md", ["60 days"]),
    EvalQuestion("hb-probation", "How long is the probation period for new employees?",
                 True, "lexical", "holdout", "handbook.md", ["three months"]),
    EvalQuestion("hb-quit-semantic",
                 "I want to quit my job. How far in advance do I have to tell my boss?",
                 True, "semantic", "tune", "handbook.md", ["30 days"]),

    # === security-policy.md =================================================
    EvalQuestion("sec-pwlen", "What is the minimum password length?",
                 True, "lexical", "tune", "security-policy.md", ["12"]),
    EvalQuestion("sec-mfa", "Which accounts are required to use multi-factor authentication?",
                 True, "lexical", "holdout", "security-policy.md", ["administrator"]),
    EvalQuestion("sec-retention", "How long is customer data kept after an account is closed?",
                 True, "lexical", "tune", "security-policy.md", ["24 months"]),
    EvalQuestion("sec-access-semantic",
                 "How often does the company check who can get into production systems?",
                 True, "semantic", "holdout", "security-policy.md", ["quarterly"]),
    EvalQuestion("sec-reuse", "Can I reuse one of my old passwords?",
                 True, "semantic", "tune", "security-policy.md", ["five"]),

    # === product-faq.md =====================================================
    EvalQuestion("faq-trial", "How long is the free trial?",
                 True, "lexical", "holdout", "product-faq.md", ["14"]),
    EvalQuestion("faq-export", "What formats can I export my data in?",
                 True, "lexical", "tune", "product-faq.md", ["CSV", "JSON"]),
    EvalQuestion("faq-integrations", "Which accounting tools does Ledgerly work with?",
                 True, "semantic", "holdout", "product-faq.md", ["Stripe", "QuickBooks", "Xero"]),
    EvalQuestion("faq-support", "What are your support hours?",
                 True, "lexical", "tune", "product-faq.md", ["Monday", "9am"]),

    # === leave-and-benefits.md ==============================================
    EvalQuestion("lb-sick", "How many paid sick days do I get per year?",
                 True, "lexical", "tune", "leave-and-benefits.md", ["10 days"]),
    EvalQuestion("lb-pension", "How much does the company match on pension contributions?",
                 True, "lexical", "holdout", "leave-and-benefits.md", ["5%"]),
    EvalQuestion("lb-hours", "What are the standard weekly working hours?",
                 True, "lexical", "tune", "leave-and-benefits.md", ["37.5"]),
    EvalQuestion("lb-remote-semantic", "How many days a week am I allowed to work from home?",
                 True, "semantic", "holdout", "leave-and-benefits.md", ["3 days"]),

    # === billing-faq.md =====================================================
    EvalQuestion("bf-plans", "What plans does Ledgerly offer?",
                 True, "lexical", "tune", "billing-faq.md", ["Starter", "Growth", "Scale"]),
    EvalQuestion("bf-refund", "What is the refund window?",
                 True, "semantic", "holdout", "billing-faq.md", ["30 days"]),
    EvalQuestion("bf-invoice", "When are invoices issued?",
                 True, "lexical", "tune", "billing-faq.md", ["first business day"]),
    EvalQuestion("bf-currency", "Which currencies can I be billed in?",
                 True, "lexical", "holdout", "billing-faq.md", ["USD", "GBP", "EUR"]),

    # === incident-response.md ===============================================
    EvalQuestion("ir-breach", "How quickly must a data breach be reported?",
                 True, "lexical", "tune", "incident-response.md", ["1 hour"]),
    EvalQuestion("ir-encrypt", "How is customer data encrypted at rest?",
                 True, "lexical", "holdout", "incident-response.md", ["AES-256"]),
    EvalQuestion("ir-backups", "How often are backups taken?",
                 True, "lexical", "tune", "incident-response.md", ["6 hours"]),
    EvalQuestion("ir-pentest-semantic",
                 "How often does an outside firm test the company's security?",
                 True, "semantic", "holdout", "incident-response.md", ["annual"]),

    # === unanswerable: clearly out of domain, MUST be refused ===============
    EvalQuestion("un-france", "What is the capital of France?", False, "unanswerable", "tune"),
    EvalQuestion("un-worldcup", "Who won the 2018 football World Cup?",
                 False, "unanswerable", "holdout"),
    EvalQuestion("un-boiling", "What is the boiling point of water?",
                 False, "unanswerable", "tune"),
    EvalQuestion("un-ceo-pay", "What is the CEO's annual salary?",
                 False, "unanswerable", "holdout"),
    EvalQuestion("un-moon", "What time does the moon rise tonight?", False, "unanswerable", "tune"),
    EvalQuestion("un-python", "How do I write a for loop in Python?",
                 False, "unanswerable", "holdout"),
    EvalQuestion("un-weather", "What will the weather be tomorrow?", False, "unanswerable", "tune"),
    EvalQuestion("un-founded", "What year was Acme Corp founded?",
                 False, "unanswerable", "holdout"),

    # === adversarial: lexically close, still unanswerable ===================
    EvalQuestion("adv-netflix", "How do I reset my Netflix password?",
                 False, "adversarial", "tune"),
    EvalQuestion("adv-price", "How much does Ledgerly's enterprise plan cost per month?",
                 False, "adversarial", "holdout"),
    EvalQuestion("adv-buy-leave", "Can I buy extra annual leave days beyond my allowance?",
                 False, "adversarial", "tune"),
    EvalQuestion("adv-mfa-setup",
                 "What are the step-by-step instructions to set up multi-factor authentication?",
                 False, "adversarial", "holdout"),
    EvalQuestion("adv-refund-crypto", "Can I get my refund paid in Bitcoin?",
                 False, "adversarial", "tune"),
]
