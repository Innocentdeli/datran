
import db from '../src/db/index';

async function checkSchema() {
    console.log('🧐 Checking files table schema...');
    try {
        const res = await db.query(`
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name = 'files'
        `);
        const columnNames = res.rows.map(r => r.column_name);
        console.log('Columns:', columnNames.join(', '));

        if (!columnNames.includes('tags')) {
            console.log('❌ Missing tags column!');
        } else {
            console.log('✅ tags column exists');
        }

        if (!columnNames.includes('summary')) {
            console.log('❌ Missing summary column!');
        } else {
            console.log('✅ summary column exists');
        }

        if (!columnNames.includes('is_external')) {
            console.log('❌ Missing is_external column!');
        } else {
            console.log('✅ is_external column exists');
        }
    } catch (error) {
        console.error('❌ Error checking schema:', error);
    } finally {
        process.exit(0);
    }
}

checkSchema();
