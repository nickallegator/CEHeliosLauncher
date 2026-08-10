const fs = require('fs')
const path = require('path')
const { Client } = require('pg')
const dotenv = require('dotenv')

dotenv.config({ path: path.resolve(__dirname, '..', '.env') })

const databaseUrl = process.env.DATABASE_URL

if(!databaseUrl){
    console.error('[db:setup] DATABASE_URL is not set. Check backend/.env')
    process.exit(1)
}

async function run() {
    const schemaPath = path.resolve(__dirname, '..', 'schema.sql')
    const sql = fs.readFileSync(schemaPath, 'utf8')
    const client = new Client({ connectionString: databaseUrl })
    await client.connect()
    await client.query(sql)
    await client.end()
    console.log('[db:setup] schema applied')
}

run().catch((err) => {
    console.error('[db:setup] failed', err)
    process.exit(1)
})
