# ADR 008: Refuse to answer below a retrieval score threshold

**Status:** Accepted · **Phase:** 2

## Context

Cosine similarity always returns a nearest neighbour. There is no "no match":
ask *"what is the capital of France?"* against an HR handbook and retrieval
returns five chunks, each with a score, all irrelevant. Nothing errors.

Pass those to the LLM and it will do its best with them — which is exactly how
a grounded system produces a confident, wrong answer.

## Decision

If the best retrieval score falls below a threshold (starting at 0.35, to be
tuned against real documents), the system returns *"I couldn't find this in
your documents"* and **never calls the LLM**.

## Consequences

**Positive.** This is the primary defence against hallucination, and it sits
*in front of* the prompt rather than relying on it. The prompt instruction
("answer only from the context") is a soft constraint the model usually honours
and can violate; the threshold is a hard branch in our own code. It is also the
cheapest request in the system — a refusal spends zero output tokens.

**Negative.** A badly tuned threshold silently refuses questions the documents
*can* answer, and that failure is invisible: the user sees a polite refusal, not
an error, so nothing is logged as wrong. `retrievalMeta.topScore` is persisted
on every message specifically so this can be audited after the fact.

## Not an error

`NO_RELEVANT_CONTEXT` is deliberately **absent** from the error taxonomy
(ADR 009). A grounded refusal is a correct, successful outcome returned as 200.
Modelling it as an error would make the client treat the single most important
behaviour in the product as a failure.

## Defence in depth

Three layers, none sufficient alone: the threshold (do not retrieve rubbish),
the grounded prompt (constrain generation), and citations (let the user
verify). Grounding buys *faithfulness to the source*, not truth — a stale
document is reported faithfully and is still wrong, which is why re-index and
delete are v1 requirements.
