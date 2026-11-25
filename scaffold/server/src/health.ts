import { Request, Response } from 'express';
import { getDb } from './db.js';
import { getRedis } from './redis.js';

export async function healthCheck(req: Request, res: Response): Promise<void> {
  try {
    // Check MongoDB
    const db = await getDb();
    await db.command({ ping: 1 });

    // Check Redis
    const redis = getRedis();
    await redis.ping();

    res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Health check failed:', error);
    res.status(503).json({ ok: false });
  }
}