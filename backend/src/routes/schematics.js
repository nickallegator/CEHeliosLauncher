'use strict'

const crypto = require('crypto')
const express = require('express')
const sharp = require('sharp')

const {
    FORMAT_ID,
    FORMAT_VERSION,
    MAX_BLOCKS,
    MAX_BYTES,
    SchematicValidationError,
    parseCanonicalSchematic
} = require('@cobblepower/schematics-core')
const config = require('../config')
const db = require('../db')
const { asyncRoute } = require('../middleware/asyncRoute')
const { requireSession } = require('../middleware/session')
const rateLimits = require('../services/schematicsRateLimits')
const sessions = require('../services/sessions')
const store = require('../services/store')
const { getSchematicsObjectStorage } = require('../services/schematicsObjectStorage')

const router = express.Router()
const UPLOAD_TTL_MS = 15 * 60 * 1000
const PREVIEW_MAX_BYTES = 5 * 1024 * 1024
const ALLOWED_PREVIEW_MIMES = new Set(['image/png', 'image/webp', 'image/jpeg'])
const PUBLIC_VISIBILITY = 'public'
const STATUS_ACTIVE = 'active'

function audit(req, action, detail = {}) {
    console.info('[audit] schematic event', {
        requestId: req.requestId,
        action,
        userId: req.userId || null,
        ...detail
    })
}

function hashToken(token) {
    return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex')
}

function cleanText(value, maxLength, fallback = null) {
    const normalized = typeof value === 'string' ? value.trim() : ''
    return normalized ? normalized.slice(0, maxLength) : fallback
}

function cleanTags(value) {
    const source = Array.isArray(value) ? value : String(value || '').split(',')
    const output = []
    const seen = new Set()
    for(const raw of source) {
        const tag = cleanText(raw, 24)
        const key = tag?.toLowerCase()
        if(!tag || seen.has(key)) continue
        seen.add(key)
        output.push(tag)
        if(output.length === 12) break
    }
    return output
}

function cleanMetadata(body = {}) {
    const visibility = cleanText(body.visibility, 16, PUBLIC_VISIBILITY).toLowerCase()
    if(visibility !== PUBLIC_VISIBILITY) {
        throw new SchematicValidationError('unsupported_visibility', 'Only public schematics are supported in this release.')
    }
    const name = cleanText(body.name || body.title, 80)
    if(!name) throw new SchematicValidationError('missing_name', 'A schematic name is required.')
    return {
        name,
        description: cleanText(body.description, 800, ''),
        tags: cleanTags(body.tags),
        visibility,
        releaseVersion: cleanText(body.releaseVersion || body.version, 64)
    }
}

function previewMime(value) {
    const normalized = String(value || 'image/png').split(';')[0].trim().toLowerCase()
    if(!ALLOWED_PREVIEW_MIMES.has(normalized)) {
        throw new SchematicValidationError('invalid_preview_mime', 'Preview must be PNG, WebP, or JPEG.')
    }
    return normalized
}

function previewExtension(mime) {
    if(mime === 'image/webp') return 'webp'
    if(mime === 'image/jpeg') return 'jpg'
    return 'png'
}

function parseUuid(value, label = 'id') {
    const normalized = String(value || '').trim().toLowerCase()
    if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(normalized)) {
        throw new SchematicValidationError('invalid_id', `${label} must be a UUID.`)
    }
    return normalized
}

async function optionalSession(req) {
    const authorization = req.headers.authorization || ''
    const [type, token] = authorization.split(' ')
    if(type?.toLowerCase() !== 'bearer' || !token) return null
    return sessions.getSession(token)
}

async function userIsAdmin(userId) {
    if(!userId) return false
    const entitlements = await store.getEntitlements(userId)
    return entitlements.some(value => ['schematics:admin', 'admin'].includes(String(value).toLowerCase()))
}

async function requirePublishingAccess(req, res) {
    const admin = await userIsAdmin(req.userId)
    if(config.schematics.writeMode === 'disabled'
        || (config.schematics.writeMode === 'admin' && !admin)) {
        res.status(403).json({ error: 'schematics_writes_disabled' })
        return null
    }
    return { admin, identity: await store.getMinecraftIdentity(req.userId) }
}

function revisionJson(row) {
    return {
        id: row.revision_id,
        number: Number(row.revision_number),
        sha256: row.sha256,
        sizeBytes: Number(row.revision_size_bytes),
        blockCount: Number(row.block_count),
        formatId: row.format_id,
        formatVersion: Number(row.format_version),
        sanitization: row.sanitization || {}
    }
}

function schematicJson(row, detail = false) {
    const value = {
        schemaVersion: 2,
        id: row.id,
        ownerId: row.owner_id,
        name: row.name,
        creator: row.creator_display_name || row.creator,
        description: row.description || '',
        tags: row.tags || [],
        visibility: row.visibility,
        status: row.status,
        release: row.created_at,
        updatedAt: row.updated_at,
        downloads: Number(row.downloads || 0),
        likes: Number(row.likes || 0),
        views: Number(row.views || 0),
        version: row.release_version || row.legacy_version || null,
        revision: revisionJson(row),
        hash: row.sha256,
        sizeBytes: Number(row.revision_size_bytes),
        blockCount: Number(row.block_count),
        thumbnailUrl: `/v1/schematics/${row.id}/thumbnail?size=tiny`
    }
    if(detail) {
        value.schematicUrl = `/v1/schematics/${row.id}/download`
        value.thumbnailMediumUrl = `/v1/schematics/${row.id}/thumbnail?size=medium`
    }
    return value
}

const CURRENT_SELECT = `
    select s.id, s.owner_id, s.name, s.creator, s.description, s.tags, s.visibility,
           s.status, s.created_at, s.updated_at, s.downloads, s.likes, s.views,
           s.version as legacy_version, u.display_name as creator_display_name,
           r.id as revision_id, r.revision_number, r.sha256,
           r.size_bytes as revision_size_bytes, r.block_count, r.format_id,
           r.format_version, r.object_key, r.sanitization,
           coalesce(s.version, null) as release_version
    from schematics s
    join schematic_revisions r on r.id = s.current_revision_id
    left join users u on u.id = s.owner_id`

async function getRow(id, { includeInactive = false, client = db } = {}) {
    const params = [id]
    let clause = 'where s.id = $1'
    if(!includeInactive) clause += ' and s.visibility = \'public\' and s.status = \'active\''
    const result = await client.query(`${CURRENT_SELECT} ${clause}`, params)
    return result.rows[0] || null
}

async function consumeLimit(res, options) {
    const result = await rateLimits.consume(options)
    res.set('X-RateLimit-Limit', String(result.limit))
    res.set('X-RateLimit-Remaining', String(result.remaining))
    if(!result.allowed) {
        res.set('Retry-After', String(Math.max(1, Math.ceil((result.resetAt.getTime() - Date.now()) / 1000))))
        res.status(429).json({ error: 'rate_limited' })
        return false
    }
    return true
}

async function createUploadSession(req, res, body, { legacy = false } = {}) {
    const access = await requirePublishingAccess(req, res)
    if(!access) return null
    if(!access.identity) {
        res.status(403).json({ error: 'minecraft_profile_required' })
        return null
    }
    if(!await consumeLimit(res, {
        subject: `user:${req.userId}`,
        action: 'schematic_upload',
        limit: config.schematics.uploadRateLimit,
        windowMs: 60 * 60 * 1000
    })) return null

    const metadata = legacy
        ? { name: '', description: '', tags: [], visibility: PUBLIC_VISIBILITY, releaseVersion: null, legacy: true }
        : cleanMetadata(body)
    const targetSchematicId = body.targetSchematicId ? parseUuid(body.targetSchematicId, 'targetSchematicId') : null
    if(targetSchematicId) {
        const target = await getRow(targetSchematicId, { includeInactive: true })
        if(!target) {
            res.status(404).json({ error: 'schematic_not_found' })
            return null
        }
        if(target.status === 'deleted') {
            res.status(409).json({ error: 'schematic_deleted' })
            return null
        }
        if(Number(target.owner_id) !== Number(req.userId) && !access.admin) {
            res.status(403).json({ error: 'not_owner' })
            return null
        }
    }

    const mime = previewMime(body.previewMime || body.thumbnails?.[0]?.mime)
    const uploadId = crypto.randomUUID()
    const token = crypto.randomBytes(32).toString('base64url')
    const expiresAt = new Date(Date.now() + UPLOAD_TTL_MS)
    const schematicKey = `pending/${uploadId}/schematic.json`
    const previewKey = `pending/${uploadId}/preview.${previewExtension(mime)}`
    await db.query(
        `insert into schematic_upload_sessions
         (id, token_hash, user_id, target_schematic_id, metadata, schematic_pending_key,
          preview_pending_key, preview_mime, expires_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [uploadId, hashToken(token), req.userId, targetSchematicId, metadata, schematicKey, previewKey, mime, expiresAt]
    )
    const storage = getSchematicsObjectStorage()
    const schematicUploadUrl = await storage.signPut(schematicKey, { contentType: 'application/json', expiresIn: 900 })
    const previewUploadUrl = await storage.signPut(previewKey, { contentType: mime, expiresIn: 900 })
    audit(req, 'upload_session_created', { uploadId, targetSchematicId })
    const response = {
        schemaVersion: 2,
        token,
        expiresAt: expiresAt.toISOString(),
        uploads: {
            schematic: { objectKey: schematicKey, mime: 'application/json', uploadUrl: schematicUploadUrl },
            preview: { objectKey: previewKey, mime, uploadUrl: previewUploadUrl }
        }
    }
    if(legacy) {
        response.schematic = response.uploads.schematic
        response.thumbnails = [{
            label: 'medium', mime, objectKey: previewKey, uploadUrl: previewUploadUrl,
            width: body.thumbnails?.[0]?.width || null,
            height: body.thumbnails?.[0]?.height || null,
            sizeBytes: body.thumbnails?.[0]?.sizeBytes || null
        }]
    }
    res.status(201).json(response)
    return response
}

async function imageVariants(buffer) {
    if(buffer.length === 0 || buffer.length > PREVIEW_MAX_BYTES) {
        throw new SchematicValidationError('invalid_preview_size', `Preview must be between 1 and ${PREVIEW_MAX_BYTES} bytes.`)
    }
    try {
        const image = sharp(buffer, { failOn: 'warning', limitInputPixels: 32_000_000 })
        const metadata = await image.metadata()
        if(!['png', 'webp', 'jpeg'].includes(metadata.format) || !metadata.width || !metadata.height) {
            throw new SchematicValidationError('invalid_preview', 'Preview is not a valid PNG, WebP, or JPEG image.')
        }
        const output = []
        for(const [label, size] of [['tiny', 128], ['medium', 512]]) {
            const base = sharp(buffer, { failOn: 'warning', limitInputPixels: 32_000_000 })
                .rotate()
                .resize(size, size, { fit: 'inside', withoutEnlargement: true })
            const [webp, png] = await Promise.all([
                base.clone().webp({ quality: 82 }).toBuffer({ resolveWithObject: true }),
                base.clone().png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true })
            ])
            output.push({ label, mime: 'image/webp', extension: 'webp', buffer: webp.data, width: webp.info.width, height: webp.info.height })
            output.push({ label, mime: 'image/png', extension: 'png', buffer: png.data, width: png.info.width, height: png.info.height })
        }
        return output
    } catch(error) {
        if(error instanceof SchematicValidationError) throw error
        throw new SchematicValidationError('invalid_preview', 'Preview is not a valid PNG, WebP, or JPEG image.')
    }
}

async function markUploadFailed(tokenHash) {
    await db.query(
        `update schematic_upload_sessions set state = 'failed'
         where token_hash = $1 and state = 'finalizing'`,
        [tokenHash]
    ).catch(() => {})
}

async function finalizeUpload(req, res, metadataOverride = null) {
    const rawToken = String(req.params.token || '')
    const tokenHash = hashToken(rawToken)
    const claimed = await db.query(
        `update schematic_upload_sessions set state = 'finalizing'
         where token_hash = $1 and user_id = $2 and state = 'pending' and expires_at > now()
         returning *`,
        [tokenHash, req.userId]
    )
    if(claimed.rows.length === 0) {
        res.status(404).json({ error: 'upload_session_invalid_or_expired' })
        return
    }
    const upload = claimed.rows[0]
    let metadata
    let cleanupStorage = null
    let cleanupThumbnailKeys = []
    let databaseCommitted = false
    try {
        metadata = metadataOverride ? cleanMetadata(metadataOverride) : cleanMetadata(upload.metadata)
        const storage = getSchematicsObjectStorage()
        cleanupStorage = storage
        const [schematicHead, previewHead] = await Promise.all([
            storage.head(upload.schematic_pending_key),
            storage.head(upload.preview_pending_key)
        ])
        if(Number(schematicHead.ContentLength) > MAX_BYTES) {
            throw new SchematicValidationError('file_too_large', `Schematic files may not exceed ${MAX_BYTES} bytes.`)
        }
        if(Number(previewHead.ContentLength) > PREVIEW_MAX_BYTES) {
            throw new SchematicValidationError('invalid_preview_size', `Preview may not exceed ${PREVIEW_MAX_BYTES} bytes.`)
        }
        const [schematicBuffer, previewBuffer] = await Promise.all([
            storage.getBuffer(upload.schematic_pending_key, { maxBytes: MAX_BYTES }),
            storage.getBuffer(upload.preview_pending_key, { maxBytes: PREVIEW_MAX_BYTES })
        ])
        let raw
        try {
            raw = JSON.parse(schematicBuffer.toString('utf8'))
        } catch(_err) {
            throw new SchematicValidationError('invalid_json', 'Uploaded schematic is not valid JSON.')
        }
        const parsed = parseCanonicalSchematic(raw, {
            sourceBytes: schematicBuffer.length,
            stripBlockEntityNbt: true
        })
        const variants = await imageVariants(previewBuffer)
        const revisionId = crypto.randomUUID()
        const schematicKey = `schematics/${parsed.sha256.slice(0, 2)}/${parsed.sha256}.json`
        await storage.putImmutable(schematicKey, Buffer.from(parsed.serialized, 'utf8'), {
            contentType: 'application/json',
            cacheControl: 'private, max-age=31536000, immutable',
            metadata: { sha256: parsed.sha256, format: FORMAT_ID, version: String(FORMAT_VERSION) }
        })
        for(const variant of variants) {
            variant.objectKey = `thumbnails/${revisionId}/${variant.label}.${variant.extension}`
            const written = await storage.putImmutable(variant.objectKey, variant.buffer, {
                contentType: variant.mime,
                cacheControl: 'private, max-age=31536000, immutable'
            })
            if(!written.existing) cleanupThumbnailKeys.push(variant.objectKey)
        }

        const result = await db.withClient(async client => {
            await client.query('begin')
            try {
                const locked = await client.query(
                    `select * from schematic_upload_sessions
                     where id = $1 and user_id = $2 and state = 'finalizing'
                     for update`,
                    [upload.id, req.userId]
                )
                if(locked.rows.length === 0) throw new Error('Upload session was already consumed.')

                let schematicId = upload.target_schematic_id
                let revisionNumber = 1
                let alreadyCurrent = false
                if(schematicId) {
                    const schematic = await client.query('select * from schematics where id = $1 for update', [schematicId])
                    const row = schematic.rows[0]
                    const admin = await userIsAdmin(req.userId)
                    if(!row || (Number(row.owner_id) !== Number(req.userId) && !admin)) {
                        const error = new Error('Schematic ownership changed during upload.')
                        error.statusCode = 403
                        throw error
                    }
                    if(row.status === 'deleted') {
                        const error = new Error('Deleted schematics cannot receive new revisions.')
                        error.statusCode = 409
                        throw error
                    }
                    const current = await client.query('select sha256, revision_number from schematic_revisions where id = $1', [row.current_revision_id])
                    if(current.rows[0]?.sha256 === parsed.sha256) {
                        alreadyCurrent = true
                        revisionNumber = Number(current.rows[0].revision_number)
                    } else {
                        const latest = await client.query('select coalesce(max(revision_number), 0) as number from schematic_revisions where schematic_id = $1', [schematicId])
                        revisionNumber = Number(latest.rows[0].number) + 1
                    }
                } else {
                    schematicId = crypto.randomUUID()
                    const identity = await store.getMinecraftIdentity(req.userId)
                    await client.query(
                        `insert into schematics
                         (id, owner_id, name, creator, description, tags, visibility, status,
                          version, object_key, hash, size_bytes, block_count, release_date)
                         values ($1,$2,$3,$4,$5,$6,'public','active',$7,$8,$9,$10,$11,current_date)`,
                        [schematicId, req.userId, metadata.name, identity?.displayName || 'Minecraft Player',
                            metadata.description, metadata.tags, metadata.releaseVersion, schematicKey,
                            parsed.sha256, parsed.sizeBytes, parsed.blockCount]
                    )
                }

                if(!alreadyCurrent) {
                    await client.query(
                        `insert into schematic_revisions
                         (id, schematic_id, revision_number, sha256, size_bytes, block_count,
                          format_id, format_version, object_key, sanitization, created_by)
                         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
                        [revisionId, schematicId, revisionNumber, parsed.sha256, parsed.sizeBytes,
                            parsed.blockCount, FORMAT_ID, FORMAT_VERSION, schematicKey,
                            parsed.sanitization, req.userId]
                    )
                    for(const variant of variants) {
                        await client.query(
                            `insert into schematic_revision_thumbnails
                             (revision_id, size_label, mime, object_key, width, height, size_bytes)
                             values ($1,$2,$3,$4,$5,$6,$7)`,
                            [revisionId, variant.label, variant.mime, variant.objectKey,
                                variant.width, variant.height, variant.buffer.length]
                        )
                    }
                    await client.query(
                        `update schematics set current_revision_id = $2, name = $3, description = $4,
                         tags = $5, visibility = 'public', version = $6,
                         object_key = $7, hash = $8, size_bytes = $9, block_count = $10,
                         updated_by = $11, updated_at = now()
                         where id = $1`,
                        [schematicId, revisionId, metadata.name, metadata.description, metadata.tags,
                            metadata.releaseVersion, schematicKey, parsed.sha256, parsed.sizeBytes,
                            parsed.blockCount, req.userId]
                    )
                }
                await client.query(
                    `insert into schematics_audit(schematic_id, user_id, action, detail)
                     values ($1,$2,$3,$4)`,
                    [schematicId, req.userId, alreadyCurrent ? 'revision_already_current' : (revisionNumber === 1 ? 'published' : 'revision_published'), {
                        revisionNumber, sha256: parsed.sha256, sanitization: parsed.sanitization
                    }]
                )
                await client.query(
                    `update schematic_upload_sessions set state = 'consumed', consumed_at = now()
                     where id = $1`,
                    [upload.id]
                )
                await client.query('commit')
                return { schematicId, revisionNumber, alreadyCurrent }
            } catch(error) {
                await client.query('rollback')
                throw error
            }
        })
        databaseCommitted = true

        if(result.alreadyCurrent && cleanupThumbnailKeys.length > 0) {
            await Promise.allSettled(cleanupThumbnailKeys.map(key => storage.delete(key)))
            cleanupThumbnailKeys = []
        }

        await Promise.allSettled([
            storage.delete(upload.schematic_pending_key),
            storage.delete(upload.preview_pending_key)
        ])
        const row = await getRow(result.schematicId, { includeInactive: true })
        audit(req, result.alreadyCurrent ? 'revision_already_current' : 'schematic_published', {
            schematicId: result.schematicId,
            revisionNumber: result.revisionNumber,
            nbtRemoved: parsed.sanitization.blockEntityNbtRemoved
        })
        res.status(result.alreadyCurrent ? 200 : 201).json({
            ...schematicJson(row, true),
            alreadyCurrent: result.alreadyCurrent,
            warnings: parsed.warnings,
            sanitization: parsed.sanitization
        })
    } catch(error) {
        if(!databaseCommitted && cleanupStorage && cleanupThumbnailKeys.length > 0) {
            await Promise.allSettled(cleanupThumbnailKeys.map(key => cleanupStorage.delete(key)))
        }
        await markUploadFailed(tokenHash)
        if(error instanceof SchematicValidationError) {
            res.status(400).json({ error: error.code, message: error.message, details: error.details })
            return
        }
        throw error
    }
}

router.get('/schematics/capabilities', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=300')
    res.json({
        schemaVersion: 2,
        format: { id: FORMAT_ID, version: FORMAT_VERSION, maxBlocks: MAX_BLOCKS, maxBytes: MAX_BYTES },
        reads: 'public',
        writeMode: config.schematics.writeMode,
        allowedVisibilities: [PUBLIC_VISIBILITY],
        uploadTtlSeconds: UPLOAD_TTL_MS / 1000,
        sanitization: { blockEntityNbt: 'stripped' },
        features: config.schematics.features
    })
})

router.get('/schematics', asyncRoute(async (req, res) => {
    const limit = Math.min(60, Math.max(1, Number(req.query.limit) || 24))
    const offset = Math.max(0, Number(req.query.offset) || 0)
    const query = cleanText(req.query.query, 100, '')
    const creator = cleanText(req.query.creator, 80, '')
    const tags = cleanTags(req.query.tags)
    const where = ['s.visibility = \'public\'', 's.status = \'active\'']
    const params = []
    if(query) {
        params.push(`%${query}%`)
        where.push(`(s.name ilike $${params.length} or s.creator ilike $${params.length})`)
    }
    if(creator) {
        params.push(creator)
        where.push(`s.creator ilike $${params.length}`)
    }
    if(tags.length) {
        params.push(tags)
        where.push(`s.tags @> $${params.length}::text[]`)
    }
    const order = req.query.sort === 'release' ? 's.updated_at desc' : 's.likes desc, s.updated_at desc'
    const count = await db.query(`select count(*) from schematics s where ${where.join(' and ')}`, params)
    params.push(limit, offset)
    const rows = await db.query(
        `${CURRENT_SELECT} where ${where.join(' and ')} order by ${order} limit $${params.length - 1} offset $${params.length}`,
        params
    )
    const items = rows.rows.map(row => schematicJson(row))
    const etag = `"${crypto.createHash('sha256').update(JSON.stringify(items)).digest('hex')}"`
    res.set('ETag', etag)
    res.set('Cache-Control', 'public, max-age=60, stale-if-error=86400')
    if(req.headers['if-none-match'] === etag) {
        res.status(304).end()
        return
    }
    res.json({ schemaVersion: 2, items, total: Number(count.rows[0].count), limit, offset })
}))

router.get('/schematics/tags', asyncRoute(async (_req, res) => {
    const result = await db.query(
        `select tag, count(*)::int as count from schematics, unnest(tags) tag
         where visibility = 'public' and status = 'active'
         group by tag order by count desc, tag limit 100`
    )
    res.json({ schemaVersion: 2, items: result.rows })
}))

router.get('/schematics/:id', asyncRoute(async (req, res, next) => {
    if(req.params.id === 'admin') return next()
    const id = parseUuid(req.params.id)
    let row = await getRow(id)
    if(!row) {
        const session = await optionalSession(req)
        if(session) {
            const candidate = await getRow(id, { includeInactive: true })
            const admin = await userIsAdmin(session.userId)
            if(candidate && (Number(candidate.owner_id) === Number(session.userId) || admin)) row = candidate
        }
    }
    if(!row) {
        res.status(404).json({ error: 'schematic_not_found' })
        return
    }
    res.set('Cache-Control', row.status === STATUS_ACTIVE ? 'public, max-age=60' : 'private, no-store')
    res.json(schematicJson(row, true))
}))

router.get('/schematics/:id/download', asyncRoute(async (req, res) => {
    const row = await getRow(parseUuid(req.params.id))
    if(!row) {
        res.status(404).json({ error: 'schematic_not_found' })
        return
    }
    const url = await getSchematicsObjectStorage().signGet(row.object_key, 900)
    await db.query('update schematics set downloads = downloads + 1 where id = $1', [row.id])
    res.set('Cache-Control', 'no-store')
    res.redirect(302, url)
}))

router.get('/schematics/:id/thumbnail', asyncRoute(async (req, res) => {
    const size = req.query.size === 'medium' ? 'medium' : 'tiny'
    const preferredMime = String(req.headers.accept || '').includes('image/webp') ? 'image/webp' : 'image/png'
    const result = await db.query(
        `select t.object_key from schematics s
         join schematic_revision_thumbnails t on t.revision_id = s.current_revision_id
         where s.id = $1 and s.visibility = 'public' and s.status = 'active'
           and t.size_label = $2 and t.mime = $3`,
        [parseUuid(req.params.id), size, preferredMime]
    )
    if(result.rows.length === 0) {
        res.status(404).json({ error: 'thumbnail_not_found' })
        return
    }
    res.set('Cache-Control', 'public, max-age=300')
    res.redirect(302, await getSchematicsObjectStorage().signGet(result.rows[0].object_key, 900))
}))

router.post('/schematics/uploads', requireSession, asyncRoute(async (req, res) => {
    await createUploadSession(req, res, req.body || {})
}))

router.post('/schematics/uploads/:token/finalize', requireSession, asyncRoute(async (req, res) => {
    await finalizeUpload(req, res)
}))

router.post('/schematics/preflight', requireSession, asyncRoute(async (req, res) => {
    await createUploadSession(req, res, req.body || {}, { legacy: true })
}))

router.post('/schematics/upload/:token', requireSession, asyncRoute(async (req, res) => {
    await finalizeUpload(req, res, req.body || {})
}))

router.post('/schematics/:id/like', requireSession, asyncRoute(async (req, res) => {
    const id = parseUuid(req.params.id)
    const result = await db.withClient(async client => {
        await client.query('begin')
        try {
            await client.query('insert into schematics_likes(schematic_id, user_id) values ($1,$2) on conflict do nothing', [id, req.userId])
            const updated = await client.query(
                `update schematics set likes = (select count(*) from schematics_likes where schematic_id = $1)
                 where id = $1 and visibility = 'public' and status = 'active' returning likes`,
                [id]
            )
            await client.query('commit')
            return updated.rows[0]
        } catch(error) {
            await client.query('rollback')
            throw error
        }
    })
    if(!result) res.status(404).json({ error: 'schematic_not_found' })
    else res.json({ liked: true, likes: Number(result.likes) })
}))

router.delete('/schematics/:id/like', requireSession, asyncRoute(async (req, res) => {
    const id = parseUuid(req.params.id)
    await db.withClient(async client => {
        await client.query('begin')
        try {
            await client.query('delete from schematics_likes where schematic_id = $1 and user_id = $2', [id, req.userId])
            await client.query('update schematics set likes = (select count(*) from schematics_likes where schematic_id = $1) where id = $1', [id])
            await client.query('commit')
        } catch(error) {
            await client.query('rollback')
            throw error
        }
    })
    const row = await getRow(id)
    if(!row) res.status(404).json({ error: 'schematic_not_found' })
    else res.json({ liked: false, likes: Number(row.likes) })
}))

router.post('/schematics/:id/view', requireSession, asyncRoute(async (req, res) => {
    const id = parseUuid(req.params.id)
    await db.withClient(async client => {
        await client.query('begin')
        try {
            const inserted = await client.query(
                `insert into schematics_views(schematic_id, user_id) values ($1,$2)
                 on conflict (schematic_id, user_id) do update set last_viewed_at = now()
                 returning (xmax = 0) as is_new`,
                [id, req.userId]
            )
            if(inserted.rows[0]?.is_new) await client.query('update schematics set views = views + 1 where id = $1', [id])
            await client.query('commit')
        } catch(error) {
            await client.query('rollback')
            throw error
        }
    })
    const row = await getRow(id)
    if(!row) res.status(404).json({ error: 'schematic_not_found' })
    else res.json({ views: Number(row.views) })
}))

router.patch('/schematics/:id', requireSession, asyncRoute(async (req, res) => {
    const id = parseUuid(req.params.id)
    const current = await getRow(id, { includeInactive: true })
    const admin = await userIsAdmin(req.userId)
    if(!current) {
        res.status(404).json({ error: 'schematic_not_found' })
        return
    }
    if(Number(current.owner_id) !== Number(req.userId) && !admin) {
        res.status(403).json({ error: 'not_owner' })
        return
    }
    const metadata = cleanMetadata({
        name: req.body.name ?? current.name,
        description: req.body.description ?? current.description,
        tags: req.body.tags ?? current.tags,
        visibility: req.body.visibility ?? PUBLIC_VISIBILITY,
        releaseVersion: req.body.version ?? current.release_version
    })
    await db.query(
        `update schematics set name = $2, description = $3, tags = $4, version = $5,
         updated_by = $6, updated_at = now() where id = $1`,
        [id, metadata.name, metadata.description, metadata.tags, metadata.releaseVersion, req.userId]
    )
    await db.query('insert into schematics_audit(schematic_id,user_id,action,detail) values ($1,$2,$3,$4)', [id, req.userId, 'metadata_updated', {}])
    res.json(schematicJson(await getRow(id, { includeInactive: true }), true))
}))

router.delete('/schematics/:id', requireSession, asyncRoute(async (req, res) => {
    const id = parseUuid(req.params.id)
    const current = await getRow(id, { includeInactive: true })
    const admin = await userIsAdmin(req.userId)
    if(!current) return res.status(404).json({ error: 'schematic_not_found' })
    if(Number(current.owner_id) !== Number(req.userId) && !admin) return res.status(403).json({ error: 'not_owner' })
    await db.query('update schematics set status = \'deleted\', deleted_at = now(), updated_by = $2, updated_at = now() where id = $1', [id, req.userId])
    await db.query('insert into schematics_audit(schematic_id,user_id,action,detail) values ($1,$2,$3,$4)', [id, req.userId, 'soft_deleted', {}])
    audit(req, 'soft_deleted', { schematicId: id })
    res.status(204).end()
}))

router.post('/schematics/:id/report', requireSession, asyncRoute(async (req, res) => {
    const id = parseUuid(req.params.id)
    if(!await getRow(id)) return res.status(404).json({ error: 'schematic_not_found' })
    if(!await consumeLimit(res, {
        subject: `user:${req.userId}`,
        action: 'schematic_report',
        limit: config.schematics.reportRateLimit,
        windowMs: 24 * 60 * 60 * 1000
    })) return
    const reason = cleanText(req.body.reason, 80, 'other')
    const detail = cleanText(req.body.detail, 800, '')
    const result = await db.query(
        `insert into schematics_reports(schematic_id,user_id,reason,detail,status)
         values ($1,$2,$3,$4,'open') returning id, created_at`,
        [id, req.userId, reason, detail]
    )
    audit(req, 'reported', { schematicId: id, reportId: result.rows[0].id })
    res.status(201).json({ id: result.rows[0].id, status: 'open', createdAt: result.rows[0].created_at })
}))

async function requireAdmin(req, res) {
    if(await userIsAdmin(req.userId)) return true
    res.status(403).json({ error: 'admin_required' })
    return false
}

router.get('/schematics/admin/reports', requireSession, asyncRoute(async (req, res) => {
    if(!await requireAdmin(req, res)) return
    const status = cleanText(req.query.status, 16, 'open')
    const result = await db.query(
        `select r.id, r.schematic_id, r.user_id, r.reason, r.detail, r.status,
                r.created_at, r.resolved_at, r.resolution_note, s.name as schematic_name
         from schematics_reports r join schematics s on s.id = r.schematic_id
         where ($1 = 'all' or r.status = $1) order by r.created_at desc limit 200`,
        [status]
    )
    res.set('Cache-Control', 'private, no-store')
    res.json({ schemaVersion: 2, items: result.rows })
}))

router.post('/schematics/admin/reports/:reportId/resolve', requireSession, asyncRoute(async (req, res) => {
    if(!await requireAdmin(req, res)) return
    const reportId = Number(req.params.reportId)
    const result = await db.query(
        `update schematics_reports set status = 'resolved', resolved_by = $2,
         resolution_note = $3, resolved_at = now() where id = $1
         returning *`,
        [reportId, req.userId, cleanText(req.body.note, 800, '')]
    )
    if(result.rows.length === 0) return res.status(404).json({ error: 'report_not_found' })
    audit(req, 'report_resolved', { reportId })
    res.json(result.rows[0])
}))

async function moderate(req, res, status, action) {
    if(!await requireAdmin(req, res)) return
    const id = parseUuid(req.params.id)
    const result = await db.query(
        `update schematics set status = $2, deleted_at = case when $2 = 'deleted' then now() else null end,
         updated_by = $3, updated_at = now() where id = $1 returning id`,
        [id, status, req.userId]
    )
    if(result.rows.length === 0) return res.status(404).json({ error: 'schematic_not_found' })
    await db.query('insert into schematics_audit(schematic_id,user_id,action,detail) values ($1,$2,$3,$4)', [id, req.userId, action, {}])
    audit(req, action, { schematicId: id })
    res.json({ id, status })
}

router.post('/schematics/:id/hide', requireSession, asyncRoute((req, res) => moderate(req, res, 'hidden', 'hidden')))
router.post('/schematics/:id/restore', requireSession, asyncRoute((req, res) => moderate(req, res, 'active', 'restored')))
router.post('/schematics/:id/unhide', requireSession, asyncRoute((req, res) => moderate(req, res, 'active', 'restored')))

router.get('/schematics/admin/audit', requireSession, asyncRoute(async (req, res) => {
    if(!await requireAdmin(req, res)) return
    const result = await db.query(
        `select id, schematic_id, user_id, action, detail, created_at
         from schematics_audit order by created_at desc limit 500`
    )
    res.set('Cache-Control', 'private, no-store')
    res.json({ schemaVersion: 2, items: result.rows })
}))

module.exports = router
module.exports.cleanMetadata = cleanMetadata
module.exports.hashToken = hashToken
module.exports.imageVariants = imageVariants
