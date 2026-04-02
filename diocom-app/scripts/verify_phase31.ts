
import { NeuralService } from '../src/lib/NeuralService';
import { FileRepository } from '../src/db/files';
import '../src/db/schema'; // Ensure DB is initialized

async function verify() {
    console.log('🚀 Verifying Phase 31: Advanced Intelligence');

    // 1. Verify Neural Service
    console.log('\n[1] Testing Neural Service...');
    const mockFile = {
        name: 'quarterly_report_2024.pdf',
        type: 'application/pdf',
        size: 1024,
        arrayBuffer: async () => new ArrayBuffer(0),
        slice: () => new Blob(),
        stream: () => new ReadableStream()
    } as unknown as File;

    const analysis = await NeuralService.analyze(mockFile);
    console.log('Analysis Result:', analysis);

    if (!analysis.tags.includes('pdf') || !analysis.tags.includes('document')) {
        throw new Error('Neural Service failed to auto-tag PDF');
    }
    console.log('✅ Neural Service: PASS');

    // 2. Verify Database Persistence (Mock)
    // We can't easily upload without a running server, but we can test the Repository directly.
    console.log('\n[2] Testing Repository Persistence...');
    const fileData = {
        share_id: 'verify_test_' + Date.now(),
        original_name: 'quarterly_report_2024.pdf',
        sanitized_name: 'quarterly_report_2024.pdf',
        storage_path: '/tmp/test',
        file_size: 1024,
        mime_type: 'application/pdf',
        compression_ratio: '1.0x',
        compression_speed: 'Instant',
        tags: JSON.stringify(analysis.tags),
        summary: analysis.summary,
        expires_at: Date.now() + 86400000
    };

    const savedFile = await FileRepository.create(fileData as any);
    console.log('Saved File:', savedFile.id);

    const fetched = await FileRepository.findByShareId(savedFile.share_id);
    if (!fetched || fetched.tags !== fileData.tags) {
        throw new Error('Repository failed to save/retrieve tags');
    }
    console.log('✅ DB Persistence: PASS');

    // 3. Verify Semantic Search
    console.log('\n[3] Testing Semantic Search...');
    // Search by tag "document"
    const searchResults = await FileRepository.searchFiles(savedFile.user_id || '', 'document');
    console.log(`Found ${searchResults.length} files for query "document"`);

    const found = searchResults.find(f => f.id === savedFile.id);
    if (!found) {
        throw new Error('Semantic Search failed to find file by tag');
    }
    console.log('✅ Semantic Search: PASS');

    // Cleanup
    await FileRepository.delete(savedFile.id);
    console.log('\n✨ Phase 31 Verification Complete!');
    process.exit(0);
}

verify().catch(err => {
    console.error(err);
    process.exit(1);
});
