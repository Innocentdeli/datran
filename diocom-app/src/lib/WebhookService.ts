import { createHmac } from 'crypto';
import { createModuleLogger } from './observability/logger';

const log = createModuleLogger('webhook');

/**
 * WebhookService
 *
 * Event-driven notifications for external integrations. A single endpoint can be
 * configured via env:
 *   WEBHOOK_URL     - https endpoint to POST events to (unset = webhooks disabled)
 *   WEBHOOK_SECRET  - shared secret used to sign payloads (required if WEBHOOK_URL is set)
 * Signature header: X-Datran-Signature: sha256=<hex HMAC of "<timestamp>.<body>">
 */

interface WebhookEndpoint {
    url: string;
    secret: string;
}

function getEndpoints(): WebhookEndpoint[] {
    const url = process.env.WEBHOOK_URL;
    const secret = process.env.WEBHOOK_SECRET;
    if (!url) return [];
    if (!secret) {
        log.warn('WEBHOOK_URL is set but WEBHOOK_SECRET is missing; webhooks disabled.');
        return [];
    }
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' && process.env.NODE_ENV === 'production') {
            log.warn('WEBHOOK_URL must use https in production; webhooks disabled.');
            return [];
        }
    } catch {
        log.warn('WEBHOOK_URL is invalid; webhooks disabled.');
        return [];
    }
    return [{ url, secret }];
}

export class WebhookService {
    /**
     * Dispatches an event to all configured endpoints.
     */
    public static async dispatch(event: string, payload: unknown) {
        const endpoints = getEndpoints();
        if (endpoints.length === 0) return;

        const timestamp = Date.now();
        const body = JSON.stringify({ event, payload, timestamp });

        for (const sub of endpoints) {
            try {
                const signature = createHmac('sha256', sub.secret).update(`${timestamp}.${body}`).digest('hex');
                const res = await fetch(sub.url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Datran-Event': event,
                        'X-Datran-Timestamp': String(timestamp),
                        'X-Datran-Signature': `sha256=${signature}`,
                    },
                    body,
                    signal: AbortSignal.timeout(5000),
                });
                if (!res.ok) log.error({ event, status: res.status }, 'webhook delivery failed');
            } catch (err) {
                log.error({ event, err }, 'webhook delivery failed');
            }
        }
    }

    /**
     * Registration of additional endpoints is not implemented (no persistence layer yet).
     */
    public static async register(): Promise<never> {
        throw new Error('Webhook registration is not implemented; configure WEBHOOK_URL / WEBHOOK_SECRET instead.');
    }
}
