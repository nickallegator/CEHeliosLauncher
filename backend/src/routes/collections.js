const express = require('express')
const { randomUUID } = require('crypto')
const sessions = require('../services/sessions')
const store = require('../services/store')
const {
    listCollections,
    getCollection,
    getCollectionByShareToken,
    createCollection,
    updateCollection,
    deleteCollection,
    addCollectionItem,
    removeCollectionItem,
    listCollectionSchematics,
    hasCollectionLike,
    loadCollectionLikes,
    addCollectionLike,
    removeCollectionLike,
    recordCollectionView
} = require('../services/collectionsStore')
const { getSchematic } = require('../services/schematicsStore')

const router = express.Router()
const VISIBILITY_VALUES = new Set(['public', 'unlisted', 'private'])
const MAX_NAME_LENGTH = 80
const MAX_DESC_LENGTH = 800
const SHARE_TOKEN_BYTES = 16

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

function normalizeVisibility(value){
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
    return VISIBILITY_VALUES.has(normalized) ? normalized : 'public'
}

function buildShareToken(){
    return randomUUID().replace(/-/g, '') + randomUUID().slice(0, SHARE_TOKEN_BYTES)
}

function canAccessCollection(entry, userId){
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

function canManageCollection(entry, userId, isAdmin){
    if(!entry){
        return false
    }
    if(isAdmin){
        return true
    }
    return Boolean(userId && entry.ownerId && Number(entry.ownerId) === Number(userId))
}

router.get('/collections', async (req, res) => {
    const visibility = typeof req.query.visibility === 'string' ? normalizeVisibility(req.query.visibility) : ''
    const creator = typeof req.query.creator === 'string' ? req.query.creator.trim() : ''
    const query = typeof req.query.query === 'string' ? req.query.query.trim() : ''
    const sort = typeof req.query.sort === 'string' ? req.query.sort.trim().toLowerCase() : ''
    const mine = String(req.query.mine || '').toLowerCase() === 'true'
    const limit = Number.isFinite(Number(req.query.limit)) ? Number(req.query.limit) : 24
    const offset = Number.isFinite(Number(req.query.offset)) ? Number(req.query.offset) : 0
    const userId = await getAuthUserId(req)
    const isAdmin = await isAdminUser(userId)
    const { items, total } = await listCollections({ visibility, ownerId: userId, creator, mine, limit, offset, userId, isAdmin, query, sort })
    const likedSet = userId ? await loadCollectionLikes(items.map(entry => entry.id), userId) : null
    res.json({
        total,
        items: items.map((entry) => ({
            id: entry.id,
            ownerId: entry.ownerId,
            creator: entry.creatorName,
            name: entry.name,
            description: entry.description,
            visibility: entry.visibility,
            itemCount: entry.itemCount,
            likes: entry.likes,
            views: entry.views,
            liked: likedSet ? likedSet.has(entry.id) : false,
            shareToken: canManageCollection(entry, userId, isAdmin) ? entry.shareToken : null,
            cover: entry.coverSchematicId
                ? {
                    schematicId: entry.coverSchematicId,
                    label: entry.coverLabel || 'medium',
                    url: `/v1/schematics/${entry.coverSchematicId}/thumbnail?size=${encodeURIComponent(entry.coverLabel || 'medium')}`
                }
                : null
        }))
    })
})

router.get('/collections/share/:token', async (req, res) => {
    const token = typeof req.params.token === 'string' ? req.params.token.trim() : ''
    if(!token){
        res.status(404).json({ error: 'not_found' })
        return
    }
    const entry = await getCollectionByShareToken(token)
    if(!entry || entry.visibility !== 'unlisted'){
        res.status(404).json({ error: 'not_found' })
        return
    }
    const userId = await getAuthUserId(req)
    const liked = userId ? await hasCollectionLike(entry.id, userId) : false
    const items = await listCollectionSchematics(entry.id)
    res.json({
        id: entry.id,
        ownerId: entry.ownerId,
        creator: entry.creatorName,
        name: entry.name,
        description: entry.description,
        visibility: entry.visibility,
        itemCount: entry.itemCount,
        likes: entry.likes,
        views: entry.views,
        liked,
        items
    })
})

router.get('/collections/:id', async (req, res) => {
    const entry = await getCollection(req.params.id)
    if(!entry){
        res.status(404).json({ error: 'not_found' })
        return
    }
    const userId = await getAuthUserId(req)
    const isAdmin = await isAdminUser(userId)
    if(!canAccessCollection(entry, userId) && !isAdmin){
        res.status(404).json({ error: 'not_found' })
        return
    }
    const liked = userId ? await hasCollectionLike(entry.id, userId) : false
    const items = await listCollectionSchematics(entry.id)
    res.json({
        id: entry.id,
        ownerId: entry.ownerId,
        creator: entry.creatorName,
        name: entry.name,
        description: entry.description,
        visibility: entry.visibility,
        itemCount: entry.itemCount,
        likes: entry.likes,
        views: entry.views,
        liked,
        shareToken: canManageCollection(entry, userId, isAdmin) ? entry.shareToken : null,
        cover: entry.coverSchematicId
            ? {
                schematicId: entry.coverSchematicId,
                label: entry.coverLabel || 'medium',
                url: `/v1/schematics/${entry.coverSchematicId}/thumbnail?size=${encodeURIComponent(entry.coverLabel || 'medium')}`
            }
            : null,
        items
    })
})

router.post('/collections', async (req, res) => {
    const userId = await getAuthUserId(req)
    if(!userId){
        res.status(401).json({ error: 'unauthorized' })
        return
    }
    const body = req.body || {}
    const name = normalizeText(body.name, MAX_NAME_LENGTH)
    if(!name){
        res.status(400).json({ error: 'invalid_name' })
        return
    }
    const description = normalizeText(body.description, MAX_DESC_LENGTH) || null
    const visibility = normalizeVisibility(body.visibility)
    const creatorName = normalizeText(body.creator, MAX_NAME_LENGTH) || 'Creator'
    const shareToken = (visibility === 'unlisted' || visibility === 'private') ? buildShareToken() : null
    const entry = await createCollection({
        ownerId: userId,
        creatorName,
        name,
        description,
        visibility,
        shareToken
    })
    res.json({
        id: entry.id,
        ownerId: entry.ownerId,
        creator: entry.creatorName,
        name: entry.name,
        description: entry.description,
        visibility: entry.visibility,
        itemCount: entry.itemCount,
        likes: entry.likes,
        views: entry.views,
        liked: false,
        shareToken: entry.shareToken
    })
})

router.patch('/collections/:id', async (req, res) => {
    const userId = await getAuthUserId(req)
    if(!userId){
        res.status(401).json({ error: 'unauthorized' })
        return
    }
    const entry = await getCollection(req.params.id)
    if(!entry){
        res.status(404).json({ error: 'not_found' })
        return
    }
    const isAdmin = await isAdminUser(userId)
    if(!canManageCollection(entry, userId, isAdmin)){
        res.status(403).json({ error: 'forbidden' })
        return
    }
    const body = req.body || {}
    const patch = {
        name: normalizeText(body.name, MAX_NAME_LENGTH) || null,
        description: typeof body.description === 'string' ? body.description.trim().slice(0, MAX_DESC_LENGTH) : null,
        visibility: VISIBILITY_VALUES.has(String(body.visibility || '').toLowerCase()) ? String(body.visibility).toLowerCase() : null,
        creatorName: normalizeText(body.creator, MAX_NAME_LENGTH) || null
    }
    if(patch.visibility === 'unlisted' && !entry.shareToken){
        patch.shareToken = buildShareToken()
    }
    const updated = await updateCollection(entry.id, patch, userId)
    res.json({
        id: updated.id,
        name: updated.name,
        description: updated.description,
        visibility: updated.visibility,
        likes: updated.likes,
        views: updated.views,
        shareToken: updated.shareToken
    })
})

router.delete('/collections/:id', async (req, res) => {
    const userId = await getAuthUserId(req)
    if(!userId){
        res.status(401).json({ error: 'unauthorized' })
        return
    }
    const entry = await getCollection(req.params.id)
    if(!entry){
        res.status(404).json({ error: 'not_found' })
        return
    }
    const isAdmin = await isAdminUser(userId)
    if(!canManageCollection(entry, userId, isAdmin)){
        res.status(403).json({ error: 'forbidden' })
        return
    }
    await deleteCollection(entry.id)
    res.json({ id: entry.id, status: 'deleted' })
})

router.post('/collections/:id/like', async (req, res) => {
    const userId = await getAuthUserId(req)
    if(!userId){
        res.status(401).json({ error: 'unauthorized' })
        return
    }
    const entry = await getCollection(req.params.id)
    if(!entry){
        res.status(404).json({ error: 'not_found' })
        return
    }
    const isAdmin = await isAdminUser(userId)
    if(!canAccessCollection(entry, userId) && !isAdmin){
        res.status(404).json({ error: 'not_found' })
        return
    }
    const added = await addCollectionLike(entry.id, userId)
    const likes = Math.max(0, Number(entry.likes) + (added ? 1 : 0))
    res.json({ liked: true, likes })
})

router.delete('/collections/:id/like', async (req, res) => {
    const userId = await getAuthUserId(req)
    if(!userId){
        res.status(401).json({ error: 'unauthorized' })
        return
    }
    const entry = await getCollection(req.params.id)
    if(!entry){
        res.status(404).json({ error: 'not_found' })
        return
    }
    const isAdmin = await isAdminUser(userId)
    if(!canAccessCollection(entry, userId) && !isAdmin){
        res.status(404).json({ error: 'not_found' })
        return
    }
    const removed = await removeCollectionLike(entry.id, userId)
    const likes = Math.max(0, Number(entry.likes) - (removed ? 1 : 0))
    res.json({ liked: false, likes })
})

router.post('/collections/:id/view', async (req, res) => {
    const userId = await getAuthUserId(req)
    if(!userId){
        res.status(401).json({ error: 'unauthorized' })
        return
    }
    const entry = await getCollection(req.params.id)
    if(!entry){
        res.status(404).json({ error: 'not_found' })
        return
    }
    const isAdmin = await isAdminUser(userId)
    if(!canAccessCollection(entry, userId) && !isAdmin){
        res.status(404).json({ error: 'not_found' })
        return
    }
    const recorded = await recordCollectionView(entry.id, userId)
    const views = Math.max(0, Number(entry.views) + (recorded ? 1 : 0))
    res.json({ ok: true, views })
})

router.post('/collections/:id/items', async (req, res) => {
    const userId = await getAuthUserId(req)
    if(!userId){
        res.status(401).json({ error: 'unauthorized' })
        return
    }
    const entry = await getCollection(req.params.id)
    if(!entry){
        res.status(404).json({ error: 'not_found' })
        return
    }
    const isAdmin = await isAdminUser(userId)
    if(!canManageCollection(entry, userId, isAdmin)){
        res.status(403).json({ error: 'forbidden' })
        return
    }
    const schematicId = typeof req.body?.schematicId === 'string' ? req.body.schematicId : null
    if(!schematicId){
        res.status(400).json({ error: 'invalid_schematic_id' })
        return
    }
    const schematic = await getSchematic(schematicId)
    if(!schematic){
        res.status(404).json({ error: 'schematic_not_found' })
        return
    }
    await addCollectionItem(entry.id, schematicId)
    res.json({ ok: true })
})

router.delete('/collections/:id/items/:schematicId', async (req, res) => {
    const userId = await getAuthUserId(req)
    if(!userId){
        res.status(401).json({ error: 'unauthorized' })
        return
    }
    const entry = await getCollection(req.params.id)
    if(!entry){
        res.status(404).json({ error: 'not_found' })
        return
    }
    const isAdmin = await isAdminUser(userId)
    if(!canManageCollection(entry, userId, isAdmin)){
        res.status(403).json({ error: 'forbidden' })
        return
    }
    await removeCollectionItem(entry.id, req.params.schematicId)
    res.json({ ok: true })
})

module.exports = router
