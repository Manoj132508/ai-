import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { ok, okPaginated, noContent } from '../utils/respond.js';
import { findOwned } from '../utils/ownership.js';
import { aiClient } from '../services/aiClient.js';
import { KnowledgeBase, Conversation, Message } from '../models/index.js';

const HISTORY_TURNS = 3;

export const listConversations = asyncHandler(async (req, res) => {
  const kb = await findOwned(KnowledgeBase, req.params.id, req.user.id, 'KB_NOT_FOUND');

  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
  const filter = { knowledgeBaseId: kb._id, userId: req.user.id };

  const [items, total] = await Promise.all([
    // { knowledgeBaseId: 1, lastMessageAt: -1 } -- equality then sort, so the
    // index serves the ordering and no in-memory sort happens.
    Conversation.find(filter).sort({ lastMessageAt: -1 }).skip((page - 1) * limit).limit(limit),
    Conversation.countDocuments(filter),
  ]);

  return okPaginated(res, items, { page, limit, total });
});

export const listMessages = asyncHandler(async (req, res) => {
  const conversation = await findOwned(
    Conversation, req.params.id, req.user.id, 'KB_NOT_FOUND',
  );
  // Oldest first: a transcript reads forwards.
  const messages = await Message.find({ conversationId: conversation._id }).sort({ createdAt: 1 });
  return ok(res, { conversation, messages });
});

export const deleteConversation = asyncHandler(async (req, res) => {
  const conversation = await findOwned(
    Conversation, req.params.id, req.user.id, 'KB_NOT_FOUND',
  );
  await Message.deleteMany({ conversationId: conversation._id });
  await Conversation.deleteOne({ _id: conversation._id });
  return noContent(res);
});

/**
 * Ask a question. Streams the answer to the browser as Server-Sent Events.
 *
 * This is the proxy described in ADR 002: generation happens in the Python
 * service because that is where the retrieved context lives, so Node has to
 * forward a stream it does not produce. Three things make that non-trivial,
 * and all three are handled below: propagating a client disconnect upstream,
 * persisting a partial answer, and reporting an error that arrives *after*
 * headers are already sent.
 */
export const ask = asyncHandler(async (req, res) => {
  const kb = await findOwned(KnowledgeBase, req.params.id, req.user.id, 'KB_NOT_FOUND');

  const question = typeof req.body?.question === 'string' ? req.body.question.trim() : '';
  if (!question) {
    throw new ApiError('VALIDATION_ERROR', 'Please enter a question.', {
      fields: { question: 'A question is required.' },
    });
  }

  // Refused before any work: asking an empty knowledge base can only produce
  // a confusing non-answer. The UI blocks it too, but the API cannot rely on
  // that -- anyone can call this directly.
  if (kb.chunkCount === 0) throw new ApiError('KB_EMPTY');

  let conversation = req.body.conversationId
    ? await findOwned(Conversation, req.body.conversationId, req.user.id, 'KB_NOT_FOUND')
    : await Conversation.create({
        knowledgeBaseId: kb._id,
        userId: req.user.id,
        // Auto-titled from the first question: nobody names a conversation
        // before having it.
        title: question.slice(0, 80),
        lastMessageAt: new Date(),
      });

  await Message.create({
    conversationId: conversation._id,
    userId: req.user.id,
    role: 'user',
    content: question,
    status: 'complete',
  });

  const priorTurns = await Message.find({ conversationId: conversation._id })
    .sort({ createdAt: -1 })
    .limit(HISTORY_TURNS * 2 + 1)
    .lean();

  const history = priorTurns
    .reverse()
    .slice(0, -1) // drop the question just written
    .map((message) => ({ role: message.role, content: message.content }));

  /*
   * Propagating cancellation.
   *
   * Aborting bounds the waste rather than eliminating it -- output tokens are
   * billed as they are GENERATED, so whatever was produced before the
   * disconnect is already paid for. What this prevents is every token after
   * it, for an answer nobody will read.
   */
  const abortUpstream = new AbortController();
  let clientGone = false;
  req.on('close', () => {
    if (!res.writableEnded) {
      clientGone = true;
      abortUpstream.abort();
    }
  });

  let upstream;
  try {
    upstream = await aiClient.queryRagStream({
      question,
      knowledgeBaseId: kb._id,
      history,
      signal: abortUpstream.signal,
      requestId: req.id,
    });
  } catch (err) {
    // Still before headers, so a normal error response is possible.
    req.log.error('ai service unreachable', { detail: err.message });
    throw new ApiError('AI_SERVICE_UNAVAILABLE');
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // nginx buffers proxied responses by default, which would hold every
    // token until the answer finished -- turning a stream into a long pause
    // followed by a wall of text.
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  send({ type: 'conversation', conversationId: String(conversation._id) });

  let answer = '';
  let citations = [];
  let retrievalMeta = {};
  let completed = false;
  let streamError = null;
  const startedAt = Date.now();
  let buffer = '';

  /*
   * An explicit reader, not `for await (… of upstream.body)`.
   *
   * `upstream.body` is a WHATWG ReadableStream from undici, and async
   * iteration over it silently yielded zero chunks here -- no error, no
   * warning, just an empty loop that ended the response after the first
   * hand-written event. getReader() is the portable form and behaves the same
   * in Node and in the browser.
   */
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;

      // SSE frames are newline-delimited but a network chunk can split one in
      // half, so the tail is buffered rather than parsed as if it were whole.
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';

      for (const frame of frames) {
        const line = frame.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;

        const event = JSON.parse(line.slice(6));

        if (event.type === 'meta') {
          retrievalMeta = {
            topScore: event.top_score,
            retrievedCount: event.retrieved,
            grounded: event.grounded,
          };
        } else if (event.type === 'token') {
          answer += event.text;
        } else if (event.type === 'citations') {
          citations = event.citations;
        } else if (event.type === 'error') {
          streamError = event.message;
        } else if (event.type === 'done') {
          completed = true;
        }

        // Forwarded verbatim, so the browser sees exactly the event stream
        // the pipeline produced.
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    }
  } catch (err) {
    if (!clientGone) {
      /*
       * An error AFTER headers were sent. The status line is long gone, so a
       * 503 is impossible -- the only way to tell the browser is an in-band
       * event. This is the case the error handler's res.headersSent branch
       * exists as a backstop for.
       */
      req.log.error('stream failed mid-answer', { detail: err.message });
      streamError = 'The answer was interrupted. Please try again.';
      send({ type: 'error', code: 'LLM_UNAVAILABLE', message: streamError });
      // Always terminate the stream with 'done', even after an error, so every
      // stream ends the same way and the client never has to guess whether
      // more is coming.
      send({ type: 'done' });
    }
  }

  /*
   * Persist when there is something to persist.
   *
   * `completed` alone is NOT enough: a run that fails before the first token
   * finishes cleanly with an empty answer, and `content` is a required field,
   * so creating that message throws -- after headers are sent, where the only
   * remaining option is to destroy the socket. The client then sees a hang
   * rather than the error it was already shown.
   *
   * When generation failed with no output, the error text is stored as the
   * message with status 'failed'. Storing nothing would leave a question with
   * no reply in the transcript, so reloading the conversation would look like
   * the answer simply vanished.
   */
  if (answer || streamError) {
    await Message.create({
      conversationId: conversation._id,
      userId: req.user.id,
      role: 'assistant',
      content: answer || streamError,
      status: answer ? (completed ? 'complete' : 'partial') : 'failed',
      citations: citations.map((citation) => ({
        documentId: citation.documentId,
        documentName: citation.documentName,
        page: citation.page,
        score: citation.score,
        snippet: citation.snippet,
      })),
      retrievalMeta,
      latencyMs: Date.now() - startedAt,
    });

    await Conversation.updateOne(
      { _id: conversation._id },
      {
        lastMessageAt: new Date(),
        messageCount: await Message.countDocuments({ conversationId: conversation._id }),
      },
    );
  }

  if (clientGone) {
    // Logged with a distinct reason so "the user left" and "we crashed" do
    // not look identical in the metrics.
    req.log.info('answer abandoned by client', {
      conversationId: String(conversation._id),
      charsGenerated: answer.length,
      reason: 'client_disconnect',
    });
  }

  if (!res.writableEnded) res.end();
});
