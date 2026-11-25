import { Db, Collection } from 'mongodb';
import { getDb } from './db.js';
import type { Conversation, Message, OutboundMessage } from './types.js';

let initialized = false;

export async function initCollections(): Promise<void> {
  if (initialized) return;
  const db = await getDb();

  // Conversations collection
  const conversations = db.collection<Conversation>('conversations');
  await conversations.createIndexes([
    { key: { workspace: 1, contact: 1 }, unique: true, name: 'ws_contact_unique' },
    { key: { workspace: 1, assignee: 1 }, name: 'ws_assignee' },
  ]);

  // Messages collection (inbound)
  const messages = db.collection<Message>('messages');
  await messages.createIndexes([
    { key: { workspace: 1, conversationId: 1, occurredAt: 1, messageId: 1 }, name: 'conv_order' },
    { key: { workspace: 1, messageId: 1 }, unique: true, name: 'ws_msgid_unique' },
  ]);

  // Outbound messages collection
  const outbound = db.collection<OutboundMessage>('outbound_messages');
  await outbound.createIndexes([
    { key: { workspace: 1, clientRef: 1 }, unique: true, name: 'ws_clientref_unique' },
    { key: { status: 1, lockedUntil: 1, nextRetryAt: 1 }, name: 'delivery_poll' },
    { key: { workspace: 1, status: 1 }, name: 'ws_status' },
  ]);

  initialized = true;
}

export async function getConversations(): Promise<Collection<Conversation>> {
  const db = await getDb();
  return db.collection<Conversation>('conversations');
}

export async function getMessages(): Promise<Collection<Message>> {
  const db = await getDb();
  return db.collection<Message>('messages');
}

export async function getOutbound(): Promise<Collection<OutboundMessage>> {
  const db = await getDb();
  return db.collection<OutboundMessage>('outbound_messages');
}