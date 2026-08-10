const { Pool } = require('pg')
const config = require('./config')

if(!config.databaseUrl) {
    console.warn('[db] DATABASE_URL not set. Database calls will fail.')
}

const pool = new Pool({
    connectionString: config.databaseUrl || undefined
})

async function query(text, params) {
    return pool.query(text, params)
}

async function withClient(fn) {
    const client = await pool.connect()
    try {
        return await fn(client)
    } finally {
        client.release()
    }
}

module.exports = {
    pool,
    query,
    withClient
}
