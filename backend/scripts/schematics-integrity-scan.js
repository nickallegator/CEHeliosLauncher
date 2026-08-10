const crypto = require('crypto')
const path = require('path')

const db = require('../src/db')
const config = require('../src/config')
const storage = require('../src/services/schematicsStorage')
const objectStorage = require('../src/services/objectStorage')
const { normalizeJsonSchematic } = require(path.resolve(__dirname, '..', '..', 'libraries', 'schematics-core'))

function getArgValue(flag, fallback = null){
    const idx = process.argv.indexOf(flag)
    if(idx === -1 || idx + 1 >= process.argv.length){
        return fallback
    }
    return process.argv[idx + 1]
}

function parseBool(value, fallback = false){
    if(value == null){
        return fallback
    }
    if(typeof value === 'boolean'){
        return value
    }
    const normalized = String(value).trim().toLowerCase()
    if(['1', 'true', 'yes', 'y'].includes(normalized)){
        return true
    }
    if(['0', 'false', 'no', 'n'].includes(normalized)){
        return false
    }
    return fallback
}

function parseNumber(value, fallback){
    const n = Number.parseInt(value, 10)
    return Number.isFinite(n) ? n : fallback
}

async function readObjectToBuffer(object){
    if(!object?.Body){
        return null
    }
    if(typeof object.Body.transformToByteArray === 'function'){
        const bytes = await object.Body.transformToByteArray()
        return Buffer.from(bytes)
    }
    if(typeof object.Body.pipe === 'function'){
        const chunks = []
        for await (const chunk of object.Body){
            chunks.push(Buffer.from(chunk))
        }
        return Buffer.concat(chunks)
    }
    return null
}

function logIssue(issues, entry){
    issues.push(entry)
    const suffix = entry.detail ? ` (${entry.detail})` : ''
    console.warn(`[scan] ${entry.type} ${entry.id || ''}${suffix}`)
}

async function verifyHash({ id, format, expectedHash, objectKey, useObjectStorage }){
    if(!expectedHash || format !== 'json'){
        return { ok: true }
    }
    let schematic = null
    if(useObjectStorage){
        const object = await objectStorage.getObject(objectKey)
        const buffer = await readObjectToBuffer(object)
        if(!buffer){
            return { ok: false, reason: 'missing_object' }
        }
        try {
            schematic = JSON.parse(buffer.toString('utf8'))
        } catch (err) {
            return { ok: false, reason: 'invalid_json' }
        }
    } else {
        schematic = await storage.readSchematic(objectKey)
        if(!schematic){
            return { ok: false, reason: 'missing_object' }
        }
    }
    let normalized
    try {
        normalized = await normalizeJsonSchematic(schematic, {})
    } catch (err) {
        return { ok: false, reason: 'normalize_failed' }
    }
    const computed = normalized?.schematic?.meta?.hash
        || crypto.createHash('sha256').update(JSON.stringify(schematic)).digest('hex')
    if(computed !== expectedHash){
        return { ok: false, reason: 'hash_mismatch' }
    }
    return { ok: true }
}

async function run(){
    if(!config.databaseUrl){
        console.error('[scan] DATABASE_URL not set')
        process.exit(1)
    }

    const limit = parseNumber(getArgValue('--limit', process.env.SCHEMATICS_INTEGRITY_LIMIT || '200'), 200)
    const offset = parseNumber(getArgValue('--offset', process.env.SCHEMATICS_INTEGRITY_OFFSET || '0'), 0)
    const verifyHashes = parseBool(getArgValue('--verify-hash', process.env.SCHEMATICS_INTEGRITY_VERIFY_HASH), false)
    const verifyThumbnails = parseBool(getArgValue('--verify-thumbnails', process.env.SCHEMATICS_INTEGRITY_VERIFY_THUMBNAILS), true)

    const useObjectStorage = objectStorage.isEnabled()
    console.log(`[scan] starting (limit=${limit}, offset=${offset}, verifyHash=${verifyHashes}, verifyThumbs=${verifyThumbnails}, objectStorage=${useObjectStorage})`)

    const result = await db.query(
        `select id, format, hash, object_key, visibility, status
         from schematics
         where status != 'deleted'
         order by created_at desc
         limit $1 offset $2`,
        [limit, offset]
    )

    const ids = result.rows.map(row => row.id)
    const thumbs = verifyThumbnails && ids.length > 0
        ? await db.query(
            `select schematic_id, size_label, mime, object_key
             from schematics_thumbnails
             where schematic_id = any($1::uuid[])`,
            [ids]
        )
        : { rows: [] }

    const thumbsById = new Map()
    for(const row of thumbs.rows){
        const list = thumbsById.get(row.schematic_id) || []
        list.push({
            label: row.size_label,
            mime: row.mime,
            objectKey: row.object_key
        })
        thumbsById.set(row.schematic_id, list)
    }

    const issues = []
    for(const row of result.rows){
        const id = row.id
        const objectKey = row.object_key
        if(!objectKey){
            logIssue(issues, { type: 'missing_object_key', id })
            continue
        }
        try {
            if(useObjectStorage){
                await objectStorage.headObject(objectKey)
            } else {
                const exists = await storage.objectExists(objectKey)
                if(!exists){
                    throw new Error('missing_object')
                }
            }
        } catch (err) {
            logIssue(issues, { type: 'missing_schematic', id, detail: objectKey })
            continue
        }

        if(verifyHashes){
            const hashResult = await verifyHash({
                id,
                format: row.format || 'json',
                expectedHash: row.hash,
                objectKey,
                useObjectStorage
            })
            if(!hashResult.ok){
                logIssue(issues, { type: 'hash_mismatch', id, detail: hashResult.reason || 'unknown' })
            }
        }

        if(verifyThumbnails){
            const list = thumbsById.get(id) || []
            for(const thumb of list){
                if(!thumb.objectKey){
                    logIssue(issues, { type: 'missing_thumbnail_key', id, detail: thumb.label })
                    continue
                }
                try {
                    if(useObjectStorage){
                        await objectStorage.headObject(thumb.objectKey)
                    } else {
                        const exists = await storage.objectExists(thumb.objectKey)
                        if(!exists){
                            throw new Error('missing_thumb')
                        }
                    }
                } catch (err) {
                    logIssue(issues, { type: 'missing_thumbnail', id, detail: thumb.objectKey })
                }
            }
        }
    }

    console.log(`[scan] complete. scanned=${result.rows.length} issues=${issues.length}`)
    if(issues.length > 0){
        process.exitCode = 2
    }
}

run().catch((err) => {
    console.error('[scan] failed', err)
    process.exit(1)
})
