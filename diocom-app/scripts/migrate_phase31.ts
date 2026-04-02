
import db from '../src/db/index';

async function migrate() {
    console.log('🔧 Migrating database schema for Phase 31...');

    try {
        // Add tags and summary columns to files table
        await db.query(`
            ALTER TABLE files ADD COLUMN IF NOT EXISTS tags TEXT;
        `);
        console.log('✅ Added tags column');
    } catch (e: any) {
        console.error('❌ Error adding tags column:', e.message);
    }

    try {
        await db.query(`
            ALTER TABLE files ADD COLUMN IF NOT EXISTS summary TEXT;
        `);
        console.log('✅ Added summary column');
    } catch (e: any) {
        console.error('❌ Error adding summary column:', e.message);
    }

    console.log('✨ Migration complete!');
    process.exit(0);
}

migrate();
