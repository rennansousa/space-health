// Client for the Space Health API (backend/server.py, endpoints listed in README.md).
// Works offline: the last good answer of every GET is cached on the device, and writes
// made without a connection wait in an outbox that is sent when the server is back.

import type { User } from '../types';
import { DemoError, demoRequest } from './demoServer';

const KEY_API = 'sh.apiBase';
const KEY_TOKEN = 'sh.token';
const KEY_USER = 'sh.user';
const KEY_CACHE = 'sh.cache.';
const KEY_OUTBOX = 'sh.outbox';

function store(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isNativeShell(): boolean {
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return Boolean(cap?.isNativePlatform?.());
}

/**
 * Server address. Order: saved in settings → VITE_API_URL → same origin (Vite dev proxy, or the
 * build served by server.py on any port) → same host on port 8000 (vite preview, Android, iOS).
 */
export function getApiBase(): string {
  const saved = store()?.getItem(KEY_API);
  if (saved) return saved.replace(/\/$/, '');
  const env = import.meta.env.VITE_API_URL as string | undefined;
  if (env) return env.replace(/\/$/, '');
  const { protocol, hostname, port } = window.location;
  if (import.meta.env.DEV) return ''; // Vite proxies /api to the server (vite.config.ts)
  if (port === '8000' || (port !== '4173' && !isNativeShell() && protocol.startsWith('http'))) return '';
  const host = hostname || '127.0.0.1';
  return `${protocol === 'https:' ? 'https' : 'http'}://${host}:8000`;
}

export function setApiBase(url: string): void {
  const s = store();
  if (!s) return;
  if (url.trim()) s.setItem(KEY_API, url.trim());
  else s.removeItem(KEY_API);
}

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const getToken = () => store()?.getItem(KEY_TOKEN) ?? null;

export function getUser(): User | null {
  try {
    const raw = store()?.getItem(KEY_USER);
    return raw ? (JSON.parse(raw) as User) : null;
  } catch {
    return null;
  }
}

export function saveSession(token: string, user: User): void {
  store()?.setItem(KEY_TOKEN, token);
  store()?.setItem(KEY_USER, JSON.stringify(user));
}

export function clearSession(): void {
  store()?.removeItem(KEY_TOKEN);
  store()?.removeItem(KEY_USER);
}

function isStaticDemoHost(): boolean {
  if (store()?.getItem(KEY_API)) return false;
  const h = window.location.hostname;
  return h.endsWith('.github.io') || h.endsWith('.vercel.app') || h.endsWith('.netlify.app');
}

function runDemo<T>(method: 'GET' | 'POST', path: string, body?: unknown): T {
  try {
    return demoRequest<T>(method, path, body, getUser());
  } catch (e) {
    if (e instanceof DemoError) throw new ApiError(e.status, e.message, e.code);
    throw e;
  }
}

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 8000): Promise<T> {
  const token = getToken();
  const isDemoSession = Boolean(token?.startsWith('demo-token-') && path !== '/api/users' && path !== '/api/login');
  if (isStaticDemoHost() || isDemoSession) {
    return runDemo<T>(method, path, body);
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const ctrl = new AbortController();
  const effectiveTimeout = path === '/api/users' ? Math.min(timeoutMs, 2500) : timeoutMs;
  const timer = setTimeout(() => ctrl.abort(), effectiveTimeout);
  let res: Response;
  try {
    res = await fetch(`${getApiBase()}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch {
    return runDemo<T>(method, path, body);
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 404 || res.status >= 500) {
    return runDemo<T>(method, path, body);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error || `HTTP ${res.status}`, (data as { code?: string }).code);
  return data as T;
}

export interface Cached<T> {
  data: T;
  savedAt: number;
  fromCache: boolean;
}

/** GET with an on-device copy. If the server cannot be reached, returns the last copy. */
export async function getCached<T>(path: string): Promise<Cached<T>> {
  const key = KEY_CACHE + (getUser()?.user_id ?? '') + path;
  try {
    const data = await request<T>('GET', path);
    const savedAt = Date.now();
    try {
      store()?.setItem(key, JSON.stringify({ data, savedAt }));
    } catch {
      /* storage full: keep going with live data */
    }
    return { data, savedAt, fromCache: false };
  } catch (e) {
    const err = e as ApiError;
    if (err.status === 0) {
      const raw = store()?.getItem(key);
      if (raw) {
        const c = JSON.parse(raw) as { data: T; savedAt: number };
        return { ...c, fromCache: true };
      }
    }
    throw err;
  }
}

export const apiGet = <T,>(path: string) => request<T>('GET', path);
export const apiPost = <T,>(path: string, body: unknown, timeoutMs?: number) => request<T>('POST', path, body, timeoutMs);

// ---------- outbox (writes made while offline)

interface OutboxItem {
  id: string;
  path: string;
  body: unknown;
  createdAt: number;
  user: string;
}

function readOutbox(): OutboxItem[] {
  try {
    return JSON.parse(store()?.getItem(KEY_OUTBOX) || '[]') as OutboxItem[];
  } catch {
    return [];
  }
}

function writeOutbox(items: OutboxItem[]): void {
  store()?.setItem(KEY_OUTBOX, JSON.stringify(items));
}

export function outboxCount(): number {
  const me = getUser()?.user_id;
  return readOutbox().filter((i) => i.user === me).length;
}

/** POST now; if there is no connection, keep it for later and report "queued". */
export async function postOrQueue<T>(path: string, body: unknown): Promise<{ sent: true; data: T } | { sent: false }> {
  try {
    const data = await apiPost<T>(path, body);
    return { sent: true, data };
  } catch (e) {
    if ((e as ApiError).status !== 0) throw e;
    const items = readOutbox();
    items.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, path, body, createdAt: Date.now(), user: getUser()?.user_id ?? '' });
    writeOutbox(items);
    return { sent: false };
  }
}

let flushing = false;
/** Send whatever waited in the outbox, oldest first. Stops at the first failure. */
export async function flushOutbox(): Promise<number> {
  if (flushing) return 0;
  flushing = true;
  let sent = 0;
  try {
    const items = readOutbox();
    const me = getUser()?.user_id;
    const rest: OutboxItem[] = [];
    let stopped = false;
    for (const it of items) {
      if (stopped || it.user !== me) {
        rest.push(it);
        continue;
      }
      try {
        await apiPost(it.path, it.body);
        sent += 1;
      } catch (e) {
        if ((e as ApiError).status === 0) {
          stopped = true;
          rest.push(it);
        }
        // a 4xx means the server refused it for good: drop it rather than retry forever
      }
    }
    writeOutbox(rest);
  } finally {
    flushing = false;
  }
  return sent;
}
