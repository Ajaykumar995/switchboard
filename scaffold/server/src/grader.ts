import { Request, Response } from 'express';
import { config } from './config.js';
import { initCollections, getConversations, getMessages, getOutbound } from './collections.js';
import { getRedis } from './redis.js';
import { getDb } from './db.js';
import type { Conversation, Message, OutboundMessage, SnapshotResponse, SnapshotWorkspace, SnapshotContact } from './types.js';

function requireGraderToken(req: Request, res: Response): boolean {
  const token = req.header('x-grader-token');
  if (token !== config.graderToken) {
    res.status(401).send('Unauthorized');
    return false;
  }
  return true;
}

export async function graderReset(req: Request, res: Response): Promise<void> {
  if (!requireGraderToken(req, res)) return;

  try {
    const db = await getDb();
    await db.collection('conversations').deleteMany({});
    await db.collection('messages').deleteMany({});
    await db.collection('outbound_messages').deleteMany({});

    const redis = getRedis();
    // Clear Redis keys related to rate limiting and leases
    const keys = await redis.keys('ratelimit:*');
    if (keys.length > 0) {
      await redis.del(...keys);
    }
    const leaseKeys = await redis.keys('lease:*');
    if (leaseKeys.length > 0) {
      await redis.del(...leaseKeys);
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('Grader reset error:', error);
    res.status(500).send('Internal error');
  }
}

export async function graderSnapshot(req: Request, res: Response): Promise<void> {
  if (!requireGraderToken(req, res)) return;

  try {
    await initCollections();
    const conversations = await getConversations();
    const messages = await getMessages();
    const outbound = await getOutbound();

    const allConversations = await conversations.find({}).toArray();
    const allMessages = await messages.find({}).toArray();
    const allOutbound = await outbound.find({}).toArray();

    const workspaces: Record<string, SnapshotWorkspace> = {};

    // Group by workspace
    for (const conv of allConversations) {
      const wsId = conv.workspace;
      if (!workspaces[wsId]) {
        workspaces[wsId] = { contacts: {}, outbound: {} };
      }

      const contactMsgs = allMessages
        .filter(m => m.workspace === wsId && m.contact === conv.contact)
        .sort((a, b) => {
          const timeDiff = a.occurredAt.getTime() - b.occurredAt.getTime();
          if (timeDiff !== 0) return timeDiff;
          return a.messageId.localeCompare(b.messageId);
        })
        .map(m => m.messageId);

      workspaces[wsId].contacts[conv.contact] = {
        inbound: contactMsgs,
        assignee: conv.assignee,
      };
    }

    // Add outbound messages
    for (const ob of allOutbound) {
      const wsId = ob.workspace;
      if (!workspaces[wsId]) {
        workspaces[wsId] = { contacts: {}, outbound: {} };
      }
      workspaces[wsId].outbound[ob.clientRef] = ob.status;
    }

    const response: SnapshotResponse = { workspaces };
    res.status(200).json(response);
  } catch (error) {
    console.error('Grader snapshot error:', error);
    res.status(500).send('Internal error');
  }
}

export async function graderClaim(req: Request, res: Response): Promise<void> {
  if (!requireGraderToken(req, res)) return;

  try {
    await initCollections();
    const conversations = await getConversations();

    const { workspace, contact, agent } = req.body as {
      workspace: string;
      contact: string;
      agent: string;
    };

    if (!workspace || !contact || !agent) {
      res.status(400).send('Missing required fields');
      return;
    }

    // Atomic findOneAndUpdate to claim conversation
    // First ensure conversation exists
    await conversations.updateOne(
      { workspace, contact },
      {
        $setOnInsert: {
          workspace,
          contact,
          assignee: null,
          createdAt: new Date(),
        },
      },
      { upsert: true }
    );

    // Then atomically claim if unassigned or already ours
    const result = await conversations.findOneAndUpdate(
      { workspace, contact, assignee: { $in: [null, agent] } },
      {
        $set: {
          assignee: agent,
          updatedAt: new Date(),
        },
      },
      { returnDocument: 'after' }
    );

    if (!result) {
      // Another agent holds it
      res.status(409).send('Conflict');
      return;
    }

    const conversation = result;
    if (conversation.assignee === agent) {
      res.status(200).send('OK');
    } else {
      res.status(409).send('Conflict');
    }
  } catch (error) {
    console.error('Grader claim error:', error);
    res.status(500).send('Internal error');
  }
}

export async function graderReply(req: Request, res: Response): Promise<void> {
  if (!requireGraderToken(req, res)) return;

  try {
    await initCollections();
    const outbound = await getOutbound();
    const conversations = await getConversations();

    const { workspace, contact, text, client_ref } = req.body as {
      workspace: string;
      contact: string;
      text: string;
      client_ref: string;
    };

    if (!workspace || !contact || !text || !client_ref) {
      res.status(400).send('Missing required fields');
      return;
    }

    // Validate workspace exists
    const validWorkspaces = ['ws_acme', 'ws_globex'];
    if (!validWorkspaces.includes(workspace)) {
      res.status(404).send('Workspace not found');
      return;
    }

    // Ensure conversation exists
    await conversations.updateOne(
      { workspace, contact },
      {
        $setOnInsert: {
          workspace,
          contact,
          assignee: null,
          createdAt: new Date(),
        },
      },
      { upsert: true }
    );

    // Atomically upsert outbound message by (workspace, client_ref)
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
    console.error('Grader reply error:', error);
    res.status(500).send('Internal error');
  }
}