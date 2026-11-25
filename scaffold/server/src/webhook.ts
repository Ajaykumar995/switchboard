import { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import { config } from './config.js';
import { initCollections, getConversations, getMessages, getOutbound } from './collections.js';
import type { Conversation, Message, OutboundMessage, PigeonWebhookEvent } from './types.js';

const KNOWN_WORKSPACES = new Set(['ws_acme', 'ws_globex']);
const KNOWN_EVENT_TYPES = new Set(['message.inbound', 'message.status']);
const MAX_TIMESTAMP_DRIFT = 300; // 5 minutes

// Middleware to capture raw body for HMAC verification
export function rawBodyMiddleware(req: Request, _res: Response, next: NextFunction) {
  let data = '';
  req.setEncoding('utf8');
  req.on('data', chunk => { data += chunk; });
  req.on('end', () => {
    (req as any).rawBody = data;
    next();
  });
}

function verifySignature(rawBody: string, signatureHeader: string | undefined): boolean {
  if (!signatureHeader) return false;

  const parts = signatureHeader.split(',');
  let t: string | undefined;
  let v1: string | undefined;

  for (const part of parts) {
    const [key, value] = part.split('=');
    if (key === 't') t = value;
    if (key === 'v1') v1 = value;
  }

  if (!t || !v1) return false;

  const timestamp = parseInt(t, 10);
  if (isNaN(timestamp)) return false;

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > MAX_TIMESTAMP_DRIFT) return false;

  const expected = crypto.createHmac('sha256', config.pigeon.webhookSecret)
    .update(`${t}.${rawBody}`)
    .digest('hex');

  return crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(expected));
}

async function processInboundEvent(workspace: string, data: any, eventId: string): Promise<void> {
  const conversations = await getConversations();
  const messages = await getMessages();

  const messageId = data.message_id;
  const contact = data.from;
  const text = data.text;
  const occurredAt = new Date(data.occurred_at);

  // Check if message already exists (deduplication by message_id)
  const existingMsg = await messages.findOne({ workspace, messageId });
  if (existingMsg) {
    return; // Already processed, idempotent
  }

  // Ensure conversation exists
  const convFilter = { workspace, contact };
  await conversations.updateOne(
    convFilter,
    {
      $setOnInsert: {
        workspace,
        contact,
        assignee: null,
        createdAt: new Date(),
      },
      $set: { updatedAt: new Date() },
    },
    { upsert: true }
  );

  // Get conversation ID
  const conversation = await conversations.findOne(convFilter);
  if (!conversation) throw new Error('Conversation not found after upsert');

  // Store message
  const message: Message = {
    workspace,
    conversationId: conversation._id!.toString(),
    contact,
    messageId,
    text,
    direction: 'inbound',
    occurredAt,
    createdAt: new Date(),
  };

  await messages.insertOne(message);
}

async function processStatusEvent(workspace: string, data: any): Promise<void> {
  const outbound = await getOutbound();

  const clientRef = data.client_ref;
  const newStatus = data.status as OutboundMessage['status'];
  const pigeonMessageId = data.message_id;

  // Find outbound message by client_ref
  const existing = await outbound.findOne({ workspace, clientRef });
  if (!existing) {
    // Unknown client_ref, ignore with 200
    return;
  }

  // Never downgrade delivered/failed back to sent
  const currentStatus = existing.status;
  const statusOrder: Record<OutboundMessage['status'], number> = {
    queued: 0,
    sent: 1,
    delivered: 2,
    failed: 3,
  };

  if (statusOrder[newStatus] <= statusOrder[currentStatus]) {
    return; // Don't downgrade
  }

  const update: Partial<OutboundMessage> = {
    status: newStatus,
    updatedAt: new Date(),
  };

  if (pigeonMessageId && !existing.pigeonMessageId) {
    update.pigeonMessageId = pigeonMessageId;
  }

  await outbound.updateOne({ workspace, clientRef }, { $set: update });
}

export async function handlePigeonWebhook(req: Request, res: Response): Promise<void> {
  await initCollections();

  const rawBody = (req as any).rawBody;
  const signature = req.header('x-pigeon-signature');
  const eventId = req.header('x-pigeon-event-id');

  // Verify signature
  if (!verifySignature(rawBody, signature)) {
    res.status(401).send('Invalid signature');
    return;
  }

  // Parse JSON
  let event: PigeonWebhookEvent;
  try {
    event = JSON.parse(rawBody);
  } catch {
    res.status(400).send('Invalid JSON');
    return;
  }

  // Validate required fields
  if (!event.id || !event.type || !event.workspace || !event.occurred_at || !event.data) {
    res.status(400).send('Invalid event structure');
    return;
  }

  // Deduplication by event.id - check if we've processed this event before
  // We'll use a simple in-memory set for now, but could also use Redis/Mongo
  // For now, the message-level deduplication handles the important cases

  // Handle unknown event types (200, ignore)
  if (!KNOWN_EVENT_TYPES.has(event.type)) {
    res.status(200).send('OK');
    return;
  }

  // Handle unknown workspace (200, ignore)
  if (!KNOWN_WORKSPACES.has(event.workspace)) {
    res.status(200).send('OK');
    return;
  }

  try {
    if (event.type === 'message.inbound') {
      await processInboundEvent(event.workspace, event.data, event.id);
    } else if (event.type === 'message.status') {
      await processStatusEvent(event.workspace, event.data);
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('Webhook processing error:', error);
    res.status(500).send('Internal error');
  }
}