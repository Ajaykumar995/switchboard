const API_BASE = '/api';
const AUTH_BASE = '/auth';

export interface Workspace {
  id: string;
  role: string;
}

export interface SessionData {
  sub: string;
  workspaces: Workspace[];
}

export interface Conversation {
  _id: string;
  workspace: string;
  contact: string;
  assignee: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  _id: string;
  workspace: string;
  conversationId: string;
  contact: string;
  messageId: string;
  text: string;
  direction: 'inbound' | 'outbound';
  occurredAt: string;
  createdAt: string;
}

export interface OutboundMessage {
  _id: string;
  workspace: string;
  contact: string;
  clientRef: string;
  text: string;
  status: 'queued' | 'sent' | 'delivered' | 'failed';
  lockedUntil: string | null;
  workerId: string | null;
  retryCount: number;
  nextRetryAt: string | null;
  pigeonMessageId: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function login(): Promise<void> {
  window.location.href = `${AUTH_BASE}/login`;
}

export async function logout(): Promise<void> {
  await fetch(`${API_BASE}/logout`, { method: 'POST', credentials: 'include' });
  window.location.href = '/login';
}

export async function fetchMe(): Promise<SessionData | null> {
  const res = await fetch(`${API_BASE}/me`, { credentials: 'include' });
  if (!res.ok) return null;
  return res.json();
}

export async function fetchConversations(workspace: string): Promise<Conversation[]> {
  const res = await fetch(`${API_BASE}/conversations?workspace=${encodeURIComponent(workspace)}`, { credentials: 'include' });
  if (!res.ok) throw new Error('Failed to fetch conversations');
  return res.json();
}

export async function fetchMessages(workspace: string, contact: string): Promise<Message[]> {
  const res = await fetch(`${API_BASE}/conversations/${encodeURIComponent(contact)}/messages?workspace=${encodeURIComponent(workspace)}`, { credentials: 'include' });
  if (!res.ok) throw new Error('Failed to fetch messages');
  return res.json();
}

export async function claimConversation(workspace: string, contact: string, agent: string): Promise<boolean> {
  const res = await fetch(`${API_BASE}/conversations/${encodeURIComponent(contact)}/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent }),
    credentials: 'include',
  });
  return res.ok;
}

export async function replyToConversation(workspace: string, contact: string, text: string, clientRef: string): Promise<boolean> {
  const res = await fetch(`${API_BASE}/conversations/${encodeURIComponent(contact)}/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, client_ref: clientRef }),
    credentials: 'include',
  });
  return res.ok;
}

export async function closeConversation(workspace: string, contact: string): Promise<boolean> {
  const res = await fetch(`${API_BASE}/conversations/${encodeURIComponent(contact)}/close`, {
    method: 'POST',
    credentials: 'include',
  });
  return res.ok;
}

export async function reopenConversation(workspace: string, contact: string, agent: string): Promise<boolean> {
  const res = await fetch(`${API_BASE}/conversations/${encodeURIComponent(contact)}/reopen`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent }),
    credentials: 'include',
  });
  return res.ok;
}