
import db from '../src/db/index';
import { FileRepository } from '../src/db/files';

async function test() {
    console.log('🧪 Testing FileRepository.create...');
    try {
        const testFile: Parameters<typeof FileRepository.create>[0] = {
            share_id: 'test_' + Date.now(),
            user_id: null,
            original_name: 'test.txt',
            sanitized_name: 'test.txt',
            storage_path: '/tmp/test',
            thumbnail_path: null,
            password_hash: null,
            is_external: 0,
            is_encrypted: 0,
            file_size: 10,
            mime_type: 'text/plain',
            expires_at: Date.now() + 10000,
            compression_ratio: '1.0x',
            compression_speed: 'Instant',
            tags: '["test"]',
            summary: 'Test summary'
        };

        const result = await FileRepository.create(testFile);
        console.log('✅ Successfully created record:', result.id);

        // Cleanup
        await db.query('DELETE FROM files WHERE id = $1', [result.id]);
        console.log('✅ Cleaned up test record');
    } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        console.error('❌ Error during create:', err.message);
        console.error(err.stack);
    } finally {
        process.exit(0);
    }
}

test();
