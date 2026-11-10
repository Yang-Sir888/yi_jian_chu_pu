import {useEffect, useState, useCallback, createContext, useContext} from 'react';

export type User = {id: string; username: string; displayName: string; admin: boolean; mustChange: boolean};
export type ModelHealth = {status: 'unconfigured' | 'pending' | 'success' | 'failed'; checkedAt: string | null; message: string};

let csrfCache = '';
export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

const listeners = new Set<() => void>();
const notify = (_user: User | null) => listeners.forEach(fn => fn());

export async function api<T = any>(url: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  if (csrfCache) headers.set('X-CSRF-Token', csrfCache);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    const response = await fetch(url, {
      ...options,
      headers,
      credentials: 'same-origin',
      signal: options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal,
    });
    const text = await response.text();
    let data: any = {};
    try { data = text ? JSON.parse(text) : {}; }
    catch { throw new Error('服务器返回了异常页面，请检查服务是否启动或稍后重试'); }
    if (!response.ok) {
      if (response.status === 401) {
        csrfCache = '';
        notify(null);
        window.dispatchEvent(new Event('session-expired'));
      }
      throw new ApiError(data.error || '请求失败', response.status);
    }
    if (data.csrf) csrfCache = data.csrf;
    return data as T;
  } catch (error) {
    if (options.signal?.aborted) throw new Error('已取消操作');
    if (controller.signal.aborted) throw new Error('请求超时，请稍后重试');
    if (error instanceof TypeError) throw new Error('无法连接服务器，请检查网络后重试');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export type PublicUser = User & {disabled?: boolean};

type SessionState = {
  user: PublicUser | null;
  health: ModelHealth;
  localMode: boolean;
  ready: boolean;
  setHealth: (h: ModelHealth) => void;
  refresh: () => Promise<void>;
  signIn: (username: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  setUser: (u: PublicUser | null) => void;
};

export const SessionContext = createContext<SessionState | null>(null);
export const useSession = () => {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('SessionProvider missing');
  return ctx;
};

export function useSessionState(): SessionState {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [health, setHealth] = useState<ModelHealth>({status: 'unconfigured', checkedAt: null, message: ''});
  const [localMode, setLocalMode] = useState(false);
  const [ready, setReady] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const data = await api('/api/auth/me');
      // 服务端在 /auth/me 里回传当前会话的 CSRF 令牌：
      // 刷新页面后必须重新缓存，否则改密、保存等写操作会被 403 拒绝。
      if (data.csrf) csrfCache = data.csrf;
      setUser(data.user);
      setHealth(data.modelHealth);
      setLocalMode(!!data.localMode);
    } catch {
      csrfCache = '';
      setUser(null);
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const expired = () => { csrfCache = ''; setUser(null); };
    window.addEventListener('session-expired', expired);
    listeners.add(expired);
    return () => { window.removeEventListener('session-expired', expired); listeners.delete(expired); };
  }, []);

  const signIn = useCallback(async (username: string, password: string) => {
    const data = await api('/api/auth/login', {method: 'POST', body: JSON.stringify({username, password})});
    setUser(data.user);
    setHealth(data.modelHealth);
    setLocalMode(!!data.localMode);
  }, []);

  const signOut = useCallback(async () => {
    try { await api('/api/auth/logout', {method: 'POST'}); } catch { /* ignore */ }
    csrfCache = '';
    setUser(null);
  }, []);

  return {user, health, localMode, ready, setHealth, refresh, signIn, signOut, setUser};
}
