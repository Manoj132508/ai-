/**
 * Single import point for models.
 *
 * Importing this module registers every schema with Mongoose, which matters
 * for two reasons: `populate()` needs the referenced model to be registered
 * before it runs, and `autoIndex` only builds indexes for models that have
 * been defined. A model imported lazily by one route would have its indexes
 * created the first time that route is hit, in production, under load.
 */
export { User } from './User.js';
export { KnowledgeBase } from './KnowledgeBase.js';
export { Document, DOCUMENT_STATUSES } from './Document.js';
export { Conversation } from './Conversation.js';
export { Message, MESSAGE_ROLES, MESSAGE_STATUSES } from './Message.js';
