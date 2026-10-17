const { Client } = require('pg');

async function testConnection() {
    const config = {
        user: process.env.PGUSER || 'postgres',
        host: process.env.PGHOST || 'localhost',
        database: 'postgres', // Connect to default first to check if target exists
        password: process.env.PGPASSWORD,
        port: Number(process.env.PGPORT || 5432),
    };
    if (!config.password) {
        console.error('❌ PGPASSWORD is not set');
        process.exit(1);
    }

    const client = new Client(config);

    try {
        await client.connect();
        console.log('✅ Connected to postgres!');
        
        const res = await client.query('SELECT datname FROM pg_database');
        const databases = res.rows.map(r => r.datname);
        console.log('Databases found:', databases.join(', '));
        
        if (databases.includes('datran')) {
            console.log('✅ datran database exists');
        } else {
            console.log('❌ datran database does NOT exist. Creating it...');
            await client.query('CREATE DATABASE datran');
            console.log('✅ datran database created');
        }
        
        await client.end();

        // Now test connecting to datran specifically
        const datranClient = new Client({ ...config, database: 'datran' });
        await datranClient.connect();
        console.log('✅ Successfully connected to datran database!');
        await datranClient.end();
        
    } catch (err) {
        console.error('❌ Connection failed:', err.message);
        process.exit(1);
    }
}

testConnection();
