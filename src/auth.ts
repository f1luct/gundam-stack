import type { Context, Next } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Env } from './types';

export const COOKIE_NAME = 'gs_session';
const TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 天

function b64url(bytes: ArrayBuffer): string {
  const b = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function secretOf(env: Env): string {
  return env.SESSION_SECRET || env.APP_PASSWORD || 'dev-insecure-secret';
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return b64url(sig);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

export async function makeToken(env: Env): Promise<string> {
  const exp = String(Date.now() + TTL_MS);
  const sig = await hmac(secretOf(env), exp);
  return `${exp}.${sig}`;
}

export async function verifyToken(env: Env, token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot < 0) return false;
  const exp = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  const expected = await hmac(secretOf(env), exp);
  return timingSafeEqual(sig, expected);
}

// 校验密码（常量时间）
export function checkPassword(env: Env, password: string): boolean {
  if (!env.APP_PASSWORD || !password) return false;
  return timingSafeEqual(password, env.APP_PASSWORD);
}

export function authMiddleware() {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const cookie = getCookie(c, COOKIE_NAME);
    const bearer = (c.req.header('Authorization') || '').replace(/^Bearer\s+/i, '');
    const token = cookie || bearer;
    if (!(await verifyToken(c.env, token))) {
      return c.json({ error: '未登录' }, 401);
    }
    await next();
  };
}
