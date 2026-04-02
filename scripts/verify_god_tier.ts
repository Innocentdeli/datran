
import { DiocomReactor } from '../src/core/DiocomReactor';
import { AuditLogger } from '../diocom-app/src/lib/AuditLogger';
import db from '../diocom-app/src/db';
import * as crypto from 'crypto';

async function runVerification() {
    console.log('🚀 Starting Datran God-Tier Verification...\n');

    // 1. Verify Adaptive Entropy Compression
    console.log('--- Pillar 4: Adaptive Entropy Compression ---');
    
    const lowEntropyData = Buffer.from('A'.repeat(1024 * 10)); // Highly repetitive text
    const highEntropyData = crypto.randomBytes(1024 * 10); // Random bytes

    const lowCompressed = DiocomReactor.compress(lowEntropyData);
    const highCompressed = DiocomReactor.compress(highEntropyData);

    console.log(`Low Entropy (Source Code/Text) - Original: ${lowEntropyData.length}, Compressed: ${lowCompressed.length}`);
    console.log(`High Entropy (Encrypted/Video) - Original: ${highEntropyData.length}, Compressed: ${highCompressed.length}`);

    const lowRatio = (lowEntropyData.length / lowCompressed.length).toFixed(2);
    const highRatio = (highEntropyData.length / highCompressed.length).toFixed(2);

    console.log(`Efficiency Ratio - Low: ${lowRatio}x, High: ${highRatio}x`);

    if (lowCompressed.length < lowEntropyData.length) {
        console.log('✅ Low entropy data compressed successfully.');
    } else {
        console.log('❌ Low entropy compression failed to reduce size.');
    }

    if (highCompressed[0] === 0x03) { // FLAG_RAW
        console.log('✅ High entropy data correctly bypassed compression (RAW passthrough).');
    }

    // 2. Verify Audit Logging Integrity
    console.log('\n--- Pillar 5: Immutable Audit Trail ---');

    console.log('Recording test events...');
    await AuditLogger.record({
        action: 'VERIFICATION_START',
        resource: 'SYSTEM',
        details: 'System-initiated god-tier verification test'
    });

    await AuditLogger.record({
        action: 'COMPRESSION_TEST',
        resource: 'REACTOR',
        details: `Verified ratios: Low=${lowRatio}x, High=${highRatio}x`
    });

    const isChainValid = AuditLogger.verifyChain();
    if (isChainValid) {
        console.log('✅ Audit Chain Integrity Verified. All hashes match.');
    } else {
        console.log('❌ Audit Chain Integrity Failure! Tampering detected or logic error.');
    }

    // 3. Simulate Tampering
    console.log('\nSimulating database tampering...');
    db.prepare("UPDATE audit_logs SET details = 'HACKED' WHERE action = 'VERIFICATION_START'").run();
    
    const isChainValidAfterTamper = AuditLogger.verifyChain();
    if (!isChainValidAfterTamper) {
        console.log('✅ Tamper Detection System: SUCCESS. Integrity violation caught.');
    } else {
        console.log('❌ Tamper Detection System: FAILED. Unauthorized change went unnoticed.');
    }

    console.log('\n--- Status Summary ---');
    if (isChainValid && !isChainValidAfterTamper) {
        console.log('👑 DATRAN IS OFFICIALLY GOD-TIER. ALL SYSTEMS NOMINAL.');
    } else {
        console.log('⚠️ Verification incomplete. Review logs.');
    }
}

runVerification().catch(console.error);
