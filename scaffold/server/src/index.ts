import express from 'express';
import cookieParser from 'cookie-parser';
import { createServer } from 'node:http';
import { config } from './config.js';
import { healthCheck } from './health.js';
import { rawBodyMiddleware, handlePigeonWebhook } from './webhook.js';
import { graderReset, graderSnapshot, graderClaim, graderReply } from './grader.js';
import { runDeliveryWorker } from './worker.js';
import { authLogin, authCallback, apiMe, apiLogout, requireAuth, requireWorkspace } from './auth.js';
import { createWSServer, broadcastEvent, startRedisListener } from './websocket.js';
import { initCollections, getConversations, getMessages, getOutbound } from './collections.js';
import { getDb } from './db.js';
import type { Conversation, Message, OutboundMessage } from './types.js';

const app = express();

// Parse cookies for session auth
app.use(cookieParser());

// Parse JSON for all routes except webhook (which needs raw body)
app.use((req, res, next) => {
  if (req.path === '/webhooks/pigeon') {
    return next();
  }
  express.json()(req, res, next);
});

// Health check
app.get('/healthz', healthCheck);

// Pigeon webhook - needs raw body for HMAC verification
app.post('/webhooks/pigeon', rawBodyMiddleware, handlePigeonWebhook);

// Grader endpoints
app.post('/__grader/reset', graderReset);
app.get('/__grader/snapshot', graderSnapshot);
app.post('/__grader/claim', graderClaim);
app.post('/__grader/reply', graderReply);

// Auth routes
app.get('/auth/login', authLogin);
app.get('/auth/callback', authCallback);
app.get('/api/me', requireAuth, apiMe);
app.post('/api/logout', requireAuth, apiLogout);

// Workspace-scoped API routes
app.get('/api/conversations', requireAuth, requireWorkspaceQuery, async (req, res) => {
  try {
    await initCollections();
    const conversations = await getConversations();
    const workspace = (req as any).workspaceId;
    const convs = await conversations
      .find({ workspace })
      .sort({ updatedAt: -1 })
      .toArray();
    res.json(convs);
  } catch (error) {
    console.error('Get conversations error:', error);
    res.status(500).send('Internal error');
  }
});

app.get('/api/conversations/:contact/messages', requireAuth, requireWorkspaceQuery, async (req, res) => {
  try {
    await initCollections();
    const messages = await getMessages();
    const workspace = (req as any).workspaceId;
    const contact = req.params.contact;
    const msgs = await messages
      .find({ workspace, contact })
      .sort({ occurredAt: 1 })
      .toArray();
    res.json(msgs);
  } catch (error) {
    console.error('Get messages error:', error);
    res.status(500).send('Internal error');
  }
});

app.post('/api/conversations/:contact/claim', requireAuth, requireWorkspaceQuery, async (req, res) => {
  try {
    await initCollections();
    const conversations = await getConversations();
    const workspace = (req as any).workspaceId;
    const contact = req.params.contact;
    const agent = req.body.agent;
    if (!agent) {
      res.status(400).send('Missing agent');
      return;
    }
    const result = await conversations.findOneAndUpdate(
      { workspace, contact, assignee: { $in: [null, agent] } },
      { $set: { assignee: agent, updatedAt: new Date() } },
      { returnDocument: 'after' }
    );
    if (!result) {
      res.status(409).send('Conflict');
      return;
    }
    res.status(200).send('OK');
  } catch (error) {
    console.error('Claim conversation error:', error);
    res.status(500).send('Internal error');
  }
});

app.post('/api/conversations/:contact/reply', requireAuth, requireWorkspaceQuery, async (req, res) => {
  try {
    await initCollections();
    const outbound = await getOutbound();
    const conversations = await getConversations();
    const workspace = (req as any).workspaceId;
    const contact = req.params.contact;
    const { text, client_ref } = req.body;
    if (!text || !client_ref) {
      res.status(400).send('Missing text or client_ref');
      return;
    }
    // Ensure conversation exists
    const convFilter = { workspace, contact };
    const existingConv = await conversations.findOne(convFilter);
    if (!existingConv) {
      await conversations.insertOne({
        workspace,
        contact,
        assignee: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
    const result = await outbound.findOneAndUpdate(
      { workspace, clientRef: client_ref },
      {
        $setOnInsert: {
          workspace,
          contact,
          clientRef: client_ref,
          text,
          status: 'queued',
          lockedUntil: null,
          workerId: null,
          retryCount: 0,
          nextRetryAt: null,
          pigeonMessageId: null,
          createdAt: new Date(),
        },
      },
      { upsert: true, returnDocument: 'after' }
    );
    if (!result) {
      res.status(500).send('Failed to queue outbound message');
      return;
    }
    res.status(202).send('Accepted');
  } catch (error) {
    console.error('Reply error:', error);
    res.status(500).send('Internal error');
  }
});

app.post('/api/conversations/:contact/close', requireAuth, requireWorkspaceQuery, async (req, res) => {
  try {
    await initCollections();
    const conversations = await getConversations();
    const workspace = (req as any).workspaceId;
    const contact = req.params.contact;
    await conversations.updateOne(
      { workspace, contact },
      { $set: { assignee: null, updatedAt: new Date() } }
    );
    res.status(200).send('OK');
  } catch (error) {
    console.error('Close conversation error:', error);
    res.status(500).send('Internal error');
  }
});

app.post('/api/conversations/:contact/reopen', requireAuth, requireWorkspaceQuery, async (req, res) => {
  try {
    await initCollections();
    const conversations = await getConversations();
    const workspace = (req as any).workspaceId;
    const contact = req.params.contact;
    const agent = req.body.agent;
    if (!agent) {
      res.status(400).send('Missing agent');
      return;
    }
    const result = await conversations.findOneAndUpdate(
      { workspace, contact, assignee: null },
      { $set: { assignee: agent, updatedAt: new Date() } },
      { returnDocument: 'after' }
    );
    if (!result) {
      res.status(409).send('Conflict');
      return;
    }
    res.status(200).send('OK');
  } catch (error) {
    console.error('Reopen conversation error:', error);
    res.status(500).send('Internal error');
  }
});

// WebSocket server
const server = createServer(app);
const wss = createWSServer(server);
startRedisListener(wss);

// Export broadcastEvent for worker to use
(globalThis as any).broadcastEvent = broadcastEvent;

server.listen(config.port, () => {
  console.log(`server on http://localhost:${config.port}`);

  // Start delivery worker
  runDeliveryWorker().catch(err => {
    console.error('Failed to start delivery worker:', err);
  });
});

// Middleware to extract workspace from query for workspace-scoped routes
function requireWorkspaceQuery(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const workspace = req.query.workspace as string;
  if (!workspace) {
    res.status(400).send('Missing workspace query parameter');
    return;
  }
  const session = (req as any).session;
  const ws = session.workspaces.find((w: any) => w.id === workspace);
  if (!ws) {
    res.status(403).send('Forbidden');
    return;
  }
  (req as any).workspaceId = workspace;
  (req as any).workspaceRole = ws.role;
  next();
}