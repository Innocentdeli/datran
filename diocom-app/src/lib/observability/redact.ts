/**
 * Log redaction rules (src/lib/observability/logger.ts).
 *
 * Never logged: passwords, tokens, keys, secrets, cookies, Authorization headers, URL fragments, query secrets and
 * raw client IPs. Two layers:
 *  1. REDACT_PATHS: pino `redact` paths. Sensitive field names are censored at the top level and up to two levels
 *     deep (`{ password }`, `{ body: { password } }`, `{ req: { headers: { cookie } } }`).
 *  2. scrubString(): applied to log messages, error messages and stacks: URL credentials, Bearer tokens,
 *     `key=value` secrets, URL fragments and IPv4 addresses.
 * Pure (no pino import) so it can be unit tested on its own.
 */

export const CENSOR = '[REDACTED]';

/** Field names whose values must never reach a log line (case-sensitive, as they appear in objects). */
export const SENSITIVE_KEYS: readonly string[] = [
    // credentials
    'password', 'passwd', 'newPassword', 'currentPassword', 'oldPassword', 'password_hash', 'passwordHash',
    // tokens
    'token', 'accessToken', 'access_token', 'refreshToken', 'refresh_token', 'idToken', 'id_token',
    'sessionToken', 'session_token', 'loginToken', 'passkeyToken', 'csrfToken', 'jwt',
    // keys & secrets
    'secret', 'clientSecret', 'client_secret', 'apiKey', 'api_key', 'key', 'privateKey', 'private_key',
    'encryptionKey', 'masterKey', 'credentials', 'signature',
    // headers (lower-case, as in Headers / Node IncomingHttpHeaders)
    'authorization', 'Authorization', 'cookie', 'Cookie', 'cookies', 'set-cookie', 'Set-Cookie',
    'x-reactor-token', 'x-cluster-token', 'x-api-key', 'proxy-authorization',
    // client addresses
    'ip', 'clientIp', 'client_ip', 'ipAddress', 'ip_address', 'remoteAddress', 'remote_addr',
    'x-forwarded-for', 'x-real-ip', 'cf-connecting-ip', 'true-client-ip', 'forwarded',
    // URL fragments (may carry E2E keys: /v1/<id>#k=...)
    'fragment', 'urlFragment',
];

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const seg = (k: string) => (IDENT.test(k) ? `.${k}` : `["${k}"]`);

/** pino/fast-redact paths: `k`, `*.k`, `*.*.k` for every sensitive key. */
export const REDACT_PATHS: string[] = SENSITIVE_KEYS.flatMap((k) => {
    const s = seg(k);
    const top = IDENT.test(k) ? k : `["${k}"]`;
    return [top, `*${s}`, `*.*${s}`];
});

const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/@]+):([^\s@/]+)@/gi;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g;
const KV_SECRET =
    /\b(password|passwd|pwd|token|access_token|refresh_token|id_token|secret|client_secret|api[_-]?key|key|signature|sig|auth)=([^&\s"';,]+)/gi;
const FRAGMENT = /(\bhttps?:\/\/[^\s#"']*|\s\/[^\s#"']*)#[^\s"']*/gi;
const IPV4 = /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g;

/** Removes secrets and client addresses from free text (log messages, error messages, stacks). */
export function scrubString(s: string): string {
    if (!s) return s;
    return s
        .replace(URL_CREDENTIALS, '$1$2:***@')
        .replace(BEARER, `$1 ${CENSOR}`)
        .replace(KV_SECRET, `$1=${CENSOR}`)
        .replace(FRAGMENT, '$1#[fragment]')
        .replace(IPV4, '[ip]');
}

/**
 * Path-only form of a URL for logs: no query string values for sensitive keys, no fragment, no credentials.
 * Non-URL input is scrubbed as text.
 */
export function sanitizeUrl(raw: unknown): unknown {
    if (typeof raw !== 'string') return raw;
    try {
        const u = new URL(raw, 'http://placeholder.invalid');
        u.hash = '';
        u.username = '';
        u.password = '';
        for (const k of [...u.searchParams.keys()]) {
            if (SENSITIVE_QUERY.test(k)) u.searchParams.set(k, CENSOR);
        }
        const out = u.origin === 'http://placeholder.invalid' ? `${u.pathname}${u.search}` : u.toString();
        return scrubString(out);
    } catch {
        return scrubString(raw);
    }
}

const SENSITIVE_QUERY = /^(password|passwd|pwd|token|access_token|refresh_token|id_token|secret|client_secret|api[_-]?key|key|signature|sig|auth|code)$/i;

/** Error -> plain object with scrubbed message/stack (used as the pino `err` serializer). */
export function serializeError(err: unknown): unknown {
    if (!(err instanceof Error)) {
        return typeof err === 'string' ? scrubString(err) : err;
    }
    const out: Record<string, unknown> = {
        type: err.name,
        message: scrubString(err.message),
    };
    if (err.stack) out.stack = scrubString(err.stack);
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' || typeof code === 'number') out.code = code;
    const cause = (err as { cause?: unknown }).cause;
    if (cause !== undefined) out.cause = serializeError(cause);
    return out;
}

/** Header bag -> object with sensitive headers censored (for code that wants to log selected headers). */
export function sanitizeHeaders(h: unknown): unknown {
    if (!h || typeof h !== 'object') return h;
    const entries: [string, unknown][] =
        typeof (h as Headers).forEach === 'function' && typeof (h as Headers).get === 'function'
            ? (() => { const a: [string, unknown][] = []; (h as Headers).forEach((v, k) => a.push([k, v])); return a; })()
            : Object.entries(h as Record<string, unknown>);
    const sensitive = new Set(SENSITIVE_KEYS.map((k) => k.toLowerCase()));
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) out[k] = sensitive.has(k.toLowerCase()) ? CENSOR : v;
    return out;
}
