/**
 * Observability (diocom-app/src/lib/observability): log redaction. Nothing secret may reach a log line:
 * passwords, tokens, keys, cookies, Authorization headers, URL credentials/fragments, raw client IPs.
 */
import { test, describe, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { createLogger, createModuleLogger, setRootLoggerForTesting } from '../diocom-app/src/lib/observability/logger';
import { scrubString, sanitizeUrl, REDACT_PATHS } from '../diocom-app/src/lib/observability/redact';
import { withObservability } from '../diocom-app/src/lib/observability/withObservability';
import { createMetrics, setMetricsForTesting } from '../diocom-app/src/lib/observability/metrics';

function capture() {
    const lines: string[] = [];
    const destination = { write: (s: string) => { lines.push(s); } };
    const logger = createLogger({ env: { NODE_ENV: 'production', LOG_LEVEL: 'debug' }, destination });
    return { logger, lines, text: () => lines.join('') };
}

const SECRETS = [
    'hunter2-password', 'tok_live_abcdef123456', 'sk_secret_value', 'cookie-session-xyz', 'Bearer-tkn-998877',
    'reactor-token-555', '203.0.113.77', 'fragkey-QWERTY', 'pg-pass-321',
];

afterEach(() => {
    setRootLoggerForTesting(undefined);
    setMetricsForTesting(undefined);
});

describe('log redaction', () => {
    test('sensitive fields are censored at top level and nested', () => {
        const { logger, text } = capture();
        logger.info({
            password: 'hunter2-password',
            token: 'tok_live_abcdef123456',
            ip: '203.0.113.77',
            body: { apiKey: 'sk_secret_value', newPassword: 'hunter2-password' },
            req: { headers: { cookie: 'cookie-session-xyz', authorization: 'Bearer Bearer-tkn-998877', 'x-reactor-token': 'reactor-token-555', 'x-forwarded-for': '203.0.113.77' } },
            user: { id: 'u1', email: 'a@example.com' },
        }, 'login attempt');
        const out = text();
        for (const s of SECRETS) assert.ok(!out.includes(s), `leaked ${s}: ${out}`);
        assert.ok(out.includes('[REDACTED]'));
        assert.ok(out.includes('"u1"'), 'non-sensitive fields are kept');
        const line = JSON.parse(out.trim().split('\n')[0]);
        assert.equal(line.level, 'info');
        assert.equal(line.msg, 'login attempt');
        assert.equal(line.req.headers.cookie, '[REDACTED]');
        assert.equal(line.body.apiKey, '[REDACTED]');
    });

    test('free-text messages and errors are scrubbed', () => {
        const { logger, text } = capture();
        logger.error('connect to postgres://datran:pg-pass-321@db:5432/x failed from 203.0.113.77');
        logger.warn('calling with Authorization: Bearer Bearer-tkn-998877 and ?token=tok_live_abcdef123456');
        logger.info('share link https://app.example/v1/abc#k=fragkey-QWERTY');
        logger.error({ err: new Error('auth failed: password=hunter2-password for 203.0.113.77') }, 'boom');
        logger.error(new Error('secret=sk_secret_value'));
        const out = text();
        for (const s of SECRETS) assert.ok(!out.includes(s), `leaked ${s}: ${out}`);
        assert.ok(out.includes('postgres://datran:***@db'), out);
        assert.ok(out.includes('[ip]'));
        assert.ok(out.includes('#[fragment]'));
    });

    test('module logger merges fields and redacts', () => {
        const cap = capture();
        setRootLoggerForTesting(cap.logger);
        const log = createModuleLogger('test');
        log.info({ password: 'hunter2-password', count: 3 }, 'hello');
        log.error(new Error('token=tok_live_abcdef123456'));
        const out = cap.text();
        assert.ok(out.includes('"module":"test"'));
        assert.ok(out.includes('"count":3'));
        for (const s of SECRETS) assert.ok(!out.includes(s), `leaked ${s}`);
    });

    test('sanitizeUrl drops fragments, credentials and query secrets', () => {
        assert.equal(sanitizeUrl('https://u:p@x.example/a?token=abc&page=2#k=secret'), 'https://x.example/a?token=[REDACTED]&page=2');
        assert.equal(sanitizeUrl('/api/stream?file=abc&sig=zzz'), '/api/stream?file=abc&sig=[REDACTED]');
        assert.equal(scrubString('no secrets here'), 'no secrets here');
        assert.ok(REDACT_PATHS.includes('password') && REDACT_PATHS.includes('*["set-cookie"]'));
    });

    test('request logs carry requestId/route, echo X-Request-Id, never the raw URL', async () => {
        const cap = capture();
        setRootLoggerForTesting(cap.logger);
        setMetricsForTesting(createMetrics({ defaultMetrics: false }));
        const handler = withObservability(async (_req: Request) => {
            createModuleLogger('inner').info({ password: 'hunter2-password' }, 'inside');
            return new Response('ok');
        }, '/api/things/[id]');
        const res = await handler(new Request('http://localhost/api/things/42?token=tok_live_abcdef123456#frag', {
            headers: { 'x-request-id': 'req-abcdef12', cookie: 'cookie-session-xyz', 'x-forwarded-for': '203.0.113.77' },
        }));
        assert.equal(res.headers.get('x-request-id'), 'req-abcdef12');
        const lines = cap.lines.map((l) => JSON.parse(l));
        assert.ok(lines.length >= 2);
        for (const l of lines) {
            assert.equal(l.requestId, 'req-abcdef12');
            assert.equal(l.route, '/api/things/[id]');
        }
        const out = cap.text();
        assert.ok(!out.includes('/api/things/42'), 'raw path not logged');
        for (const s of SECRETS) assert.ok(!out.includes(s), `leaked ${s}`);

        // Unsafe/absent ids are replaced by a generated one.
        const res2 = await handler(new Request('http://localhost/x', { headers: { 'x-request-id': 'bad id with spaces' } }));
        assert.match(res2.headers.get('x-request-id') || '', /^[0-9a-f-]{36}$/);
    });

    test('unhandled errors become a 500 with the request id; Next control-flow errors propagate', async () => {
        const cap = capture();
        setRootLoggerForTesting(cap.logger);
        setMetricsForTesting(createMetrics({ defaultMetrics: false }));
        const failing = withObservability(async () => { throw new Error('db password=hunter2-password'); }, '/api/fail');
        const res = await failing(new Request('http://localhost/api/fail'));
        assert.equal(res.status, 500);
        const body = await res.json();
        assert.equal(body.requestId, res.headers.get('x-request-id'));
        assert.ok(!cap.text().includes('hunter2-password'));

        const redirecting = withObservability(async () => {
            throw Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;replace;/x;307;' });
        }, '/api/redirect');
        await assert.rejects(redirecting(new Request('http://localhost/api/redirect')), /NEXT_REDIRECT/);
    });
});
