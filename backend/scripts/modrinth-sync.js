'use strict'

const db = require('../src/db')
const config = require('../src/config')
const { syncAllSources } = require('../src/services/modrinthSources')

async function run() {
    if(!config.modrinth.enabled) throw new Error('COMMUNITY_MODRINTH_ENABLED must be true.')
    const results = await syncAllSources()
    console.log(JSON.stringify({ schemaVersion: 1, checked: results.length, results }, null, 2))
}

run().catch(error => { console.error('[modrinth:sync] failed', error.message); process.exitCode = 1 }).finally(() => db.pool.end())
