
async function testIngest() {
    const fs = require('fs');
    const path = require('path');

    console.log('🚀 Testing Ingest API...');

    const filePath = path.join(process.cwd(), 'package.json');
    const fileBuffer = fs.readFileSync(filePath);

    const formData = new FormData();
    const blob = new Blob([fileBuffer], { type: 'application/json' });
    formData.append('file', blob, 'test.json');
    formData.append('tags', JSON.stringify(['test', 'debug']));
    formData.append('summary', 'Test summary');

    try {
        const res = await fetch('http://localhost:3000/api/ingest', {
            method: 'POST',
            body: formData
        });

        console.log('Status:', res.status);
        const data = await res.json();
        console.log('Response:', JSON.stringify(data, null, 2));
    } catch (e: any) {
        console.error('Fetch Error:', e.message);
    }
}

testIngest();
