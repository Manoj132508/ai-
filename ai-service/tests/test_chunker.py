"""Chunker unit tests. Fully offline: no model, no network, no disk.

The chunker is the highest-value thing to test in this project. Everything
downstream inherits its mistakes, and its failures are silent -- a chunk with
the wrong page number produces a citation that points at the wrong place, and
nothing errors.
"""

import pytest
from app.pipeline.chunker import DEFAULT_SEPARATORS, Chunk, Page, chunk_pages

SIZE = 200
OVERLAP = 50


def paragraphs(count: int, filler: str = "word ") -> str:
    return "\n\n".join(f"Paragraph {i}. " + filler * 12 for i in range(count))


def test_empty_input_returns_no_chunks():
    assert chunk_pages([]) == []
    assert chunk_pages([Page(number=1, text="")]) == []
    assert chunk_pages([Page(number=1, text="   \n\n  ")]) == []


def test_short_document_is_one_chunk():
    chunks = chunk_pages([Page(number=1, text="A short note.")], chunk_size=SIZE)
    assert len(chunks) == 1
    assert chunks[0].text == "A short note."
    assert chunks[0].index == 0
    assert chunks[0].page == 1


def test_is_deterministic():
    """Same input, byte-identical output.

    Chunk ids are {document_id}:{index} (ADR 005), so a chunker that produced
    a different split on a re-run would write vectors under ids that no longer
    correspond to the same text -- silently, with no error anywhere.
    """
    pages = [Page(number=1, text=paragraphs(8))]

    first = chunk_pages(pages, chunk_size=SIZE, chunk_overlap=OVERLAP)
    second = chunk_pages(pages, chunk_size=SIZE, chunk_overlap=OVERLAP)

    assert [(c.text, c.index, c.char_start, c.char_end) for c in first] == [
        (c.text, c.index, c.char_start, c.char_end) for c in second
    ]


def test_respects_the_size_limit():
    """No chunk may exceed chunk_size.

    This is the constraint that matters most: MiniLM accepts 256 tokens and
    TRUNCATES anything longer without raising. An oversized chunk would be
    embedded only in part, so its tail would be unsearchable and nothing would
    say so.
    """
    chunks = chunk_pages([Page(number=1, text=paragraphs(20))], chunk_size=SIZE,
                         chunk_overlap=OVERLAP)
    assert len(chunks) > 1
    for chunk in chunks:
        assert len(chunk.text) <= SIZE, f"chunk {chunk.index} is {len(chunk.text)} chars"


def test_offsets_map_back_to_the_source_exactly():
    """chunk.text must equal document[char_start:char_end].

    Offsets are what would let a future feature highlight the cited passage in
    the original file. If they drift, the highlight lands on the wrong text --
    and the citation still looks right.
    """
    page_text = paragraphs(10)
    chunks = chunk_pages([Page(number=1, text=page_text)], chunk_size=SIZE, chunk_overlap=OVERLAP)

    for chunk in chunks:
        assert page_text[chunk.char_start : chunk.char_end] == chunk.text


def test_chunks_overlap():
    """Consecutive chunks share text.

    Without overlap, a sentence straddling a boundary appears whole in neither
    chunk, so neither embeds close to a question about it and the answer
    becomes unretrievable.
    """
    chunks = chunk_pages([Page(number=1, text=paragraphs(12))], chunk_size=SIZE,
                         chunk_overlap=OVERLAP)
    assert len(chunks) >= 2

    overlapping = [
        current.char_start < previous.char_end
        for previous, current in zip(chunks, chunks[1:], strict=False)
    ]
    assert all(overlapping), "every consecutive pair should share a region"


def test_overlap_is_bounded_by_the_setting():
    chunks = chunk_pages([Page(number=1, text=paragraphs(12))], chunk_size=SIZE,
                         chunk_overlap=OVERLAP)
    for previous, current in zip(chunks, chunks[1:], strict=False):
        shared = previous.char_end - current.char_start
        assert 0 < shared <= OVERLAP + len(" "), f"shared {shared} exceeds the overlap budget"


def test_pages_are_attributed_correctly():
    pages = [
        Page(number=1, text="First page content about apples."),
        Page(number=2, text="Second page content about bananas."),
        Page(number=3, text="Third page content about cherries."),
    ]
    # Large chunk_size would merge all three; keep it small so each stays put.
    chunks = chunk_pages(pages, chunk_size=40, chunk_overlap=0)

    for chunk in chunks:
        if "apples" in chunk.text:
            assert chunk.page == 1
        if "bananas" in chunk.text:
            assert chunk.page == 2
        if "cherries" in chunk.text:
            assert chunk.page == 3


def test_a_chunk_spanning_two_pages_records_both():
    """page_start and page_end differ when a chunk crosses a boundary.

    Chunking runs across the whole document rather than per page, so a passage
    split by a page break stays intact. The cost is that a chunk can belong to
    two pages, which is why both are recorded.
    """
    pages = [Page(number=1, text="Ends mid sentence and"), Page(number=2, text="continues here.")]
    chunks = chunk_pages(pages, chunk_size=500, chunk_overlap=0)

    assert len(chunks) == 1
    assert chunks[0].page_start == 1
    assert chunks[0].page_end == 2
    assert chunks[0].page == 1, "citations point at the page the passage starts on"


def test_page_numbers_are_one_indexed():
    chunks = chunk_pages([Page(number=1, text="Only page.")])
    assert chunks[0].page == 1, "off-by-one here makes every citation point one page early"


def test_indexes_are_sequential_from_zero():
    chunks = chunk_pages([Page(number=1, text=paragraphs(15))], chunk_size=SIZE,
                         chunk_overlap=OVERLAP)
    assert [c.index for c in chunks] == list(range(len(chunks)))


def test_unbreakable_run_is_hard_split():
    """Text with no separator at all still respects the size limit.

    A base64 blob, minified code, or a language that does not use spaces. The
    fallback is an ugly mid-token cut -- but a cut chunk is searchable, and a
    silently truncated one is not.
    """
    blob = "x" * (SIZE * 3 + 17)
    chunks = chunk_pages([Page(number=1, text=blob)], chunk_size=SIZE, chunk_overlap=0)

    assert all(len(c.text) <= SIZE for c in chunks)
    assert "".join(c.text for c in chunks) == blob, "hard split must lose nothing"


def test_prefers_paragraph_boundaries_over_mid_sentence_cuts():
    """A separator earlier in the hierarchy wins when the text fits either way."""
    text = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph."
    chunks = chunk_pages([Page(number=1, text=text)], chunk_size=25, chunk_overlap=0)

    # Each chunk should end at a paragraph break rather than mid-word.
    for chunk in chunks:
        assert not chunk.text.strip().endswith("parag"), "cut inside a word"


def test_overlap_must_be_smaller_than_size():
    """Otherwise the carried tail is the whole previous chunk and packing never advances."""
    with pytest.raises(ValueError, match="must be smaller"):
        chunk_pages([Page(number=1, text="anything")], chunk_size=100, chunk_overlap=100)

    with pytest.raises(ValueError):
        chunk_pages([Page(number=1, text="anything")], chunk_size=100, chunk_overlap=200)


def test_rejects_non_positive_size():
    with pytest.raises(ValueError):
        chunk_pages([Page(number=1, text="anything")], chunk_size=0, chunk_overlap=0)


def test_blank_pages_are_skipped_without_shifting_numbering():
    pages = [
        Page(number=1, text="Real content on page one."),
        Page(number=2, text="   "),  # a blank page in the middle of a scan
        Page(number=3, text="Real content on page three."),
    ]
    chunks = chunk_pages(pages, chunk_size=40, chunk_overlap=0)

    cited = {chunk.page for chunk in chunks}
    assert 2 not in cited, "a blank page should produce no chunks"
    assert cited <= {1, 3}


def test_default_separators_run_coarse_to_fine():
    """The hierarchy must degrade gracefully, not jump straight to characters."""
    assert DEFAULT_SEPARATORS[0] == "\n\n"
    assert DEFAULT_SEPARATORS[-1] == " "
    assert "" not in DEFAULT_SEPARATORS, "the empty separator is handled as an explicit fallback"


def test_chunk_is_immutable():
    chunk = chunk_pages([Page(number=1, text="Hello.")])[0]
    assert isinstance(chunk, Chunk)
    # A frozen dataclass raises FrozenInstanceError, a subclass of
    # AttributeError -- specific, not a blind `Exception` catch.
    with pytest.raises(AttributeError):
        chunk.text = "tampered"  # frozen dataclass
