
// Usage: DATABASE_URL=... npx tsx scripts/run_init_schema.ts
//    or: node --env-file=.env --import tsx scripts/run_init_schema.ts
import { Pool } from 'pg';
import { initializeSchema } from '../src/db/schema';

async function runInit() {
    if (!process.env.DATABASE_URL) {
        console.error('❌ DATABASE_URL is not set');
        process.exit(1);
    }

    const pool = new Pool({
        connectionString: process.env.DATABASE_URL
    });

    try {
        console.log('⏳ Initializing full PostgreSQL schema...');
        await initializeSchema(pool);
        console.log('✅ Full schema initialization complete!');
    } catch (err) {
        console.error('❌ Initialization failed:', err);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

runInit();
