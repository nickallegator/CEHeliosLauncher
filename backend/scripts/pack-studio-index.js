'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

const db = require('../src/db')
const config = require('../src/config')
const { getCommunityObjectStorage } = require('../src/services/communityObjectStorage')
const { validateResourcePack } = require('../src/services/communityResourcePack')
const { persistCompositionIndex } = require('../src/services/communityPackStudio')

function argument(flag, fallback = null) {
    const index = process.argv.indexOf(flag)
    return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback
}

async function run() {
    if(!config.databaseUrl) throw new Error('DATABASE_URL is required.')
    if(!config.community.objectStorage.bucket) throw new Error('COMMUNITY_STORAGE_* configuration is required.')
    const requested = Math.max(1, Number.parseInt(argument('--limit', '100'), 10) || 100)
    const limit = Math.min(requested, 1000)
    const revisionFilter = argument('--revision')
    const force = process.argv.includes('--force')
    const storage = getCommunityObjectStorage()
    await storage.ready()
    const result = await db.query(
        `select r.id,r.item_id,r.object_key,r.size_bytes,r.sha256,i.owner_id
         from community_revisions r join community_items i on i.id=r.item_id
         where i.type='resource-packs'
           and ($1::uuid is null or r.id=$1::uuid)
           and ($2::boolean or not exists (select 1 from community_resource_components c where c.revision_id=r.id))
         order by r.created_at,r.id limit $3`,
        [revisionFilter || null, force, limit]
    )
    const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ag-pack-studio-index-'))
    const indexed = []
    try {
        for(const row of result.rows) {
            const filePath = path.join(tempRoot, `${row.id}.zip`)
            await storage.getToFile(row.object_key, filePath, { maxBytes: Number(row.size_bytes) })
            const validation = await validateResourcePack(filePath)
            if(validation.sha256 !== row.sha256) throw new Error(`Revision ${row.id} checksum does not match its immutable database record.`)
            const index = validation.compositionIndex
            await db.withClient(async client => {
                await client.query('begin')
                try {
                    await persistCompositionIndex(client, {
                        revisionId: row.id,
                        itemId: row.item_id,
                        ownerId: row.owner_id,
                        index,
                        enabled: null
                    })
                    await client.query('commit')
                } catch(error) {
                    await client.query('rollback')
                    throw error
                }
            })
            indexed.push({ revisionId: row.id, components: index.components.length, files: index.files.length })
            await fs.promises.rm(filePath, { force: true })
        }
    } finally {
        await fs.promises.rm(tempRoot, { recursive: true, force: true })
    }
    console.log(JSON.stringify({ schemaVersion: 1, force, indexed }, null, 2))
}

run().catch(error => {
    console.error('[pack-studio:index] failed', error.message)
    process.exitCode = 1
}).finally(() => db.pool.end())
