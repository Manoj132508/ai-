"""Text extraction from uploaded documents."""

from __future__ import annotations

from pathlib import Path

from app.pipeline.chunker import Page


class NoExtractableText(Exception):
    """Raised when a file parses but yields no usable text.

    Almost always a scanned PDF: a container of page images with no text
    layer. pypdf reads it happily and returns empty strings, so without this
    check the document would index as zero chunks and silently answer nothing
    forever. Surfacing it lets the API return FILE_NO_TEXT with advice the user
    can act on.
    """


def extract_pages(file_path: str | Path, mime_type: str) -> list[Page]:
    """Reads a document into per-page text.

    Page numbers are 1-indexed to match what a reader sees, and are carried
    all the way through chunking into citations -- so an off-by-one here would
    make every citation point one page early.
    """
    path = Path(file_path)
    if not path.exists():
        raise FileNotFoundError(f"File not found: {path}")

    if mime_type == "application/pdf" or path.suffix.lower() == ".pdf":
        pages = _extract_pdf(path)
    else:
        # Plain text and Markdown are one logical page. errors="replace"
        # rather than strict: a single bad byte should not fail an otherwise
        # readable document.
        pages = [Page(number=1, text=path.read_text(encoding="utf-8", errors="replace"))]

    if not any(page.text.strip() for page in pages):
        raise NoExtractableText(
            "No readable text could be extracted. This file may be a scanned "
            "image rather than a text PDF."
        )

    return pages


def _extract_pdf(path: Path) -> list[Page]:
    import pypdf

    reader = pypdf.PdfReader(str(path))
    return [
        Page(number=number, text=page.extract_text() or "")
        for number, page in enumerate(reader.pages, start=1)
    ]
