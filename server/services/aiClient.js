import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * Node.js API Gateway bridge to Python AI Microservice.
 *
 * All requests attach the internal API secret key in header X-Internal-Key (ADR 001).
 */

async function callAiService(endpoint, body) {
  const url = `${config.aiServiceUrl}${endpoint}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Key': config.internalApiKey,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    logger.error('AI microservice error response', {
      endpoint,
      status: response.status,
      body: errorText,
    });
    throw new Error(`AI Microservice error (${response.status}): ${errorText}`);
  }

  return response.json();
}

export const aiClient = {
  /** Ingests document file path into Python RAG service to extract, chunk, embed & index into Chroma. */
  async indexDocument({ documentId, knowledgeBaseId, filePath, filename, mimeType }) {
    return callAiService('/index', {
      document_id: String(documentId),
      knowledge_base_id: String(knowledgeBaseId),
      file_path: filePath,
      filename,
      mime_type: mimeType,
    });
  },

  /** Removes vector embeddings for a specific document from ChromaDB. */
  async deleteDocumentVectors({ knowledgeBaseId, documentId }) {
    return callAiService('/delete-document', {
      knowledge_base_id: String(knowledgeBaseId),
      document_id: String(documentId),
    });
  },

  /** Deletes the entire vector collection for a knowledge base. */
  async deleteCollection({ knowledgeBaseId }) {
    return callAiService('/delete-collection', {
      knowledge_base_id: String(knowledgeBaseId),
    });
  },

  /**
   * Submits a question and returns the raw streaming response for the caller
   * to proxy on to the browser.
   *
   * `signal` is what makes cancellation work end to end: aborting it tears
   * down this request, which the Python service observes as a client
   * disconnect, which closes its Anthropic stream and stops generation. Every
   * link in that chain has to be wired or tokens keep being produced for an
   * answer nobody will read.
   */
  async queryRagStream({ question, knowledgeBaseId, history = [], signal, requestId }) {
    const url = `${config.aiServiceUrl}/query`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Key': config.internalApiKey,
        // Same id both services log under, so one grep reconstructs the
        // request across the process boundary.
        ...(requestId ? { 'X-Request-Id': requestId } : {}),
      },
      body: JSON.stringify({
        question,
        knowledge_base_id: String(knowledgeBaseId),
        history,
        request_id: requestId ?? null,
      }),
      signal,
    });

    if (!response.ok) {
      throw new Error(`AI Microservice query error: status ${response.status}`);
    }

    return response;
  },
};

/**
 * Injection seam for the fire-and-forget index handoff.
 *
 * The upload controller resolves its indexer through getAiClient() rather than
 * importing `aiClient` directly, so a test can substitute a fake and assert the
 * handoff actually runs -- the seam that used to be skipped wholesale under
 * NODE_ENV=test (see the old comment in document.controller.js).
 *
 * The DEFAULT under test is `null`: no client, so an upload creates the row as
 * 'processing' and makes no background HTTP call -- exactly the behaviour the
 * existing upload suite relies on. A test that wants to exercise the handoff
 * opts in with setAiClient(fake), and resetAiClient() restores the default.
 * Outside test the default is the real client.
 */
let activeAiClient = config.isTest ? null : aiClient;

export function getAiClient() {
  return activeAiClient;
}

export function setAiClient(next) {
  activeAiClient = next;
}

export function resetAiClient() {
  activeAiClient = config.isTest ? null : aiClient;
}
