/**
 * Observability: Prometheus registry. Labels must stay bounded: route templates (never raw URLs), normalised
 * methods/status codes, capped free-form labels; no client data (IPs, emails, ids) in label values.
 */
import { test, describe, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import {
    createMetrics, setMetricsForTesting, recordHttpRequest, recordRateLimitRejection, recordAuth, recordDbQuery,
    recordDownload, recordUpload, recordPrefetchWarm, observeReactorCall, normalizeRoute, normalizeMethod, normalizeStatus,
    sqlOperation, LabelGuard, reactorErrorReason,
} from '../diocom-app/src/lib/observability/metrics';
import { withObservability } from '../diocom-app/src/lib/observability/withObservability';
import { createLogger, setRootLoggerForTesting } from '../diocom-app/src/lib/observability/logger';

afterEach(() => {
    setMetricsForTesting(undefined);
    setRootLoggerForTesting(undefined);
});

async function labelValues(m: ReturnType<typeof createMetrics>, metric: string, label: string): Promise<Set<string>> {
    const json = await m.registry.getMetricsAsJSON();
    const found = json.find((x) => x.name === metric);
    assert.ok(found, `metric ${metric} registered`);
    return new Set((found!.values as { labels: Record<string, string | number> }[]).map((v) => String(v.labels[label])));
}

describe('metrics registry', () => {
    test('route label: templates kept, raw URLs collapse to "other"', async () => {
        assert.equal(normalizeRoute('/api/inbox/[id]'), '/api/inbox/[id]');
        assert.equal(normalizeRoute('/api/auth/[...nextauth]'), '/api/auth/[...nextauth]');
        assert.equal(normalizeRoute('/api/health/ready?x=1'), '/api/health/ready');
        assert.equal(normalizeRoute('/api/inbox/12345'), 'other');
        assert.equal(normalizeRoute('/api/thumbnail/3f2a9c1e-7b4d-4e7a-9f00-1234567890ab'), 'other');
        assert.equal(normalizeRoute('https://evil/x'), 'other');

        const m = createMetrics({ defaultMetrics: false });
        for (let i = 0; i < 500; i++) recordHttpRequest(`/api/stream/${i}`, 'GET', 200, 0.01, m);
        recordHttpRequest('/api/stream', 'GET', 200, 0.01, m);
        const routes = await labelValues(m, 'http_requests_total', 'route');
        assert.deepEqual([...routes].sort(), ['/api/stream', 'other']);
    });

    test('route guard caps distinct templates', async () => {
        const m = createMetrics({ defaultMetrics: false });
        for (let i = 0; i < 400; i++) recordHttpRequest(`/api/r${'abcdefghij'[i % 10]}${String.fromCharCode(97 + (i % 26))}/x${'klmnopqrst'[(i / 10) % 10 | 0]}${'uvwxyz'[(i / 100) | 0]}`, 'GET', 200, 0.01, m);
        const routes = await labelValues(m, 'http_requests_total', 'route');
        assert.ok(routes.size <= 201, `bounded (${routes.size})`);
    });

    test('method/status normalisation', async () => {
        assert.equal(normalizeMethod('get'), 'GET');
        assert.equal(normalizeMethod('PROPFIND'), 'other');
        assert.equal(normalizeStatus(204), '204');
        assert.equal(normalizeStatus(1234), 'other');
        const m = createMetrics({ defaultMetrics: false });
        recordHttpRequest('/api/x', 'BREW', 999, 0.1, m);
        const text = await m.registry.metrics();
        assert.match(text, /http_requests_total\{route="\/api\/x",method="other",status="other"\} 1/);
        assert.match(text, /http_request_duration_seconds_bucket\{le="0.25",route="\/api\/x",method="other",status="other"\} 1/);
    });

    test('rate-limit scope keeps only the key prefix (no IPs/emails)', async () => {
        const m = createMetrics({ defaultMetrics: false });
        recordRateLimitRejection('unlock:ip:203.0.113.9', 'limited', m);
        recordRateLimitRejection('signin:email:alice@example.com', 'limited', m);
        recordRateLimitRejection('unlock:file:203.0.113.9:shareid', 'unavailable', m);
        const text = await m.registry.metrics();
        assert.ok(!text.includes('203.0.113.9') && !text.includes('alice@example.com') && !text.includes('shareid'));
        assert.match(text, /diocom_rate_limit_rejections_total\{scope="unlock",reason="limited"\} 1/);
        assert.match(text, /diocom_rate_limit_rejections_total\{scope="signin",reason="limited"\} 1/);
    });

    test('LabelGuard caps and validates values', () => {
        const g = new LabelGuard(3);
        assert.equal(g.value('a'), 'a');
        assert.equal(g.value('b'), 'b');
        assert.equal(g.value('c'), 'c');
        assert.equal(g.value('d'), 'other');
        assert.equal(g.value('a'), 'a');
        assert.equal(g.value('has space'), 'other');
        assert.equal(g.value(''), 'other');
        assert.equal(g.size, 3);
    });

    test('domain helpers record bounded series', async () => {
        const m = createMetrics({ defaultMetrics: false });
        setMetricsForTesting(m);
        recordAuth('password', 'success', m);
        recordAuth('password', 'failure', m);
        recordDbQuery('postgres', 'SELECT * FROM users WHERE email = $1', 0.002, true, m);
        recordDbQuery('postgres', "UPDATE files SET x = 'secret'", 0.01, false, m);
        recordDbQuery('postgres', 'VACUUM', 0.01, true, m);
        recordDownload({ source: 'disk', bytes: 1000 }, m);
        recordUpload({ outcome: 'ok', bytes: 2048, backend: 'reactor' }, m);
        recordPrefetchWarm('warmed_demand', m);
        await observeReactorCall('compress', async () => ({ status: 200 }));
        await assert.rejects(observeReactorCall('decompress', async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); }));
        const text = await m.registry.metrics();
        assert.ok(!text.includes('users WHERE') && !text.includes('secret'), 'SQL text never a label');
        assert.match(text, /diocom_db_query_duration_seconds_count\{backend="postgres",op="select",outcome="ok"\} 1/);
        assert.match(text, /diocom_db_query_duration_seconds_count\{backend="postgres",op="update",outcome="error"\} 1/);
        assert.match(text, /op="other"/);
        assert.match(text, /diocom_auth_attempts_total\{method="password",result="success"\} 1/);
        assert.match(text, /diocom_upload_bytes_total\{backend="reactor"\} 2048/);
        assert.match(text, /diocom_download_bytes_total\{source="disk"\} 1000/);
        assert.match(text, /diocom_reactor_errors_total\{op="decompress",reason="timeout"\} 1/);
        assert.match(text, /diocom_reactor_request_duration_seconds_count\{op="compress",outcome="ok"\} 1/);
        assert.equal(sqlOperation('  with x as (select 1) select * from x'), 'with');
        assert.equal(reactorErrorReason(new Error('Reactor /compress returned 503')), 'http_5xx');
        assert.equal(reactorErrorReason(new TypeError('fetch failed')), 'network');
    });

    test('withObservability labels by template + method + status', async () => {
        const m = createMetrics({ defaultMetrics: false });
        setMetricsForTesting(m);
        setRootLoggerForTesting(createLogger({ env: { NODE_ENV: 'production', LOG_LEVEL: 'silent' }, destination: { write: () => undefined } }));
        const h = withObservability(async (req: Request) => new Response(null, { status: req.method === 'POST' ? 201 : 404 }), '/api/lobby/[code]');
        await h(new Request('http://localhost/api/lobby/ABC123', { method: 'POST' }));
        await h(new Request('http://localhost/api/lobby/ZZZ999'));
        const text = await m.registry.metrics();
        assert.match(text, /http_requests_total\{route="\/api\/lobby\/\[code\]",method="POST",status="201"\} 1/);
        assert.match(text, /http_requests_total\{route="\/api\/lobby\/\[code\]",method="GET",status="404"\} 1/);
        assert.ok(!text.includes('ABC123') && !text.includes('ZZZ999'));
        assert.match(text, /http_requests_in_flight\{route="\/api\/lobby\/\[code\]"\} 0/);
    });

    test('default Node metrics are collected', async () => {
        const m = createMetrics();
        const text = await m.registry.metrics();
        assert.match(text, /process_cpu_user_seconds_total/);
        assert.match(text, /nodejs_heap_size_used_bytes/);
    });
});
