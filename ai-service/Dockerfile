# Python AI service (FastAPI): extract -> chunk -> embed -> Chroma -> retrieve
# -> generate. Build context is this directory (ai-service/).

FROM python:3.12-slim AS base

# - PYTHONDONTWRITEBYTECODE: no .pyc files in the image layer.
# - PYTHONUNBUFFERED: logs flush immediately, so `docker logs` is live rather
#   than showing nothing until a buffer fills.
# - PIP_NO_CACHE_DIR: pip's download cache is useless in an image and only adds
#   weight.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/models

WORKDIR /app

# Dependencies first, in their own layer: requirements.txt changes far less
# often than the source, so this pip install is cached across code-only builds.
COPY requirements.txt ./
RUN pip install -r requirements.txt

# Then the application code.
COPY app ./app

# NOTE ON THE EMBEDDING MODEL
# sentence-transformers downloads all-MiniLM-L6-v2 (~90 MB) on the FIRST embed
# call. That makes the first index request slow and requires network at
# runtime. To bake it into the image instead -- the right move for a real
# deploy -- uncomment the next line; it pre-fetches the model into HF_HOME so
# the container starts answer-ready and needs no network:
# RUN python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('all-MiniLM-L6-v2')"

# Run as a non-root user: a container process that is root is root on the host
# kernel if it escapes. `--system` avoids allocating a login/home.
RUN useradd --system --create-home appuser \
    && mkdir -p /data/chroma /models \
    && chown -R appuser:appuser /app /data /models
USER appuser

EXPOSE 8000

# /health is unauthenticated by design (the internal-key guard is only on the
# real endpoints), so it is a valid container healthcheck.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health')" || exit 1

# No --reload in production: it watches the filesystem and forks workers, which
# is dev-only behaviour.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
