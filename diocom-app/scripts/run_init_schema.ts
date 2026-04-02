
import { Pool } from 'pg';
import { initializeSchema } from '../src/db/schema';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.join(__dirname, '../.env') });

async function runInit() {
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
