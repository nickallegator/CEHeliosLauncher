'use strict'

const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { finished } = require('stream/promises')

const db = require('../src/db')
const config = require('../src/config')
const { getCommunityObjectStorage } = require('../src/services/communityObjectStorage')
const { downloadCommunityRevisionToFile, resolveCommunityRevisionDownload } = require('../src/services/communityRevisionDownloads')

function argument(flag, fallback = null) {
    const index = process.argv.indexOf(flag)
    return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback
}

function integer(value, fallback) {
    const parsed = Number.parseInt(value, 10)
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback
}

async function sha256File(filePath) {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('data', chunk => hash.update(chunk))
    await finished(stream)
    return hash.digest('hex')
}

async function run() {
    if(!config.databaseUrl) throw new Error('DATABASE_URL is required.')
    if(!config.community.objectStorage.bucket) throw new Error('COMMUNITY_STORAGE_* configuration is required.')
    const limit = Math.min(integer(argument('--limit', process.env.COMMUNITY_INTEGRITY_LIMIT), 500), 5000)
    const offset = integer(argument('--offset', process.env.COMMUNITY_INTEGRITY_OFFSET), 0)
    const verifyHashes = process.argv.includes('--verify-hash') || process.env.COMMUNITY_INTEGRITY_VERIFY_HASH === 'true'
    const storage = getCommunityObjectStorage()
    await storage.ready()
    const revisions = await db.query(
        `select r.id, r.item_id, i.type, r.sha256, r.size_bytes, r.object_key,
                rs.provider as source_provider,rs.object_key as source_object_key,rs.provider_version_id,
                rs.provider_file_name,rs.provider_sha512,rs.available as source_available
         from community_revisions r join community_items i on i.id=r.item_id
         left join community_revision_sources rs on rs.revision_id=r.id
         order by r.created_at, r.id limit $1 offset $2`,
        [limit, offset]
    )
    const previews = await db.query(
        `select p.revision_id, p.object_key, p.size_bytes
         from community_revision_previews p
         where p.revision_id = any($1::uuid[]) order by p.revision_id, p.object_key`,
        [revisions.rows.map(row => row.id)]
    )
    const issues = []
    const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ag-community-scan-'))
    try {
        for(const row of revisions.rows) {
            try {
                const provider = row.source_provider || (row.object_key ? 'r2' : null)
                if(provider === 'r2') {
                    const head = await storage.head(row.source_object_key || row.object_key)
                    if(Number(head.ContentLength) !== Number(row.size_bytes)) throw new Error('size mismatch')
                } else {
                    await resolveCommunityRevisionDownload(row)
                }
                if(verifyHashes) {
                    const target = path.join(tempRoot, `${row.id}.artifact`)
                    await downloadCommunityRevisionToFile(row, target)
                    if(await sha256File(target) !== row.sha256) throw new Error('SHA-256 mismatch')
                    await fs.promises.rm(target, { force: true })
                }
            } catch(error) {
                issues.push({ type: 'artifact_invalid', itemId: row.item_id, revisionId: row.id, provider: row.source_provider || 'r2', objectKey: row.object_key, detail: error.message })
            }
        }
        for(const preview of previews.rows) {
            try {
                const head = await storage.head(preview.object_key)
                if(Number(head.ContentLength) !== Number(preview.size_bytes)) throw new Error('size mismatch')
            } catch(error) {
                issues.push({ type: 'preview_invalid', revisionId: preview.revision_id, objectKey: preview.object_key, detail: error.message })
            }
        }
    } finally {
        await fs.promises.rm(tempRoot, { recursive: true, force: true })
    }
    console.log(JSON.stringify({ schemaVersion: 1, scannedRevisions: revisions.rows.length, scannedPreviews: previews.rows.length, verifyHashes, issues }))
    if(issues.length) process.exitCode = 2
}

run().catch(error => {
    console.error('[community:scan] failed', error.message)
    process.exitCode = 1
}).finally(() => db.pool.end())
