"""Builds the grounded prompt.

A pure function, deliberately: prompt construction is the part of a RAG system
most worth testing and least testable if it is tangled up with an HTTP client.
"""

from __future__ import annotations

from app.pipeline.retriever import RetrievedChunk

REFUSAL_TEXT = "I couldn't find this in your documents."

SYSTEM_PROMPT = """You answer questions using ONLY the numbered sources provided in the user's message.

Rules:
- Use only information present in the sources. Do not use outside knowledge, \
even if you are confident it is correct.
- Cite the source number in square brackets after each claim, like [1]. A \
claim drawn from two sources cites both, like [1][3].
- If the sources do not contain the answer, reply with exactly: \
"{refusal}" and nothing else. Do not guess, and do not offer a partial answer \
assembled from loosely related material.
- Quote figures, dates and names exactly as they appear. Do not round, \
convert, or rephrase them.
- Answer in prose, briefly. Do not restate the question or describe the \
sources.""".format(refusal=REFUSAL_TEXT)


def build_sources_block(chunks: list[RetrievedChunk]) -> str:
    """Renders retrieved chunks as a numbered list.

    Numbering is 1-based and matches the order of ``chunks``, so the model's
    "[2]" maps to ``chunks[1]`` with no lookup table. The document name and
    page are included because they let the model disambiguate two sources that
    say similar things -- and because a citation the user can act on needs
    them anyway.
    """
    lines: list[str] = []
    for position, chunk in enumerate(chunks, start=1):
        location = f"{chunk.document_name}"
        if chunk.page is not None:
            location += f", page {chunk.page}"
        lines.append(f"[{position}] ({location})\n{chunk.text.strip()}")
    return "\n\n".join(lines)


def build_user_message(question: str, chunks: list[RetrievedChunk]) -> str:
    """Assembles sources plus question.

    SOURCES FIRST, QUESTION LAST. Two reasons: the long, stable part of the
    prompt sits at the front where prompt caching can reuse it across turns,
    and instructions placed after a long context are followed more reliably
    than ones buried above it.
    """
    return f"""Sources:

{build_sources_block(chunks)}

---

Question: {question}"""


def build_history_messages(history: list[dict], limit: int = 3) -> list[dict]:
    """Trims prior turns to the most recent few.

    Included so follow-ups like "and what about part-time staff?" make sense.
    Deliberately bounded: history grows without limit, and an unbounded
    transcript both costs tokens and gradually crowds out the retrieved
    sources the answer is supposed to come from.

    Note what does NOT happen here -- retrieval still runs against the new
    question. The model must never answer from conversation history alone,
    because nothing in history carries a citation.
    """
    recent = [
        {"role": turn["role"], "content": turn["content"]}
        for turn in history
        if turn.get("role") in ("user", "assistant") and turn.get("content")
    ][-(limit * 2) :]

    # The API requires the first message to be from the user; a history window
    # that happens to start on an assistant turn would be rejected.
    while recent and recent[0]["role"] != "user":
        recent.pop(0)

    return recent
