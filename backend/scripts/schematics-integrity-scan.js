'use strict'

const db = require('../src/db')
const config = require('../src/config')
const { parseCanonicalSchematic } = require('@cobblepower/schematics-core')
const { getSchematicsObjectStorage } = require('../src/services/schematicsObjectStorage')

function arg(flag, fallback = null) {
    const index = process.argv.indexOf(flag)
    return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback
}

function integer(value, fallback) {
    const parsed = Number.parseInt(value, 10)
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback
}

function enabled(value, fallback = false) {
    if(value == null) return fallback
    return ['1', 'true', 'yes'].includes(String(value).trim().toLowerCase())
}

function issue(issues, type, row, detail = null) {
    const value = {
        type,
        schematicId: row.schematic_id,
        revisionId: row.revision_id,
        revisionNumber: Number(row.revision_number),
        detail
    }
    issues.push(value)
    console.warn('[schematics:scan] integrity issue', value)
}

async function verifyHead(storage, key, expectedBytes) {
    const result = await storage.head(key)
    if(expectedBytes != null && Number(result.ContentLength) !== Number(expectedBytes)) {
        throw new Error(`size mismatch: expected ${expectedBytes}, received ${result.ContentLength}`)
    }
}

async function run() {
    if(!config.databaseUrl) throw new Error('DATABASE_URL is required.')
    if(!config.schematics.objectStorage.bucket) throw new Error('SCHEMATICS_STORAGE_* configuration is required.')

    const limit = Math.min(integer(arg('--limit', process.env.SCHEMATICS_INTEGRITY_LIMIT), 500), 5000)
    const offset = integer(arg('--offset', process.env.SCHEMATICS_INTEGRITY_OFFSET), 0)
    const verifyHashes = enabled(arg('--verify-hash', process.env.SCHEMATICS_INTEGRITY_VERIFY_HASH), false)
    const quarantineInvalid = enabled(arg('--quarantine-invalid', process.env.SCHEMATICS_INTEGRITY_QUARANTINE_INVALID), false)
    const storage = getSchematicsObjectStorage()
    await storage.ready()

    const revisions = await db.query(
        `select r.id as revision_id, r.schematic_id, r.revision_number, r.sha256,
                r.size_bytes, r.block_count, r.format_id, r.format_version, r.object_key,
                s.current_revision_id
         from schematic_revisions r join schematics s on s.id = r.schematic_id
         order by r.created_at, r.id
         limit $1 offset $2`,
        [limit, offset]
    )
    const revisionIds = revisions.rows.map(row => row.revision_id)
    const thumbnails = revisionIds.length === 0 ? { rows: [] } : await db.query(
        `select revision_id, size_label, mime, object_key, size_bytes
         from schematic_revision_thumbnails
         where revision_id = any($1::uuid[])
         order by revision_id, size_label, mime`,
        [revisionIds]
    )
    const thumbnailsByRevision = new Map()
    for(const thumbnail of thumbnails.rows) {
        const values = thumbnailsByRevision.get(thumbnail.revision_id) || []
        values.push(thumbnail)
        thumbnailsByRevision.set(thumbnail.revision_id, values)
    }

    const issues = []
    const quarantineIds = new Set()
    for(const row of revisions.rows) {
        const issueStart = issues.length
        try {
            await verifyHead(storage, row.object_key, row.size_bytes)
        } catch(error) {
            issue(issues, 'schematic_object_invalid', row, `${row.object_key}: ${error.message}`)
            continue
        }

        if(verifyHashes) {
            try {
                const bytes = await storage.getBuffer(row.object_key, { maxBytes: Number(row.size_bytes) })
                const parsed = parseCanonicalSchematic(JSON.parse(bytes.toString('utf8')), { sourceBytes: bytes.length })
                if(parsed.sha256 !== row.sha256
                    || parsed.blockCount !== Number(row.block_count)
                    || parsed.canonical.format !== row.format_id
                    || parsed.canonical.version !== Number(row.format_version)) {
                    throw new Error('canonical metadata or SHA-256 does not match the revision lock')
                }
            } catch(error) {
                issue(issues, 'schematic_hash_invalid', row, `${row.object_key}: ${error.message}`)
            }
        }

        const variants = thumbnailsByRevision.get(row.revision_id) || []
        for(const label of ['tiny', 'medium']) {
            for(const mime of ['image/webp', 'image/png']) {
                const thumbnail = variants.find(value => value.size_label === label && value.mime === mime)
                if(!thumbnail) {
                    issue(issues, 'thumbnail_record_missing', row, `${label} ${mime}`)
                    continue
                }
                try {
                    await verifyHead(storage, thumbnail.object_key, thumbnail.size_bytes)
                } catch(error) {
                    issue(issues, 'thumbnail_object_invalid', row, `${thumbnail.object_key}: ${error.message}`)
                }
            }
        }
        if(quarantineInvalid && issues.length > issueStart && row.current_revision_id === row.revision_id) {
            quarantineIds.add(row.schematic_id)
        }
    }

    if(quarantineIds.size > 0) {
        await db.withClient(async client => {
            await client.query('begin')
            try {
                for(const schematicId of quarantineIds) {
                    await client.query(
                        `update schematics set status = 'quarantined', updated_at = now()
                         where id = $1 and status != 'deleted'`,
                        [schematicId]
                    )
                    await client.query(
                        `insert into schematics_audit(schematic_id, user_id, action, detail)
                         values ($1, null, 'integrity_quarantined', $2)`,
                        [schematicId, { source: 'schematics:scan' }]
                    )
                }
                await client.query('commit')
            } catch(error) {
                await client.query('rollback')
                throw error
            }
        })
    }

    console.log(JSON.stringify({
        schemaVersion: 1,
        scannedRevisions: revisions.rows.length,
        scannedThumbnails: thumbnails.rows.length,
        verifyHashes,
        quarantinedSchematics: Array.from(quarantineIds),
        issues
    }))
    if(issues.length > 0) process.exitCode = 2
}

run()
    .catch(error => {
        console.error('[schematics:scan] failed', error.message)
        process.exitCode = 1
    })
    .finally(() => db.pool.end())
