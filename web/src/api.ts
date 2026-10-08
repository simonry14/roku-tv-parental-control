import type { ApiErrorDto } from '../../src/api/contract';

export type * from '../../src/api/contract';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: string,
  ) {
    super(message);
  }
}

/** Fired on any 401 so the app can drop back to the PIN screen. */
export const authEvents = new EventTarget();

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : null,
  });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/auth/')) authEvents.dispatchEvent(new Event('unauthorized'));
    const err = (data ?? {}) as Partial<ApiErrorDto>;
    throw new ApiError(res.status, err.error ?? `Request failed (${res.status})`, err.details);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};
