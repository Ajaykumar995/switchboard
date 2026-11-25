import crypto from 'node:crypto';
import { Request, Response, NextFunction } from 'express';
import { config } from './config.js';
import { getRedis } from './redis.js';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const JWKS = createRemoteJWKSet(new URL(`${config.oidc.issuer}/jwks`));
const SESSION_TTL = 60 * 60 * 24 * 7; // 7 days
const PKCE_TTL = 5 * 60; // 5 minutes

export interface SessionData {
  sub: string;
  workspaces: Array<{ id: string; role: string }>;
}

async function storeSession(sessionId: string, data: SessionData): Promise<void> {
  const redis = getRedis();
  await redis.setex(`session:${sessionId}`, SESSION_TTL, JSON.stringify(data));
}

export async function getSession(sessionId: string): Promise<SessionData | null> {
  const redis = getRedis();
  const data = await redis.get(`session:${sessionId}`);
  return data ? JSON.parse(data) : null;
}

async function deleteSession(sessionId: string): Promise<void> {
  const redis = getRedis();
  await redis.del(`session:${sessionId}`);
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const sessionId = req.cookies?.sb_session;
  if (!sessionId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  getSession(sessionId).then(session => {
    if (!session) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    (req as any).session = session;
    next();
  }).catch(() => {
    res.status(401).json({ error: 'Unauthorized' });
  });
}

export function requireWorkspace(workspaceId: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const session = (req as any).session as SessionData | undefined;
    if (!session) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const ws = session.workspaces.find(w => w.id === workspaceId);
    if (!ws) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    (req as any).workspaceRole = ws.role;
    next();
  };
}

export async function authLogin(req: Request, res: Response): Promise<void> {
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  const state = crypto.randomBytes(16).toString('base64url');

  const redis = getRedis();
  await redis.setex(`pkce:${state}`, PKCE_TTL, codeVerifier);

  const params = new URLSearchParams({
    client_id: config.oidc.clientId,
    redirect_uri: config.oidc.redirectUri,
    response_type: 'code',
    scope: 'openid profile email',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
  });

  res.redirect(`${config.oidc.issuer}/authorize?${params.toString()}`);
}

export async function authCallback(req: Request, res: Response): Promise<void> {
  const { code, state, error } = req.query as { code?: string; state?: string; error?: string };

  if (error) {
    res.redirect(`${config.webOrigin}/login?error=${encodeURIComponent(error)}`);
    return;
  }

  if (!code || !state) {
    res.status(400).send('Missing code or state');
    return;
  }

  const redis = getRedis();
  const codeVerifier = await redis.get(`pkce:${state}`);
  await redis.del(`pkce:${state}`);

  if (!codeVerifier) {
    res.status(400).send('Invalid or expired state');
    return;
  }

  try {
    const tokenResp = await fetch(`${config.oidc.issuer}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: config.oidc.redirectUri,
        client_id: config.oidc.clientId,
        client_secret: config.oidc.clientSecret,
        code_verifier: codeVerifier,
      }),
    });

    if (!tokenResp.ok) {
      throw new Error('Token exchange failed');
    }

    const tokens = await tokenResp.json() as { id_token: string; access_token: string };

    const { payload } = await jwtVerify(tokens.id_token, JWKS, {
      issuer: config.oidc.issuer,
      audience: config.oidc.clientId,
    });

    const sessionData: SessionData = {
      sub: payload.sub as string,
      workspaces: (payload.workspaces as Array<{ id: string; role: string }>) || [],
    };

    const sessionId = crypto.randomBytes(32).toString('hex');
    await storeSession(sessionId, sessionData);

    res.cookie('sb_session', sessionId, {
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      maxAge: SESSION_TTL * 1000,
      path: '/',
    });

    res.redirect(config.webOrigin);
  } catch (err) {
    console.error('Auth callback error:', err);
    res.redirect(`${config.webOrigin}/login?error=auth_failed`);
  }
}

export async function apiMe(req: Request, res: Response): Promise<void> {
  const session = (req as any).session as SessionData;
  if (!session) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  res.json({ sub: session.sub, workspaces: session.workspaces });
}

export async function apiLogout(req: Request, res: Response): Promise<void> {
  const sessionId = req.cookies?.sb_session;
  if (sessionId) {
    await deleteSession(sessionId);
  }
  res.clearCookie('sb_session', { path: '/' });
  res.json({ ok: true });
}