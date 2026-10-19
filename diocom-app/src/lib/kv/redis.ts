import Redis, { type RedisOptions } from 'ioredis';
import { randomBytes } from 'crypto';
import type { KV, MessageHandler, RateWindowResult, Unsubscribe } from './types';
import { createModuleLogger } from '../observability/logger';
import { recordKvError } from '../observability/metrics';

const log = createModuleLogger('kv');

/**
 * Redis-backed KV (REDIS_URL). Requires Redis >= 6.2 (GETDEL; Lua scripts that call TIME before writing).
 * Every multi-step operation is a single Lua script or MULTI/EXEC, so it is atomic across all app instances.
 * Keys and channels are namespaced with `prefix` (KV_PREFIX, default "diocom:").
 *
 * Failure mode: commands time out after commandTimeoutMs instead of queueing forever; callers decide whether to
 * fail open or closed (security-relevant callers fail closed).
 */

const SLIDING_WINDOW = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
local count = redis.call('ZCARD', key)
local allowed = 0
if count < limit then
  redis.call('ZADD', key, now, ARGV[3])
  count = count + 1
  allowed = 1
end
if count > 0 then redis.call('PEXPIRE', key, window) end
local reset = now + window
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
if oldest[2] then reset = tonumber(oldest[2]) + window end
return {allowed, count, reset, now}
`;

const INCR_CAPPED = `
local cur = tonumber(redis.call('GET', KEYS[1]) or '0') or 0
local grant = math.min(tonumber(ARGV[1]), tonumber(ARGV[2]) - cur)
if grant <= 0 then return 0 end
redis.call('INCRBY', KEYS[1], grant)
redis.call('PEXPIRE', KEYS[1], ARGV[3])
return grant
`;

const ZADD_CAPPED = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', '(' .. ARGV[3])
if not redis.call('ZSCORE', KEYS[1], ARGV[1]) then
  if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[4]) then return 0 end
end
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1])
redis.call('PEXPIRE', KEYS[1], ARGV[5])
return 1
`;

const DEL_IF_EQ = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`;

const PEXPIRE_IF_EQ = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
return 0
`;

type Scripted = Redis & {
    kvSliding(key: string, limit: number, windowMs: number, member: string): Promise<[number, number, number, number]>;
    kvIncrCapped(key: string, amount: number, cap: number, ttlMs: number): Promise<number>;
    kvZAddCapped(key: string, member: string, score: number, minScore: number, maxCard: number, ttlMs: number): Promise<number>;
    kvDelIfEq(key: string, value: string): Promise<number>;
    kvPexpireIfEq(key: string, value: string, ttlMs: number): Promise<number>;
};

export interface RedisKVOptions {
    prefix?: string;
    commandTimeoutMs?: number;
}

const ttl = (ms: number) => Math.max(1, Math.ceil(ms));

export class RedisKV implements KV {
    readonly backend = 'redis' as const;
    private readonly client: Scripted;
    private sub: Redis | null = null;
    private handlers = new Map<string, Set<MessageHandler>>();
    private readonly prefix: string;
    private readonly baseOptions: RedisOptions;

    constructor(private readonly url: string, opts: RedisKVOptions = {}) {
        this.prefix = opts.prefix ?? 'diocom:';
        this.baseOptions = {
            maxRetriesPerRequest: 2,
            connectTimeout: 5_000,
            commandTimeout: opts.commandTimeoutMs ?? 3_000,
            enableAutoPipelining: true,
        };
        this.client = new Redis(url, this.baseOptions) as Scripted;
        this.client.on('error', (e) => {
            recordKvError('connection');
            log.error({ err: e }, 'redis error');
        });
        this.client.defineCommand('kvSliding', { numberOfKeys: 1, lua: SLIDING_WINDOW });
        this.client.defineCommand('kvIncrCapped', { numberOfKeys: 1, lua: INCR_CAPPED });
        this.client.defineCommand('kvZAddCapped', { numberOfKeys: 1, lua: ZADD_CAPPED });
        this.client.defineCommand('kvDelIfEq', { numberOfKeys: 1, lua: DEL_IF_EQ });
        this.client.defineCommand('kvPexpireIfEq', { numberOfKeys: 1, lua: PEXPIRE_IF_EQ });
    }

    private k(key: string) {
        return this.prefix + key;
    }

    async get(key: string) {
        return this.client.get(this.k(key));
    }

    async set(key: string, value: string, ttlMs: number) {
        await this.client.set(this.k(key), value, 'PX', ttl(ttlMs));
    }

    async setNX(key: string, value: string, ttlMs: number) {
        return (await this.client.set(this.k(key), value, 'PX', ttl(ttlMs), 'NX')) === 'OK';
    }

    async del(key: string) {
        await this.client.del(this.k(key));
    }

    async getdel(key: string) {
        return this.client.getdel(this.k(key));
    }

    async delIfEquals(key: string, value: string) {
        return (await this.client.kvDelIfEq(this.k(key), value)) === 1;
    }

    async pexpireIfEquals(key: string, value: string, ttlMs: number) {
        return (await this.client.kvPexpireIfEq(this.k(key), value, ttl(ttlMs))) === 1;
    }

    async slidingWindow(key: string, limit: number, windowMs: number): Promise<RateWindowResult> {
        const member = randomBytes(8).toString('base64url');
        const [allowed, count, reset, now] = (await this.client.kvSliding(this.k(key), limit, ttl(windowMs), member)).map(Number);
        return {
            allowed: allowed === 1,
            count,
            remaining: Math.max(0, limit - count),
            resetAt: reset,
            retryAfterMs: allowed === 1 ? 0 : Math.max(1, reset - now),
        };
    }

    async incrCapped(key: string, amount: number, cap: number, ttlMs: number) {
        return Number(await this.client.kvIncrCapped(this.k(key), Math.floor(amount), Math.floor(cap), ttl(ttlMs)));
    }

    async hIncrBy(key: string, field: string, amount: number, ttlMs: number) {
        const k = this.k(key);
        const res = await this.client.multi().hincrby(k, field, Math.trunc(amount)).pexpire(k, ttl(ttlMs)).exec();
        if (!res) throw new Error('kv hIncrBy aborted');
        for (const [err] of res) if (err) throw err;
        return Number(res[0][1]);
    }

    async hGet(key: string, field: string) {
        return Number((await this.client.hget(this.k(key), field)) ?? 0) || 0;
    }

    async hDrain(key: string) {
        const k = this.k(key);
        const res = await this.client.multi().hgetall(k).del(k).exec();
        if (!res) throw new Error('kv hDrain aborted');
        for (const [err] of res) if (err) throw err;
        const raw = (res[0][1] ?? {}) as Record<string, string>;
        return Object.fromEntries(Object.entries(raw).map(([f, v]) => [f, Number(v) || 0]));
    }

    async listPush(key: string, value: string, maxLen: number, ttlMs: number) {
        const k = this.k(key);
        const res = await this.client.multi().rpush(k, value).ltrim(k, -maxLen, -1).pexpire(k, ttl(ttlMs)).exec();
        if (!res) throw new Error('kv listPush aborted');
        for (const [err] of res) if (err) throw err;
        return Math.min(Number(res[0][1]), maxLen);
    }

    async listDrain(key: string) {
        const k = this.k(key);
        const res = await this.client.multi().lrange(k, 0, -1).del(k).exec();
        if (!res) throw new Error('kv listDrain aborted');
        for (const [err] of res) if (err) throw err;
        return res[0][1] as string[];
    }

    async zAddCapped(key: string, member: string, score: number, minScore: number, maxCard: number, ttlMs: number) {
        return (await this.client.kvZAddCapped(this.k(key), member, score, minScore, maxCard, ttl(ttlMs))) === 1;
    }

    async zMembers(key: string, minScore: number) {
        return this.client.zrangebyscore(this.k(key), minScore, '+inf');
    }

    async zRem(key: string, member: string) {
        await this.client.zrem(this.k(key), member);
    }

    async publish(channel: string, message: string) {
        await this.client.publish(this.k(channel), message);
    }

    private subscriber(): Redis {
        if (!this.sub) {
            // Subscriber connections cannot run normal commands; no command timeout (it would kill idle SUBSCRIBE).
            this.sub = new Redis(this.url, { ...this.baseOptions, commandTimeout: undefined, enableAutoPipelining: false });
            this.sub.on('error', (e) => {
                recordKvError('subscriber_connection');
                log.error({ err: e }, 'redis subscriber error');
            });
            this.sub.on('message', (ch: string, msg: string) => {
                const set = this.handlers.get(ch);
                if (!set) return;
                for (const h of set) {
                    try {
                        h(msg);
                    } catch (e) {
                        log.error({ err: e }, 'subscriber handler error');
                    }
                }
            });
        }
        return this.sub;
    }

    async subscribe(channel: string, handler: MessageHandler): Promise<Unsubscribe> {
        const ch = this.k(channel);
        const sub = this.subscriber();
        let set = this.handlers.get(ch);
        if (!set) {
            set = new Set();
            this.handlers.set(ch, set);
            set.add(handler);
            try {
                await sub.subscribe(ch);
            } catch (e) {
                set.delete(handler);
                if (set.size === 0) this.handlers.delete(ch);
                throw e;
            }
        } else {
            set.add(handler);
        }
        let done = false;
        return async () => {
            if (done) return;
            done = true;
            const s = this.handlers.get(ch);
            if (!s) return;
            s.delete(handler);
            if (s.size === 0) {
                this.handlers.delete(ch);
                await sub.unsubscribe(ch).catch(() => undefined);
            }
        };
    }

    async close() {
        this.handlers.clear();
        await Promise.allSettled([this.client.quit(), this.sub?.quit()]);
    }
}
