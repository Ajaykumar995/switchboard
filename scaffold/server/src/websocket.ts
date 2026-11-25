import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { parse } from 'url';
import { config } from './config.js';
import { getRedis } from './redis.js';
import { getSession } from './auth.js';

interface WSClient {
  ws: WebSocket;
  workspace: string;
  session: any;
}

const clients = new Map<string, Set<WSClient>>();

export function createWSServer(server: any): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', async (req: IncomingMessage, socket: any, head: Buffer) => {
    const { query } = parse(req.url || '', true);
    const workspace = query.workspace as string;
    const after = query.after ? parseInt(query.after as string, 10) : 0;

    if (!workspace) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    const cookieHeader = req.headers.cookie;
    if (!cookieHeader) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const cookies = Object.fromEntries(
      cookieHeader.split(';').map(c => c.trim().split('='))
    );
    const sessionId = cookies.sb_session;
    if (!sessionId) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const session = await getSession(sessionId);
    if (!session) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const isMember = session.workspaces.some((w: any) => w.id === workspace);
    if (!isMember) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, ws => {
      wss.emit('connection', ws, req, { workspace, session, after });
    });
  });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage, ctx: { workspace: string; session: any; after: number }) => {
    const { workspace, session, after } = ctx;
    const client: WSClient = { ws, workspace, session };

    if (!clients.has(workspace)) {
      clients.set(workspace, new Set());
    }
    clients.get(workspace)!.add(client);

    replayMissedEvents(ws, workspace, after).then(() => {
      // Start listening for new events via Redis Pub/Sub
    });

    ws.on('close', () => {
      clients.get(workspace)?.delete(client);
    });

    ws.on('error', () => {
      clients.get(workspace)?.delete(client);
    });
  });

  return wss;
}

async function replayMissedEvents(ws: WebSocket, workspace: string, after: number): Promise<void> {
  if (after <= 0) return;
  const redis = getRedis();
  const events = await redis.zrangebyscore(`ws:events:${workspace}`, after + 1, '+inf');
  for (const event of events) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(event);
    }
  }
}

export async function broadcastEvent(workspace: string, event: any): Promise<void> {
  const redis = getRedis();
  const seq = await redis.incr(`ws:seq:${workspace}`);
  const eventWithSeq = { ...event, seq };
  const eventStr = JSON.stringify(eventWithSeq);

  // Persist for replay
  await redis.zadd(`ws:events:${workspace}`, seq, eventStr);
  await redis.expire(`ws:events:${workspace}`, 86400); // 24 hours

  // Publish to all server copies
  await redis.publish(`ws:events:${workspace}`, eventStr);

  // Send to local clients
  const wsClients = clients.get(workspace);
  if (wsClients) {
    for (const client of wsClients) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(eventStr);
      }
    }
  }
}

export function startRedisListener(wss: WebSocketServer): void {
  const redis = getRedis();
  const sub = redis.duplicate();
  sub.psubscribe('ws:events:*');

  sub.on('pmessage', (pattern: string, channel: string, message: string) => {
    const workspace = channel.replace('ws:events:', '');
    const wsClients = clients.get(workspace);
    if (wsClients) {
      for (const client of wsClients) {
        if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.send(message);
        }
      }
    }
  });
}