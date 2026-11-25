import crypto from 'node:crypto';
import { config } from './config.js';
import { getOutbound } from './collections.js';
import { getRedis } from './redis.js';
import type { OutboundMessage } from './types.js';

const WORKER_ID = `worker-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
const LEASE_DURATION_MS = 15000; // 15 seconds
const POLL_INTERVAL_MS = 2000; // 2 seconds
const MAX_RETRY_COUNT = 10;
const BASE_BACKOFF_MS = 1000;

interface RateLimitInfo {
  tokens: number;
  lastRefill: number;
  retryAfterUntil: number; // Unix timestamp in ms
}

async function getRateLimitInfo(workspace: string): Promise<RateLimitInfo> {
  const redis = getRedis();
  const key = `ratelimit:${workspace}`;
  const data = await redis.hmget(key, 'tokens', 'lastRefill', 'retryAfterUntil');

  const now = Date.now();
  let tokens = data[0] ? parseFloat(data[0]) : 8; // Bucket of 8
  let lastRefill = data[1] ? parseInt(data[1], 10) : now;
  let retryAfterUntil = data[2] ? parseInt(data[2], 10) : 0;

  // Refill tokens (4 per second)
  const elapsed = (now - lastRefill) / 1000;
  const refillAmount = elapsed * 4;
  tokens = Math.min(8, tokens + refillAmount);
  lastRefill = now;

  // If in retry-after cooldown, tokens effectively 0
  if (retryAfterUntil > now) {
    tokens = 0;
  }

  await redis.hmset(key, {
    tokens: tokens.toString(),
    lastRefill: lastRefill.toString(),
    retryAfterUntil: retryAfterUntil.toString(),
  });
  await redis.expire(key, 60); // Expire after 60 seconds of inactivity

  return { tokens, lastRefill, retryAfterUntil };
}

async function consumeToken(workspace: string): Promise<boolean> {
  const redis = getRedis();
  const key = `ratelimit:${workspace}`;
  const now = Date.now();

  // Lua script for atomic token consumption
  const script = `
    local tokens = tonumber(redis.call('HGET', KEYS[1], 'tokens') or '8')
    local retryAfterUntil = tonumber(redis.call('HGET', KEYS[1], 'retryAfterUntil') or '0')
    local now = tonumber(ARGV[1])
    if retryAfterUntil > now then
      return 0
    end
    if tokens >= 1 then
      tokens = tokens - 1
      redis.call('HSET', KEYS[1], 'tokens', tokens)
      redis.call('EXPIRE', KEYS[1], 60)
      return 1
    end
    return 0
  `;

  const result = await redis.eval(script, 1, key, now.toString());
  return result === 1;
}

async function setRetryAfter(workspace: string, seconds: number): Promise<void> {
  const redis = getRedis();
  const key = `ratelimit:${workspace}`;
  const until = Date.now() + seconds * 1000;
  await redis.hset(key, 'retryAfterUntil', until.toString());
  await redis.expire(key, Math.max(60, seconds + 10));
}

async function sendToPigeon(message: OutboundMessage): Promise<{ success: boolean; status?: number; retryAfter?: number; pigeonId?: string }> {
  const apiKey = config.pigeon.apiKeys[message.workspace];
  if (!apiKey) {
    return { success: false, status: 400 };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12000); // 12 second timeout

  try {
    const response = await fetch(`${config.pigeon.url}/v1/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': message.clientRef,
      },
      body: JSON.stringify({
        to: message.contact,
        text: message.text,
        client_ref: message.clientRef,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      const data = await response.json() as { id: string; status: string };
      return { success: true, pigeonId: data.id };
    }

    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      const seconds = retryAfter ? parseInt(retryAfter, 10) : 5;
      return { success: false, status: 429, retryAfter: seconds };
    }

    if (response.status === 503) {
      return { success: false, status: 503 };
    }

    // Other errors (400, 401, etc.) - don't retry
    return { success: false, status: response.status };
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof DOMException && error.name === 'AbortError') {
      return { success: false, status: 408 }; // Timeout
    }
    // Network error or other - retry
    return { success: false, status: 0 };
  }
}

async function processOutboundMessage(message: OutboundMessage): Promise<void> {
  const outbound = await getOutbound();

  // Check rate limit
  const canSend = await consumeToken(message.workspace);
  if (!canSend) {
    // Rate limited, schedule retry
    const nextRetry = Date.now() + 1000; // Try again in 1 second
    await outbound.updateOne(
      { _id: message._id },
      { $set: { nextRetryAt: new Date(nextRetry), updatedAt: new Date() } }
    );
    return;
  }

  // Send to Pigeon
  const result = await sendToPigeon(message);

  if (result.success) {
    // Success - update status to sent
    await outbound.updateOne(
      { _id: message._id },
      {
        $set: {
          status: 'sent',
          pigeonMessageId: result.pigeonId,
          lockedUntil: null,
          workerId: null,
          nextRetryAt: null,
          updatedAt: new Date(),
        }
      }
    );
  } else if (result.status === 429 && result.retryAfter) {
    // Rate limited by Pigeon - set retry-after in Redis
    await setRetryAfter(message.workspace, result.retryAfter);

    // Schedule retry after the cool-off
    const nextRetry = Date.now() + result.retryAfter * 1000 + 100; // Small buffer
    await outbound.updateOne(
      { _id: message._id },
      {
        $set: {
          nextRetryAt: new Date(nextRetry),
          lockedUntil: null,
          workerId: null,
          updatedAt: new Date(),
        },
        $inc: { retryCount: 1 }
      }
    );
  } else if (result.status === 503 || result.status === 408 || result.status === 0) {
    // Retryable error - exponential backoff
    const retryCount = message.retryCount + 1;
    if (retryCount >= MAX_RETRY_COUNT) {
      // Max retries exceeded - mark as failed
      await outbound.updateOne(
        { _id: message._id },
        {
          $set: {
            status: 'failed',
            lockedUntil: null,
            workerId: null,
            nextRetryAt: null,
            updatedAt: new Date(),
          }
        }
      );
    } else {
      // Schedule retry with exponential backoff
      const backoff = BASE_BACKOFF_MS * Math.pow(2, retryCount - 1) + Math.random() * 1000;
      const nextRetry = Date.now() + Math.min(backoff, 60000); // Cap at 60 seconds
      await outbound.updateOne(
        { _id: message._id },
        {
          $set: {
            nextRetryAt: new Date(nextRetry),
            lockedUntil: null,
            workerId: null,
            updatedAt: new Date(),
          },
          $inc: { retryCount: 1 }
        }
      );
    }
  } else {
    // Non-retryable error - mark as failed
    await outbound.updateOne(
      { _id: message._id },
      {
        $set: {
          status: 'failed',
          lockedUntil: null,
          workerId: null,
          nextRetryAt: null,
          updatedAt: new Date(),
        }
      }
    );
  }
}

export async function runDeliveryWorker(): Promise<void> {
  console.log(`[${WORKER_ID}] Delivery worker started`);

  while (true) {
    try {
      const outbound = await getOutbound();
      const now = new Date();

      // Find messages to process: queued OR (sent but lease expired) OR (nextRetryAt <= now)
      // We use atomic lease acquisition
      const message = await outbound.findOneAndUpdate(
        {
          $or: [
            { status: 'queued' },
            { status: 'sent', lockedUntil: { $lt: now } },
            { nextRetryAt: { $lte: now }, status: { $in: ['queued', 'sent'] } }
          ]
        },
        {
          $set: {
            lockedUntil: new Date(Date.now() + LEASE_DURATION_MS),
            workerId: WORKER_ID,
            updatedAt: new Date(),
          }
        },
        { sort: { nextRetryAt: 1, createdAt: 1 }, returnDocument: 'after' }
      );

      if (message) {
        await processOutboundMessage(message);
      } else {
        // No messages to process, wait before polling again
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
      }
    } catch (error) {
      console.error(`[${WORKER_ID}] Worker error:`, error);
      await new Promise(resolve => setTimeout(resolve, 5000)); // Back off on error
    }
  }
}

// Start worker if this module is run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runDeliveryWorker().catch(console.error);
}