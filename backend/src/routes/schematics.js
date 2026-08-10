const express = require('express')
const path = require('path')

const {
    listSchematics,
    getSchematic,
    getSchematicByShareToken,
    createSchematic,
    incrementDownloads,
    hasLike,
    loadLikedForIds,
    addLike,
    removeLike,
    recordView,
    updateSchematic,
    setSchematicStatus,
    addAuditEntry,
    addReport,
    upsertThumbnail,
    listTags,
    findObjectKeyByHash,
    pickThumbnail
} = require('../services/schematicsStore')
const db = require('../db')
const storage = require('../services/schematicsStorage')
const objectStorage = require('../services/objectStorage')
const uploadTokens = require('../services/schematicsUploadTokens')
const sessions = require('../services/sessions')
const store = require('../services/store')
const { randomUUID } = require('crypto')
const { normalizeJsonSchematic } = require(path.resolve(__dirname, '..', '..', '..', 'libraries', 'schematics-core'))

const router = express.Router()
const UPLOAD_MAX_BYTES = 5 * 1024 * 1024
const UPLOAD_TTL_MS = 5 * 60 * 1000
const MAX_NAME_LENGTH = 80
const MAX_DESC_LENGTH = 800
const MAX_TAGS = 12
const MAX_TAG_LENGTH = 24
const MAX_BLOCKS = 250000
const MAX_REGEN_LIMIT = 100
const VISIBILITY_VALUES = new Set(['public', 'unlisted', 'private'])
const STATUS_VALUES = new Set(['active', 'hidden', 'deleted'])
const REPORT_MAX_LENGTH = 800
const SHARE_TOKEN_BYTES = 16
const SCHEMATIC_FORMATS = new Set(['json'])
const THUMBNAIL_MIMES = new Set(['image/png', 'image/webp', 'image/jpeg'])

const rateBuckets = new Map()

function rateLimit(key, limit, windowMs){
    const now = Date.now()
    const entry = rateBuckets.get(key)
    if(!entry || entry.resetAt <= now){
        rateBuckets.set(key, { count: 1, resetAt: now + windowMs })
        return false
    }
    entry.count += 1
    if(entry.count > limit){
        return true
    }
    return false
}

function getClientKey(req){
    const forwarded = req.headers['x-forwarded-for']
    if(typeof forwarded === 'string' && forwarded.length > 0){
        return forwarded.split(',')[0].trim()
    }
    return req.ip || req.connection?.remoteAddress || 'unknown'
}

function normalizeText(value, maxLength){
    if(typeof value !== 'string'){
        return ''
    }
    const trimmed = value.trim()
    if(!trimmed){
        return ''
    }
    return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed
}

function parseBoolean(value, fallback = false){
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

function validateJsonSchematic(schematic){
    if(!schematic || typeof schematic !== 'object'){
        return { ok: false, error: 'invalid_schematic' }
    }
    if(!Array.isArray(schematic.blocks)){
        return { ok: false, error: 'invalid_blocks' }
    }
    if(schematic.blocks.length > MAX_BLOCKS){
        return { ok: false, error: 'too_many_blocks', maxBlocks: MAX_BLOCKS }
    }
    for(const block of schematic.blocks){
        if(!block || typeof block !== 'object'){
            return { ok: false, error: 'invalid_block' }
        }
        if(!Array.isArray(block.pos) || block.pos.length !== 3){
            return { ok: false, error: 'invalid_block_pos' }
        }
        if(!block.pos.every(Number.isFinite)){
            return { ok: false, error: 'invalid_block_pos' }
        }
        if(typeof block.block !== 'string' || !block.block.trim()){
            return { ok: false, error: 'invalid_block_id' }
        }
    }
    return { ok: true }
}

function parseTags(raw){
    if(Array.isArray(raw)){
        return raw.map(tag => String(tag).trim()).filter(Boolean).slice(0, MAX_TAGS)
    }
    if(typeof raw === 'string'){
        return raw.split(',').map(tag => tag.trim()).filter(Boolean).slice(0, MAX_TAGS)
    }
    return []
}

function clampTags(tags){
    return tags
        .map(tag => String(tag).trim())
        .filter(Boolean)
        .map(tag => (tag.length > MAX_TAG_LENGTH ? tag.slice(0, MAX_TAG_LENGTH) : tag))
        .slice(0, MAX_TAGS)
}

async function getAuthUserId(req){
    const auth = req.headers.authorization || ''
    const [scheme, token] = auth.split(' ')
    if(!token || scheme?.toLowerCase() !== 'bearer'){
        return null
    }
    try {
        const session = await sessions.getSession(token)
        return session?.userId ?? null
    } catch (err) {
        return null
    }
}

async function getUserEntitlements(userId){
    if(!userId){
        return []
    }
    try {
        return await store.getEntitlements(userId)
    } catch (err) {
        return []
    }
}

async function isAdminUser(userId){
    const entitlements = await getUserEntitlements(userId)
    return entitlements.includes('schematics:admin') || entitlements.includes('admin')
}

function canAccessSchematic(entry, userId){
    if(!entry){
        return false
    }
    const visibility = entry.visibility || 'public'
    if(visibility === 'public'){
        return true
    }
    if(visibility === 'unlisted'){
        return true
    }
    return Boolean(userId && entry.ownerId && Number(entry.ownerId) === Number(userId))
}

function canManageSchematic(entry, userId, isAdmin){
    if(!entry){
        return false
    }
    if(isAdmin){
        return true
    }
    return Boolean(userId && entry.ownerId && Number(entry.ownerId) === Number(userId))
}

function normalizeTags(tags){
    return clampTags(tags).map(tag => tag.toLowerCase())
}

function normalizeShareToken(token){
    if(!token){
        return null
    }
    const trimmed = String(token).trim()
    return trimmed.length > 0 ? trimmed : null
}

function buildShareToken(){
    return randomUUID().replace(/-/g, '') + randomUUID().slice(0, SHARE_TOKEN_BYTES)
}

function normalizeHash(value){
    if(typeof value !== 'string'){
        return null
    }
    const trimmed = value.trim().toLowerCase()
    if(!/^[a-f0-9]{64}$/.test(trimmed)){
        return null
    }
    return trimmed
}

function normalizeFormatInput(value){
    if(value == null || value === ''){
        return { format: 'json', provided: false, valid: true }
    }
    if(typeof value !== 'string'){
        return { format: null, provided: true, valid: false }
    }
    const normalized = value.trim().toLowerCase()
    if(!normalized){
        return { format: 'json', provided: false, valid: true }
    }
    if(!SCHEMATIC_FORMATS.has(normalized)){
        return { format: null, provided: true, valid: false }
    }
    return { format: normalized, provided: true, valid: true }
}

function resolveSchematicMime(format){
    if(format === 'json'){
        return 'application/json'
    }
    return 'application/octet-stream'
}

function normalizeMime(value){
    if(!value){
        return null
    }
    return String(value).split(';')[0].trim().toLowerCase() || null
}

function normalizeThumbnailLabel(value, fallback = 'medium'){
    if(value == null){
        return fallback
    }
    const normalized = String(value).trim().toLowerCase()
    if(!normalized){
        return fallback
    }
    return normalized === 'small' ? 'tiny' : normalized
}

function normalizeThumbnailMime(value, fallback = 'image/png'){
    if(value == null || value === ''){
        return fallback
    }
    if(typeof value !== 'string'){
        return null
    }
    let normalized = value.trim().toLowerCase()
    if(!normalized){
        return fallback
    }
    if(normalized === 'image/jpg'){
        normalized = 'image/jpeg'
    }
    if(!THUMBNAIL_MIMES.has(normalized)){
        return null
    }
    return normalized
}

function getPreferredThumbnailMime(req){
    const accept = typeof req.headers.accept === 'string' ? req.headers.accept.toLowerCase() : ''
    return accept.includes('image/webp') ? 'image/webp' : 'image/png'
}

function getCacheControlForVisibility(visibility, forRedirect = false){
    if(visibility === 'public'){
        return forRedirect ? objectStorage.getRedirectCacheControl() : objectStorage.getPublicCacheControl()
    }
    return objectStorage.getPrivateCacheControl()
}

function normalizePreflightThumbnails(raw){
    if(!Array.isArray(raw) || raw.length === 0){
        return []
    }
    const seen = new Set()
    const normalized = []
    for(const thumb of raw){
        if(!thumb || typeof thumb !== 'object'){
            return null
        }
        const label = normalizeThumbnailLabel(thumb.label ?? thumb.size, 'medium')
        const mime = normalizeThumbnailMime(thumb.mime, 'image/png')
        if(!label || !mime){
            return null
        }
        const key = `${label}|${mime}`
        if(seen.has(key)){
            return null
        }
        seen.add(key)
        normalized.push({
            label,
            mime,
            width: Number.isFinite(Number(thumb.width)) ? Number(thumb.width) : null,
            height: Number.isFinite(Number(thumb.height)) ? Number(thumb.height) : null,
            sizeBytes: Number.isFinite(Number(thumb.sizeBytes)) ? Number(thumb.sizeBytes) : null
        })
    }
    return normalized
}

async function objectExists(objectKey){
    if(!objectKey){
        return false
    }
    if(objectStorage.isEnabled()){
        try {
            await objectStorage.headObject(objectKey)
            return true
        } catch (err) {
            return false
        }
    }
    try {
        return await storage.objectExists(objectKey)
    } catch (err) {
        return false
    }
}

function normalizeCommittedThumbnails(raw, tokenThumbs){
    if(!Array.isArray(tokenThumbs) || tokenThumbs.length === 0){
        return []
    }
    if(!Array.isArray(raw) || raw.length === 0){
        return null
    }
    const tokenMap = new Map()
    const tokenByLabel = new Map()
    for(const thumb of tokenThumbs){
        if(!thumb || typeof thumb !== 'object'){
            continue
        }
        const label = normalizeThumbnailLabel(thumb.label, '')
        const mime = normalizeThumbnailMime(thumb.mime, null)
        if(!label || !mime){
            continue
        }
        const key = `${label}|${mime}`
        if(!tokenMap.has(key)){
            tokenMap.set(key, thumb)
        }
        const list = tokenByLabel.get(label) || []
        list.push({ ...thumb, label, mime })
        tokenByLabel.set(label, list)
    }
    if(tokenMap.size === 0){
        return []
    }
    const seen = new Set()
    const normalized = []
    for(const thumb of raw){
        if(!thumb || typeof thumb !== 'object'){
            return null
        }
        const label = normalizeThumbnailLabel(thumb.label ?? thumb.size, '')
        if(!label){
            return null
        }
        let mime = normalizeThumbnailMime(thumb.mime, null)
        if(!mime){
            const list = tokenByLabel.get(label) || []
            if(list.length !== 1){
                return null
            }
            mime = normalizeThumbnailMime(list[0].mime, null)
        }
        if(!mime){
            return null
        }
        const key = `${label}|${mime}`
        if(seen.has(key)){
            return null
        }
        const tokenEntry = tokenMap.get(key)
        if(!tokenEntry){
            return null
        }
        if(tokenEntry.objectKey && thumb.objectKey && tokenEntry.objectKey !== thumb.objectKey){
            return null
        }
        const objectKey = tokenEntry.objectKey || thumb.objectKey || null
        if(!objectKey){
            return null
        }
        normalized.push({
            label,
            mime,
            objectKey,
            width: Number.isFinite(Number(thumb.width)) ? Number(thumb.width) : (Number.isFinite(Number(tokenEntry.width)) ? Number(tokenEntry.width) : null),
            height: Number.isFinite(Number(thumb.height)) ? Number(thumb.height) : (Number.isFinite(Number(tokenEntry.height)) ? Number(tokenEntry.height) : null),
            sizeBytes: Number.isFinite(Number(thumb.sizeBytes)) ? Number(thumb.sizeBytes) : (Number.isFinite(Number(tokenEntry.sizeBytes)) ? Number(tokenEntry.sizeBytes) : null)
        })
        seen.add(key)
    }
    if(normalized.length !== tokenMap.size){
        return null
    }
    return normalized
}

router.get('/schematics', async (req, res) => {
    const query = typeof req.query.query === 'string' ? req.query.query.trim() : ''
    const sort = typeof req.query.sort === 'string' ? req.query.sort : ''
    const offset = Number.isFinite(Number(req.query.offset)) ? Number(req.query.offset) : 0
    const limit = Number.isFinite(Number(req.query.limit)) ? Number(req.query.limit) : 24
    const creator = typeof req.query.creator === 'string' ? req.query.creator.trim() : ''
    const tags = typeof req.query.tags === 'string'
        ? req.query.tags.split(',').map(tag => tag.trim().toLowerCase()).filter(Boolean)
        : []
    const mine = String(req.query.mine || '').toLowerCase() === 'true'
    const userId = await getAuthUserId(req)
    const isAdmin = await isAdminUser(userId)
    const { items, total } = await listSchematics({ query, sort, offset, limit, userId, isAdmin, creator, tags, ownerOnly: mine })
    const likedSet = userId ? await loadLikedForIds(items.map(entry => entry.id), userId) : null
    res.json({
        total,
        items: items.map((entry) => ({
            id: entry.id,
            ownerId: entry.ownerId,
            name: entry.name,
            creator: entry.creator,
            rating: entry.rating,
            release: entry.release,
            tags: entry.tags,
            downloads: entry.downloads,
            version: entry.version,
            format: entry.format,
            visibility: entry.visibility,
            status: entry.status,
            likes: entry.likes,
            views: entry.views,
            liked: likedSet ? likedSet.has(entry.id) : false,
            thumbnails: entry.thumbnails || [],
            thumbnail: entry.thumbnail || null,
            thumbnailUrl: entry.thumbnail ? `/v1/schematics/${entry.id}/thumbnail?size=${encodeURIComponent(entry.thumbnail.label)}` : null
        }))
    })
})

router.get('/schematics/tags', async (_req, res) => {
    const tags = await listTags({ limit: 60 })
    res.json({ tags })
})

router.get('/schematics/share/:token', async (req, res) => {
    const token = normalizeShareToken(req.params.token)
    if(!token){
        res.status(404).json({ error: 'not_found' })
        return
    }
    const entry = await getSchematicByShareToken(token)
    if(!entry || entry.status !== 'active' || entry.visibility !== 'unlisted'){
        res.status(404).json({ error: 'not_found' })
        return
    }
    const userId = await getAuthUserId(req)
    const liked = userId ? await hasLike(entry.id, userId) : false
    let schematicUrl = null
    if(objectStorage.isEnabled()){
        const publicUrl = entry.visibility === 'public' ? objectStorage.getPublicUrl(entry.objectKey) : null
        schematicUrl = publicUrl || await objectStorage.signGetObject(entry.objectKey)
    }
    res.json({
        id: entry.id,
        ownerId: entry.ownerId,
        name: entry.name,
        creator: entry.creator,
        rating: entry.rating,
        release: entry.release,
        tags: entry.tags,
        downloads: entry.downloads,
        version: entry.version,
        format: entry.format,
        visibility: entry.visibility,
        likes: entry.likes,
        views: entry.views,
        liked,
        thumbnails: entry.thumbnails || [],
        thumbnail: entry.thumbnail || null,
        thumbnailUrl: entry.thumbnail ? `/v1/schematics/${entry.id}/thumbnail?size=${encodeURIComponent(entry.thumbnail.label)}` : null,
        schematic: entry.schematic,
        schematicUrl
    })
})

router.get('/schematics/:id', async (req, res) => {
    const entry = await getSchematic(req.params.id)
    if(!entry){
        res.status(404).json({ error: 'not_found' })
        return
    }
    const userId = await getAuthUserId(req)
    const isAdmin = await isAdminUser(userId)
    if(!canAccessSchematic(entry, userId) || (entry.status !== 'active' && !isAdmin)){
        res.status(404).json({ error: 'not_found' })
        return
    }
    const liked = userId ? await hasLike(entry.id, userId) : false
    let schematicUrl = null
    if(objectStorage.isEnabled()){
        const publicUrl = entry.visibility === 'public' ? objectStorage.getPublicUrl(entry.objectKey) : null
        schematicUrl = publicUrl || await objectStorage.signGetObject(entry.objectKey)
    }
    res.json({
        id: entry.id,
        name: entry.name,
        creator: entry.creator,
        rating: entry.rating,
        release: entry.release,
        tags: entry.tags,
        downloads: entry.downloads,
        version: entry.version,
        format: entry.format,
        visibility: entry.visibility,
        status: entry.status,
        likes: entry.likes,
        views: entry.views,
        liked,
        hash: entry.hash,
        sizeBytes: entry.sizeBytes,
        blockCount: entry.blockCount,
        shareToken: canManageSchematic(entry, userId, isAdmin) ? entry.shareToken : null,
        thumbnails: entry.thumbnails || [],
        thumbnail: entry.thumbnail || null,
        thumbnailUrl: entry.thumbnail ? `/v1/schematics/${entry.id}/thumbnail?size=${encodeURIComponent(entry.thumbnail.label)}` : null,
        schematic: entry.schematic,
        schematicUrl
    })
})

router.get('/schematics/:id/download', async (req, res) => {
    const entry = await getSchematic(req.params.id)
    if(!entry){
        res.status(404).json({ error: 'not_found' })
        return
    }
    const userId = await getAuthUserId(req)
    const isAdmin = await isAdminUser(userId)
    if(!canAccessSchematic(entry, userId) || (entry.status !== 'active' && !isAdmin)){
        res.status(404).json({ error: 'not_found' })
        return
    }
    incrementDownloads(entry.id).catch(() => {})
    if(objectStorage.isEnabled()){
        const publicUrl = entry.visibility === 'public' ? objectStorage.getPublicUrl(entry.objectKey) : null
        if(publicUrl){
            res.setHeader('Cache-Control', getCacheControlForVisibility(entry.visibility, true))
            res.redirect(publicUrl)
            return
        }
        const signedUrl = await objectStorage.signGetObject(entry.objectKey)
        res.setHeader('Cache-Control', getCacheControlForVisibility(entry.visibility, false))
        res.redirect(signedUrl)
        return
    }
    res.json(entry.schematic)
})

router.get('/schematics/:id/thumbnail', async (req, res) => {
    const entry = await getSchematic(req.params.id)
    if(!entry){
        res.status(404).json({ error: 'not_found' })
        return
    }
    const userId = await getAuthUserId(req)
    const isAdmin = await isAdminUser(userId)
    if(!canAccessSchematic(entry, userId) || (entry.status !== 'active' && !isAdmin)){
        res.status(404).json({ error: 'not_found' })
        return
    }
    const size = normalizeThumbnailLabel(typeof req.query.size === 'string' ? req.query.size : 'tiny', 'tiny')
    const requestedMime = typeof req.query.mime === 'string' ? normalizeThumbnailMime(req.query.mime, null) : null
    if(typeof req.query.mime === 'string' && !requestedMime){
        res.status(400).json({ error: 'invalid_mime' })
        return
    }
    const preferredMime = requestedMime || getPreferredThumbnailMime(req)
    const thumbnails = entry.thumbnails || []
    let thumb = pickThumbnail(thumbnails, size, preferredMime)
    if(!thumb){
        thumb = pickThumbnail(thumbnails, size) || pickThumbnail(thumbnails, null, preferredMime) || thumbnails[0] || null
    }
    if(!thumb?.objectKey){
        res.status(404).json({ error: 'thumbnail_not_found' })
        return
    }
    try {
    if(objectStorage.isEnabled()){
        res.setHeader('Vary', 'Accept')
        const publicUrl = entry.visibility === 'public' ? objectStorage.getPublicUrl(thumb.objectKey) : null
        if(publicUrl){
            res.setHeader('Cache-Control', getCacheControlForVisibility(entry.visibility, true))
            res.redirect(publicUrl)
            return
        }
        const object = await objectStorage.getObject(thumb.objectKey)
        res.setHeader('Content-Type', object?.ContentType || thumb.mime || 'image/png')
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
        res.setHeader('Cache-Control', getCacheControlForVisibility(entry.visibility, false))
        if(object?.ContentLength){
            res.setHeader('Content-Length', String(object.ContentLength))
        }
        if(object?.Body && typeof object.Body.pipe === 'function'){
                object.Body.pipe(res)
                return
            }
            const buffer = object?.Body ? Buffer.from(await object.Body.transformToByteArray()) : null
            if(!buffer){
                res.status(404).json({ error: 'thumbnail_not_found' })
                return
            }
            res.send(buffer)
            return
        }
    const buffer = await storage.readThumbnail(thumb.objectKey)
    res.setHeader('Content-Type', thumb.mime || 'image/png')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    res.setHeader('Cache-Control', getCacheControlForVisibility(entry.visibility, false))
    res.setHeader('Vary', 'Accept')
    res.send(buffer)
    } catch (err) {
        res.status(404).json({ error: 'thumbnail_not_found' })
    }
})

router.post('/schematics/:id/like', async (req, res) => {
    const userId = await getAuthUserId(req)
    if(!userId){
        res.status(401).json({ error: 'unauthorized' })
        return
    }
    const entry = await getSchematic(req.params.id)
    if(!entry){
        res.status(404).json({ error: 'not_found' })
        return
    }
    const isAdmin = await isAdminUser(userId)
    if(!canAccessSchematic(entry, userId) || (entry.status !== 'active' && !isAdmin)){
        res.status(404).json({ error: 'not_found' })
        return
    }
    const added = await addLike(entry.id, userId)
    const likes = Math.max(0, Number(entry.likes) + (added ? 1 : 0))
    res.json({ liked: true, likes })
})

router.delete('/schematics/:id/like', async (req, res) => {
    const userId = await getAuthUserId(req)
    if(!userId){
        res.status(401).json({ error: 'unauthorized' })
        return
    }
    const entry = await getSchematic(req.params.id)
    if(!entry){
        res.status(404).json({ error: 'not_found' })
        return
    }
    const isAdmin = await isAdminUser(userId)
    if(!canAccessSchematic(entry, userId) || (entry.status !== 'active' && !isAdmin)){
        res.status(404).json({ error: 'not_found' })
        return
    }
    const removed = await removeLike(entry.id, userId)
    const likes = Math.max(0, Number(entry.likes) - (removed ? 1 : 0))
    res.json({ liked: false, likes })
})

router.post('/schematics/:id/view', async (req, res) => {
    const userId = await getAuthUserId(req)
    if(!userId){
        res.status(401).json({ error: 'unauthorized' })
        return
    }
    const entry = await getSchematic(req.params.id)
    if(!entry){
        res.status(404).json({ error: 'not_found' })
        return
    }
    const isAdmin = await isAdminUser(userId)
    if(!canAccessSchematic(entry, userId) || (entry.status !== 'active' && !isAdmin)){
        res.status(404).json({ error: 'not_found' })
        return
    }
    const recorded = await recordView(entry.id, userId)
    const views = Math.max(0, Number(entry.views) + (recorded ? 1 : 0))
    res.json({ ok: true, views })
})

router.post('/schematics/preflight', async (req, res) => {
    await uploadTokens.cleanupExpired()
    const userId = await getAuthUserId(req)
    if(!userId){
        res.status(401).json({ error: 'unauthorized' })
        return
    }
    const clientKey = getClientKey(req)
    if(rateLimit(`${clientKey}:${userId}:preflight`, 20, 5 * 60 * 1000)){
        res.status(429).json({ error: 'rate_limited' })
        return
    }
    const sizeBytes = Number(req.body?.sizeBytes ?? 0)
    if(!Number.isFinite(sizeBytes) || sizeBytes <= 0){
        res.status(400).json({ error: 'invalid_size' })
        return
    }
    if(sizeBytes > UPLOAD_MAX_BYTES){
        res.status(413).json({ error: 'file_too_large', maxBytes: UPLOAD_MAX_BYTES })
        return
    }
    const formatInfo = normalizeFormatInput(req.body?.format)
    if(!formatInfo.valid){
        res.status(400).json({ error: 'invalid_format' })
        return
    }
    const format = formatInfo.format
    const schematicMime = resolveSchematicMime(format)
    const hash = normalizeHash(req.body?.hash)
    if(req.body?.hash && !hash){
        res.status(400).json({ error: 'invalid_hash' })
        return
    }
    const thumbnails = normalizePreflightThumbnails(req.body?.thumbnails)
    if(thumbnails == null){
        res.status(400).json({ error: 'invalid_thumbnails' })
        return
    }
    if(objectStorage.isEnabled() && thumbnails.length === 0){
        res.status(400).json({ error: 'thumbnail_required' })
        return
    }
    const visibilityRaw = typeof req.body?.visibility === 'string' ? req.body.visibility.trim().toLowerCase() : 'public'
    const visibility = VISIBILITY_VALUES.has(visibilityRaw) ? visibilityRaw : 'public'
    const cacheControl = getCacheControlForVisibility(visibility, false)
    const token = Math.random().toString(36).slice(2) + Date.now().toString(36)
    const expiresAt = Date.now() + UPLOAD_TTL_MS
    if(objectStorage.isEnabled()){
        const id = randomUUID()
        let schematicKey = null
        let requiresUpload = true
        let dedupe = false
        if(hash){
            const existingKey = await findObjectKeyByHash(hash, format)
            if(existingKey){
                schematicKey = existingKey
                requiresUpload = false
                dedupe = true
            } else {
                schematicKey = objectStorage.buildHashObjectKey(hash, format)
            }
        }
        if(!schematicKey){
            schematicKey = objectStorage.buildObjectKey(id, format)
        }
        const thumbEntries = []
        for(const thumb of thumbnails){
            const label = typeof thumb.label === 'string' ? thumb.label : 'medium'
            const mime = typeof thumb.mime === 'string' ? thumb.mime : 'image/png'
            const objectKey = objectStorage.buildThumbnailKey(id, label, mime)
            const uploadUrl = await objectStorage.signPutObject(objectKey, mime, {
                cacheControl
            })
            thumbEntries.push({
                label,
                mime,
                objectKey,
                uploadUrl,
                width: Number.isFinite(Number(thumb.width)) ? Number(thumb.width) : null,
                height: Number.isFinite(Number(thumb.height)) ? Number(thumb.height) : null,
                sizeBytes: Number.isFinite(Number(thumb.sizeBytes)) ? Number(thumb.sizeBytes) : null
            })
        }
        const tokenThumbs = thumbEntries.map((thumb) => ({
            label: thumb.label,
            mime: thumb.mime,
            objectKey: thumb.objectKey,
            width: thumb.width ?? null,
            height: thumb.height ?? null,
            sizeBytes: thumb.sizeBytes ?? null
        }))
        const schematicUploadUrl = requiresUpload
            ? await objectStorage.signPutObject(schematicKey, schematicMime, {
                cacheControl
            })
            : null
        await uploadTokens.createToken({
            token,
            userId,
            sizeBytes,
            hash,
            format,
            schematicId: id,
            schematicKey,
            thumbnails: tokenThumbs,
            requiresUpload,
            expiresAt
        })
        res.json({
            token,
            id,
            schematic: {
                objectKey: schematicKey,
                uploadUrl: schematicUploadUrl,
                mime: schematicMime,
                format,
                dedupe
            },
            thumbnails: thumbEntries,
            expiresInMs: UPLOAD_TTL_MS,
            maxBytes: UPLOAD_MAX_BYTES
        })
        return
    }
    await uploadTokens.createToken({ token, userId, sizeBytes, hash, format, expiresAt, requiresUpload: false })
    res.json({
        token,
        uploadUrl: `/v1/schematics/upload/${token}`,
        format,
        expiresInMs: UPLOAD_TTL_MS,
        maxBytes: UPLOAD_MAX_BYTES
    })
})

router.post('/schematics/upload/:token', async (req, res) => {
    await uploadTokens.cleanupExpired()
    const userId = await getAuthUserId(req)
    if(!userId){
        res.status(401).json({ error: 'unauthorized' })
        return
    }
    const clientKey = getClientKey(req)
    if(rateLimit(`${clientKey}:${userId}:upload`, 10, 5 * 60 * 1000)){
        res.status(429).json({ error: 'rate_limited' })
        return
    }
    const token = req.params.token
    const tokenEntry = await uploadTokens.getToken(token)
    if(!tokenEntry){
        res.status(410).json({ error: 'invalid_token' })
        return
    }
    if(tokenEntry.expiresAt && tokenEntry.expiresAt <= Date.now()){
        await uploadTokens.deleteToken(token)
        res.status(410).json({ error: 'invalid_token' })
        return
    }
    if(tokenEntry.userId && Number(tokenEntry.userId) !== Number(userId)){
        res.status(403).json({ error: 'forbidden' })
        return
    }
    const body = req.body || {}
    const name = normalizeText(body.name, MAX_NAME_LENGTH)
    if(!name){
        res.status(400).json({ error: 'invalid_name' })
        return
    }
    const creator = normalizeText(body.creator, MAX_NAME_LENGTH) || 'Unknown'
    const description = normalizeText(body.description, MAX_DESC_LENGTH) || null
    const version = typeof body.version === 'string' ? body.version.trim() : null
    const tags = normalizeTags(parseTags(body.tags))
    const sizeText = typeof body.sizeText === 'string' ? body.sizeText : null
    const accent = typeof body.accent === 'string' ? body.accent : null
    const visibilityRaw = typeof body.visibility === 'string' ? body.visibility.trim().toLowerCase() : 'public'
    const visibility = VISIBILITY_VALUES.has(visibilityRaw) ? visibilityRaw : 'public'
    const formatSource = body.format ?? tokenEntry.format ?? null
    const formatInfo = normalizeFormatInput(formatSource)
    if(!formatInfo.valid){
        res.status(400).json({ error: 'invalid_format' })
        return
    }
    const format = formatInfo.format
    if(tokenEntry.format && format !== tokenEntry.format){
        res.status(400).json({ error: 'format_mismatch' })
        return
    }
    const thumbnails = Array.isArray(body.thumbnails) ? body.thumbnails : []
    const rawHash = typeof body.hash === 'string' ? body.hash.trim() : null
    let hash = normalizeHash(rawHash)
    if(rawHash && !hash){
        res.status(400).json({ error: 'invalid_hash' })
        return
    }
    if(tokenEntry.hash && hash && hash !== tokenEntry.hash){
        res.status(400).json({ error: 'hash_mismatch' })
        return
    }
    if(tokenEntry.hash && !hash){
        hash = tokenEntry.hash
    }
    const sizeBytes = Number.isFinite(Number(body.sizeBytes)) ? Number(body.sizeBytes) : null
    if(tokenEntry.sizeBytes != null && sizeBytes != null && Number(sizeBytes) !== Number(tokenEntry.sizeBytes)){
        res.status(400).json({ error: 'invalid_size' })
        return
    }
    const effectiveSizeBytes = tokenEntry.sizeBytes ?? sizeBytes
    const blockCount = Number.isFinite(Number(body.blockCount)) ? Number(body.blockCount) : null
    if(objectStorage.isEnabled() && thumbnails.length === 0){
        res.status(400).json({ error: 'thumbnail_required' })
        return
    }
    if(visibility === 'private' || visibility === 'unlisted'){
        if(!body.shareToken){
            body.shareToken = buildShareToken()
        }
    }
    let entry
    if(objectStorage.isEnabled()){
        if(!tokenEntry.schematicKey){
            res.status(400).json({ error: 'invalid_object_key' })
            return
        }
        if(!tokenEntry.schematicId){
            res.status(400).json({ error: 'invalid_token' })
            return
        }
        if(body.objectKey && body.objectKey !== tokenEntry.schematicKey){
            res.status(400).json({ error: 'invalid_object_key' })
            return
        }
        if(tokenEntry.requiresUpload && !body.objectKey){
            res.status(400).json({ error: 'invalid_object_key' })
            return
        }
        const committedThumbnails = normalizeCommittedThumbnails(thumbnails, tokenEntry.thumbnails)
        if(!committedThumbnails || committedThumbnails.length === 0){
            res.status(400).json({ error: 'invalid_thumbnails' })
            return
        }
        try {
            const head = await objectStorage.headObject(tokenEntry.schematicKey)
            if(effectiveSizeBytes != null && Number.isFinite(Number(head?.ContentLength)) && Number(head.ContentLength) !== Number(effectiveSizeBytes)){
                res.status(400).json({ error: 'invalid_size' })
                return
            }
            const expectedSchematicMime = normalizeMime(resolveSchematicMime(format))
            const headMime = normalizeMime(head?.ContentType)
            if(headMime && expectedSchematicMime && headMime !== expectedSchematicMime){
                res.status(400).json({ error: 'invalid_mime' })
                return
            }
        } catch (err) {
            res.status(400).json({ error: 'missing_object' })
            return
        }
        for(const thumb of committedThumbnails){
            try {
                const head = await objectStorage.headObject(thumb.objectKey)
                if(thumb.sizeBytes != null && Number.isFinite(Number(head?.ContentLength)) && Number(head.ContentLength) !== Number(thumb.sizeBytes)){
                    res.status(400).json({ error: 'invalid_thumbnails' })
                    return
                }
                const expectedMime = normalizeMime(thumb.mime)
                const headMime = normalizeMime(head?.ContentType)
                if(headMime && expectedMime && headMime !== expectedMime){
                    res.status(400).json({ error: 'invalid_thumbnails' })
                    return
                }
            } catch (err) {
                res.status(400).json({ error: 'invalid_thumbnails' })
                return
            }
        }
        entry = await createSchematic({
            id: tokenEntry.schematicId,
            ownerId: userId,
            name,
            creator,
            description,
            version,
            tags,
            sizeText,
            accent,
            visibility,
            format,
            hash,
            sizeBytes: effectiveSizeBytes,
            blockCount,
            shareToken: body.shareToken,
            thumbnails: committedThumbnails,
            objectKey: tokenEntry.schematicKey,
            schematic: null
        })
    } else {
        const schematic = body.schematic
        if(!schematic || typeof schematic !== 'object'){
            res.status(400).json({ error: 'invalid_schematic' })
            return
        }
        const validation = validateJsonSchematic(schematic)
        if(!validation.ok){
            res.status(400).json(validation)
            return
        }
        let normalized = null
        try {
            normalized = await normalizeJsonSchematic(schematic, {})
        } catch (err) {
            res.status(400).json({ error: 'invalid_schematic' })
            return
        }
        const computedHash = normalized?.schematic?.meta?.hash || null
        if(computedHash && hash && hash !== computedHash){
            res.status(400).json({ error: 'hash_mismatch' })
            return
        }
        if(!hash && computedHash){
            hash = computedHash
        }
        const computedBlockCount = normalized?.schematic?.meta?.blockCount
        const effectiveBlockCount = Number.isFinite(Number(computedBlockCount)) ? Number(computedBlockCount) : blockCount
        entry = await createSchematic({
            ownerId: userId,
            name,
            creator,
            description,
            version,
            tags,
            sizeText,
            accent,
            visibility,
            format,
            hash,
            sizeBytes: effectiveSizeBytes,
            blockCount: effectiveBlockCount,
            shareToken: body.shareToken,
            thumbnails,
            schematic
        })
    }
    await addAuditEntry(entry.id, userId, 'create', { visibility })
    await uploadTokens.deleteToken(token)
    res.json({
        id: entry.id,
        name: entry.name,
        creator: entry.creator,
        release: entry.release,
        tags: entry.tags,
        version: entry.version,
        format: entry.format,
        visibility: entry.visibility,
        status: entry.status,
        likes: entry.likes,
        views: entry.views,
        thumbnails: entry.thumbnails || []
    })
})

router.patch('/schematics/:id', async (req, res) => {
    const userId = await getAuthUserId(req)
    if(!userId){
        res.status(401).json({ error: 'unauthorized' })
        return
    }
    const entry = await getSchematic(req.params.id)
    if(!entry){
        res.status(404).json({ error: 'not_found' })
        return
    }
    const isAdmin = await isAdminUser(userId)
    if(!canManageSchematic(entry, userId, isAdmin)){
        res.status(403).json({ error: 'forbidden' })
        return
    }
    const body = req.body || {}
    const patch = {
        name: normalizeText(body.name, MAX_NAME_LENGTH) || null,
        description: typeof body.description === 'string' ? body.description.trim().slice(0, MAX_DESC_LENGTH) : null,
        tags: Array.isArray(body.tags)
            ? normalizeTags(body.tags)
            : (typeof body.tags === 'string' ? normalizeTags(parseTags(body.tags)) : null),
        visibility: VISIBILITY_VALUES.has(String(body.visibility || '').toLowerCase()) ? String(body.visibility).toLowerCase() : null,
        version: typeof body.version === 'string' ? body.version.trim() : null,
        accent: typeof body.accent === 'string' ? body.accent.trim() : null
    }
    if(patch.visibility === 'unlisted' && !entry.shareToken){
        patch.shareToken = buildShareToken()
    }
    const updated = await updateSchematic(entry.id, patch, userId)
    await addAuditEntry(entry.id, userId, 'update', patch)
    res.json({
        id: updated.id,
        name: updated.name,
        creator: updated.creator,
        tags: updated.tags,
        visibility: updated.visibility,
        status: updated.status
    })
})

router.delete('/schematics/:id', async (req, res) => {
    const userId = await getAuthUserId(req)
    if(!userId){
        res.status(401).json({ error: 'unauthorized' })
        return
    }
    const entry = await getSchematic(req.params.id)
    if(!entry){
        res.status(404).json({ error: 'not_found' })
        return
    }
    const isAdmin = await isAdminUser(userId)
    if(!canManageSchematic(entry, userId, isAdmin)){
        res.status(403).json({ error: 'forbidden' })
        return
    }
    const updated = await setSchematicStatus(entry.id, 'deleted', userId)
    await addAuditEntry(entry.id, userId, 'delete', { status: 'deleted' })
    res.json({ id: updated.id, status: updated.status })
})

router.post('/schematics/:id/hide', async (req, res) => {
    const userId = await getAuthUserId(req)
    if(!userId){
        res.status(401).json({ error: 'unauthorized' })
        return
    }
    const isAdmin = await isAdminUser(userId)
    if(!isAdmin){
        res.status(403).json({ error: 'forbidden' })
        return
    }
    const updated = await setSchematicStatus(req.params.id, 'hidden', userId)
    if(!updated){
        res.status(404).json({ error: 'not_found' })
        return
    }
    await addAuditEntry(updated.id, userId, 'hide', { status: 'hidden' })
    res.json({ id: updated.id, status: updated.status })
})

router.post('/schematics/:id/unhide', async (req, res) => {
    const userId = await getAuthUserId(req)
    if(!userId){
        res.status(401).json({ error: 'unauthorized' })
        return
    }
    const isAdmin = await isAdminUser(userId)
    if(!isAdmin){
        res.status(403).json({ error: 'forbidden' })
        return
    }
    const updated = await setSchematicStatus(req.params.id, 'active', userId)
    if(!updated){
        res.status(404).json({ error: 'not_found' })
        return
    }
    await addAuditEntry(updated.id, userId, 'unhide', { status: 'active' })
    res.json({ id: updated.id, status: updated.status })
})

router.post('/schematics/:id/report', async (req, res) => {
    const userId = await getAuthUserId(req)
    const reason = normalizeText(req.body?.reason, 80) || null
    const detail = normalizeText(req.body?.detail, REPORT_MAX_LENGTH) || null
    if(!req.params.id){
        res.status(400).json({ error: 'invalid_id' })
        return
    }
    await addReport(req.params.id, userId, reason, detail)
    res.json({ ok: true })
})

router.post('/schematics/:id/thumbnail/preflight', async (req, res) => {
    const userId = await getAuthUserId(req)
    if(!userId){
        res.status(401).json({ error: 'unauthorized' })
        return
    }
    const entry = await getSchematic(req.params.id)
    if(!entry){
        res.status(404).json({ error: 'not_found' })
        return
    }
    const isAdmin = await isAdminUser(userId)
    if(!canManageSchematic(entry, userId, isAdmin)){
        res.status(403).json({ error: 'forbidden' })
        return
    }
    const label = normalizeThumbnailLabel(req.body?.label ?? req.body?.size, 'medium')
    const mime = normalizeThumbnailMime(req.body?.mime, 'image/png')
    if(!mime){
        res.status(400).json({ error: 'invalid_mime' })
        return
    }
    if(objectStorage.isEnabled()){
        const objectKey = objectStorage.buildThumbnailKey(entry.id, label, mime)
        const uploadUrl = await objectStorage.signPutObject(objectKey, mime, {
            cacheControl: getCacheControlForVisibility(entry.visibility, false)
        })
        res.json({ label, mime, objectKey, uploadUrl })
        return
    }
    res.json({ label, mime })
})

router.post('/schematics/:id/thumbnail/commit', async (req, res) => {
    const userId = await getAuthUserId(req)
    if(!userId){
        res.status(401).json({ error: 'unauthorized' })
        return
    }
    const entry = await getSchematic(req.params.id)
    if(!entry){
        res.status(404).json({ error: 'not_found' })
        return
    }
    const isAdmin = await isAdminUser(userId)
    if(!canManageSchematic(entry, userId, isAdmin)){
        res.status(403).json({ error: 'forbidden' })
        return
    }
    const label = normalizeThumbnailLabel(req.body?.label ?? req.body?.size, 'medium')
    const mime = normalizeThumbnailMime(req.body?.mime, 'image/png')
    if(!mime){
        res.status(400).json({ error: 'invalid_mime' })
        return
    }
    const objectKey = typeof req.body?.objectKey === 'string' ? req.body.objectKey : null
    if(objectStorage.isEnabled()){
        const expectedKey = objectStorage.buildThumbnailKey(entry.id, label, mime)
        if(!objectKey || objectKey !== expectedKey){
            res.status(400).json({ error: 'invalid_object_key' })
            return
        }
    }
    const thumb = {
        label,
        mime,
        objectKey,
        data: typeof req.body?.data === 'string' ? req.body.data : null,
        width: req.body?.width,
        height: req.body?.height,
        sizeBytes: req.body?.sizeBytes
    }
    const result = await upsertThumbnail(entry.id, thumb)
    await addAuditEntry(entry.id, userId, 'thumbnail_update', { label: thumb.label })
    res.json({ ok: Boolean(result) })
})

router.post('/schematics/thumbnails/regenerate', async (req, res) => {
    const userId = await getAuthUserId(req)
    if(!userId){
        res.status(401).json({ error: 'unauthorized' })
        return
    }
    const isAdmin = await isAdminUser(userId)
    if(!isAdmin){
        res.status(403).json({ error: 'forbidden' })
        return
    }
    const ids = Array.isArray(req.body?.ids)
        ? req.body.ids.map(id => String(id).trim()).filter(Boolean)
        : []
    const limit = Math.min(
        Math.max(1, Number(req.body?.limit || 20)),
        MAX_REGEN_LIMIT
    )
    const offset = Math.max(0, Number(req.body?.offset || 0))
    const labelsRaw = Array.isArray(req.body?.labels) ? req.body.labels : ['tiny', 'medium']
    const mimesRaw = Array.isArray(req.body?.mimes) ? req.body.mimes : ['image/webp', 'image/png']
    const includeExisting = parseBoolean(req.body?.includeExisting, false)
    const verifyObjects = parseBoolean(req.body?.verifyObjects, true)
    const repair = parseBoolean(req.body?.repair, true)

    const labels = labelsRaw
        .map(label => normalizeThumbnailLabel(label, null))
        .filter(Boolean)
    const mimes = mimesRaw
        .map(mime => normalizeThumbnailMime(mime, null))
        .filter(Boolean)
    if(labels.length === 0 || mimes.length === 0){
        res.status(400).json({ error: 'invalid_thumbnails' })
        return
    }

    let schematics = []
    try {
        if(ids.length > 0){
            const result = await db.query(
                `select id, visibility, status
                 from schematics
                 where id = any($1::uuid[]) and status != 'deleted'`,
                [ids]
            )
            schematics = result.rows
        } else {
            const result = await db.query(
                `select id, visibility, status
                 from schematics
                 where status != 'deleted'
                 order by created_at desc
                 limit $1 offset $2`,
                [limit, offset]
            )
            schematics = result.rows
        }
    } catch (err) {
        if(err?.code === '42P01'){
            res.status(503).json({ error: 'schema_missing' })
            return
        }
        throw err
    }

    const idList = schematics.map(row => row.id)
    const thumbMap = new Map()
    if(idList.length > 0){
        const thumbs = await db.query(
            `select schematic_id, size_label, mime, object_key
             from schematics_thumbnails
             where schematic_id = any($1::uuid[])`,
            [idList]
        )
        for(const row of thumbs.rows){
            const list = thumbMap.get(row.schematic_id) || []
            list.push({
                label: normalizeThumbnailLabel(row.size_label, 'medium'),
                mime: normalizeThumbnailMime(row.mime, 'image/png'),
                objectKey: row.object_key
            })
            thumbMap.set(row.schematic_id, list)
        }
    }

    const deletions = []
    const items = []
    for(const entry of schematics){
        const existing = thumbMap.get(entry.id) || []
        const existingMap = new Map()
        for(const thumb of existing){
            const key = `${thumb.label}|${thumb.mime}`
            existingMap.set(key, thumb)
        }
        const missing = []
        const stale = []
        for(const label of labels){
            for(const mime of mimes){
                const key = `${label}|${mime}`
                const found = existingMap.get(key)
                if(found){
                    if(verifyObjects){
                        const exists = await objectExists(found.objectKey)
                        if(!exists){
                            stale.push(found)
                            if(repair){
                                deletions.push({
                                    id: entry.id,
                                    label: found.label,
                                    mime: found.mime
                                })
                            }
                            missing.push({ label, mime })
                        } else if(includeExisting){
                            missing.push({
                                label,
                                mime,
                                objectKey: found.objectKey,
                                uploadUrl: null,
                                status: 'exists'
                            })
                        }
                    } else if(includeExisting){
                        missing.push({
                            label,
                            mime,
                            objectKey: found.objectKey,
                            uploadUrl: null,
                            status: 'exists'
                        })
                    }
                    continue
                }
                missing.push({ label, mime })
            }
        }

        const payload = []
        for(const item of missing){
            if(item.status === 'exists'){
                payload.push(item)
                continue
            }
            const objectKey = objectStorage.isEnabled()
                ? objectStorage.buildThumbnailKey(entry.id, item.label, item.mime)
                : storage.buildThumbnailKey(entry.id, item.label, item.mime)
            const uploadUrl = objectStorage.isEnabled()
                ? await objectStorage.signPutObject(objectKey, item.mime, {
                    cacheControl: getCacheControlForVisibility(entry.visibility, false)
                })
                : null
            payload.push({
                label: item.label,
                mime: item.mime,
                objectKey,
                uploadUrl
            })
        }

        if(payload.length > 0 || stale.length > 0){
            items.push({
                id: entry.id,
                visibility: entry.visibility || 'public',
                missing: payload,
                stale
            })
        }
    }

    let repaired = 0
    if(repair && deletions.length > 0){
        for(const del of deletions){
            const result = await db.query(
                `delete from schematics_thumbnails
                 where schematic_id = $1 and size_label = $2 and mime = $3`,
                [del.id, del.label, del.mime]
            )
            repaired += result.rowCount || 0
        }
    }

    res.json({
        ok: true,
        count: items.length,
        repaired,
        items
    })
})

module.exports = router
