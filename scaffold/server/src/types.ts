export interface InboundMessage {
  message_id: string;
  from: string;
  text: string;
}

export interface StatusMessage {
  message_id: string;
  client_ref: string;
  status: 'sent' | 'delivered' | 'failed';
}

export interface PigeonWebhookEvent {
  id: string;
  type: 'message.inbound' | 'message.status';
  workspace: string;
  occurred_at: string;
  data: InboundMessage | StatusMessage;
}

export interface Conversation {
  _id?: string;
  workspace: string;
  contact: string;
  assignee: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Message {
  _id?: string;
  workspace: string;
  conversationId: string;
  contact: string;
  messageId: string; // Pigeon's message_id
  text: string;
  direction: 'inbound';
  occurredAt: Date;
  createdAt: Date;
}

export interface OutboundMessage {
  _id?: string;
  workspace: string;
  contact: string;
  clientRef: string;
  text: string;
  status: 'queued' | 'sent' | 'delivered' | 'failed';
  lockedUntil: Date | null;
  workerId: string | null;
  retryCount: number;
  nextRetryAt: Date | null;
  pigeonMessageId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SnapshotContact {
  inbound: string[];
  assignee: string | null;
}

export interface SnapshotWorkspace {
  contacts: Record<string, SnapshotContact>;
  outbound: Record<string, string>;
}

export interface SnapshotResponse {
  workspaces: Record<string, SnapshotWorkspace>;
}

export type OutboundStatus = 'queued' | 'sent' | 'delivered' | 'failed';