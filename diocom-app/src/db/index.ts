import { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
    console.warn('[DB] WARNING: DATABASE_URL not set. Database operations will fail.');
}

// Singleton pattern for Next.js hot reloading
let pool: Pool;

if (!global.pool) {
    global.pool = new Pool({
        connectionString,
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 2000,
    });
}
pool = global.pool;

export default pool;

// Type definition for adding pool to global scope
declare global {
    var pool: Pool | undefined;
}
