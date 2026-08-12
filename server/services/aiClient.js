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

  /** Submits natural language question to RAG pipeline and returns the raw stream response for SSE. */
  async queryRagStream({ question, knowledgeBaseId, history = [] }) {
    const url = `${config.aiServiceUrl}/query`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Key': config.internalApiKey,
      },
      body: JSON.stringify({
        question,
        knowledge_base_id: String(knowledgeBaseId),
        history,
      }),
    });

    if (!response.ok) {
      throw new Error(`AI Microservice query error: status ${response.status}`);
    }

    return response;
  },
};
