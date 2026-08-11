# AI Knowledge Assistant

This workspace contains the Python environment and dependency scaffold for the
AI/RAG service. It intentionally contains no Phase 5 application features yet:
no API endpoints, document ingestion, chunking, embeddings, retrieval, or LLM
calls have been implemented.

## Prepared environment

- Python 3.12 virtual environment: `.venv`
- Runtime dependency list: `requirements.txt`
- Development dependency list: `requirements-dev.txt`
- Safe configuration template: `.env.example`

## Start a local PowerShell session

```powershell
Set-Location C:\Users\manoj\Desktop\ai-knowledge-assistant
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements-dev.txt
```

Dependencies have been listed but are not installed yet. Install them when
Phase 5 begins so that the resolved versions can be recorded deliberately.

## Add the API key safely

No usable `LLM_API_KEY` or `OPENAI_API_KEY` was available to this setup process,
so no real key was copied and no `.env` file was created.

For local development, create the ignored `.env` file from the template:

```powershell
Copy-Item .env.example .env
```

Then replace `your_key_here` inside `.env` with the real key. Keep the real key
only in `.env` or in the host's secret/environment-variable configuration.
Never put it in `.env.example`, source code, commits, screenshots, or chat.

When Phase 5 starts, the Python settings layer should read `LLM_API_KEY` from
the process environment. The provider-specific SDK will be chosen and added at
that point rather than assumed during setup.
