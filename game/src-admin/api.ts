export interface RuntimeConfig {
    appsScriptUrl: string;
    useMock?: boolean;
}

/** A failed backend call. `code` is the backend's error code, or 'network' / 'demo' for problems on this side. */
export class BackendError extends Error {
    constructor(
        public code: string,
        public detail?: { field?: string; retryAfterSec?: number; row?: number },
    ) {
        super(code);
    }
}

let configPromise: Promise<RuntimeConfig> | null = null;

export function loadConfig(): Promise<RuntimeConfig> {
    configPromise ??= (async () => {
        const res = await fetch('config.json', { cache: 'no-store' });
        if (!res.ok) throw new Error(`config.json fetch failed: ${res.status}`);
        const config: RuntimeConfig = await res.json();
        // Dev only: `?backend=http://localhost:8787/exec` talks to the local mock backend (game/tools/mock-backend.mjs).
        if (import.meta.env.DEV) {
            const backend = new URLSearchParams(location.search).get('backend');
            if (backend) return { appsScriptUrl: backend, useMock: false };
        }
        return config;
    })();
    return configPromise;
}

/** Fresh id per user action; the backend ignores a repeat of the same id (double click, retry). */
export function newRequestId(): string {
    return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Calls an admin action. The PIN travels in the POST body (never in a URL). The body is sent as
 * text/plain on purpose: Apps Script Web Apps do not answer a CORS preflight, and application/json would trigger one.
 */
export async function callBackend<T extends object = Record<string, never>>(
    action: string,
    pin: string,
    payload: Record<string, unknown> = {},
): Promise<T> {
    const config = await loadConfig();
    if (config.useMock || !config.appsScriptUrl) throw new BackendError('demo');

    let data: { ok: boolean; error?: string; field?: string; retryAfterSec?: number; row?: number } & T;
    try {
        const res = await fetch(config.appsScriptUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({ action, pin, ...payload }),
        });
        data = await res.json();
    } catch {
        throw new BackendError('network');
    }

    if (!data.ok) throw new BackendError(data.error ?? 'unknown', { field: data.field, retryAfterSec: data.retryAfterSec, row: data.row });
    return data;
}

/** Public, unauthenticated status (aggregates only) — same endpoint the game polls. */
export async function fetchPublicStatus(): Promise<{
    ok: boolean;
    plan: number;
    totalThisWeek: number;
    roster?: Record<string, string> | null;
    leaders?: Record<string, string> | null;
} | null> {
    try {
        const config = await loadConfig();
        const url = config.useMock || !config.appsScriptUrl ? 'assets/mock/mock-status.json' : config.appsScriptUrl;
        const res = await fetch(url, { cache: 'no-store' });
        const status = await res.json();
        return status.ok ? status : null;
    } catch {
        return null;
    }
}
