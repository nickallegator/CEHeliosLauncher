const { randomUUID } = require('crypto')
const db = require('../db')
const config = require('../config')
const { mapRow, pickThumbnail, loadThumbnailsForIds } = require('./schematicsStore')

let schemaAvailable = null
const COLLECTIONS = []
const COLLECTION_ITEMS = new Map()
const COLLECTION_LIKES = new Map()
const COLLECTION_VIEWS = new Map()
const COLLECTION_VIEW_THROTTLE_MS = 60 * 60 * 1000

async function ensureSchema(){
    if(schemaAvailable != null){
        return schemaAvailable
    }
    try {
        await db.query('select 1 from collections limit 1')
        schemaAvailable = true
    } catch (err) {
        if(err?.code === '42P01'){
            schemaAvailable = false
            return false
        }
        throw err
    }
    return schemaAvailable
}

function mapCollectionRow(row){
    return {
        id: row.id,
        ownerId: row.owner_id ?? null,
        creatorName: row.creator_name,
        name: row.name,
        description: row.description,
        visibility: row.visibility || 'public',
        likes: Number(row.likes) || 0,
        views: Number(row.views) || 0,
        shareToken: row.share_token || null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        deletedAt: row.deleted_at,
        itemCount: row.item_count != null ? Number(row.item_count) : 0,
        coverSchematicId: row.cover_schematic_id || null,
        coverLabel: row.cover_label || null
    }
}

async function listCollections({ visibility, ownerId, creator, mine, limit, offset, userId, isAdmin, query, sort }){
    const hasSchema = config.databaseUrl ? await ensureSchema() : false
    if(!config.databaseUrl || hasSchema === false){
        let items = COLLECTIONS.slice()
        if(query){
            const q = query.toLowerCase()
            items = items.filter((entry) => {
                return (entry.name || '').toLowerCase().includes(q)
                    || (entry.description || '').toLowerCase().includes(q)
                    || (entry.creatorName || '').toLowerCase().includes(q)
            })
        }
        if(creator){
            const c = creator.toLowerCase()
            items = items.filter((entry) => (entry.creatorName || '').toLowerCase().includes(c))
        }
        if(mine && userId){
            items = items.filter((entry) => entry.ownerId && Number(entry.ownerId) === Number(userId))
        } else if(visibility){
            items = items.filter((entry) => (entry.visibility || 'public') === visibility)
        } else {
            items = items.filter((entry) => (entry.visibility || 'public') === 'public')
        }
        items = items.map((entry) => ({
            ...entry,
            likes: Number(entry.likes) || 0,
            views: Number(entry.views) || 0
        }))
        if(sort === 'name'){
            items.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
        } else if(sort === 'items'){
            items.sort((a, b) => (Number(b.itemCount) || 0) - (Number(a.itemCount) || 0))
        } else {
            items.sort((a, b) => {
                const aTime = a.updatedAt ? new Date(a.updatedAt).getTime() : 0
                const bTime = b.updatedAt ? new Date(b.updatedAt).getTime() : 0
                return bTime - aTime
            })
        }
        const total = items.length
        const start = Math.max(0, offset || 0)
        const end = limit ? start + limit : items.length
        items = items.slice(start, end)
        return { items, total }
    }

    const conditions = ['deleted_at is null']
    const params = []
    if(creator){
        params.push(`%${creator.toLowerCase()}%`)
        conditions.push(`lower(creator_name) like $${params.length}`)
    }
    if(query){
        params.push(`%${query.toLowerCase()}%`)
        conditions.push(`(lower(name) like $${params.length} or lower(coalesce(description,'')) like $${params.length} or lower(creator_name) like $${params.length})`)
    }
    if(mine && userId){
        params.push(userId)
        conditions.push(`owner_id = $${params.length}`)
    } else if(visibility){
        params.push(visibility)
        conditions.push(`visibility = $${params.length}`)
    } else if(!isAdmin){
        conditions.push(`visibility = 'public'`)
    }
    if(!isAdmin && !mine && userId){
        params.push(userId)
        conditions.push(`(visibility = 'public' or (visibility in ('unlisted','private') and owner_id = $${params.length}))`)
    }
    const where = conditions.length ? `where ${conditions.join(' and ')}` : ''
    const limitVal = Number.isFinite(Number(limit)) ? Number(limit) : 24
    const offsetVal = Number.isFinite(Number(offset)) ? Number(offset) : 0
    params.push(limitVal)
    params.push(offsetVal)
    const orderBy = sort === 'name'
        ? 'lower(c.name) asc'
        : sort === 'items'
            ? 'count(ci.schematic_id) desc nulls last, c.updated_at desc'
            : 'c.updated_at desc'

    const result = await db.query(
        `select c.*,
                count(ci.schematic_id) as item_count,
                cover.cover_schematic_id,
                cover.cover_label
         from collections c
         left join collection_items ci on ci.collection_id = c.id
         left join lateral (
           select ci2.schematic_id as cover_schematic_id,
                  st.size_label as cover_label
           from collection_items ci2
           join schematics_thumbnails st on st.schematic_id = ci2.schematic_id
           where ci2.collection_id = c.id
           order by ci2.added_at desc,
                    case when st.size_label = 'medium' then 0
                         when st.size_label in ('tiny', 'small') then 1
                         else 2 end
           limit 1
         ) cover on true
         ${where}
         group by c.id, cover.cover_schematic_id, cover.cover_label
         order by ${orderBy}
         limit $${params.length - 1} offset $${params.length}`,
        params
    )
    const totalResult = await db.query(
        `select count(*)::int as count from collections c ${where}`,
        conditions.length ? params.slice(0, params.length - 2) : []
    )
    return {
        items: result.rows.map(mapCollectionRow),
        total: totalResult.rows[0]?.count || 0
    }
}

async function getCollection(id){
    const hasSchema = config.databaseUrl ? await ensureSchema() : false
    if(!config.databaseUrl || hasSchema === false){
        return COLLECTIONS.find(item => item.id === id) || null
    }
    const result = await db.query(
        `select c.*, count(ci.schematic_id) as item_count
         from collections c
         left join collection_items ci on ci.collection_id = c.id
         where c.id = $1
         group by c.id`,
        [id]
    )
    if(result.rows.length === 0){
        return null
    }
    return mapCollectionRow(result.rows[0])
}

async function getCollectionByShareToken(token){
    const hasSchema = config.databaseUrl ? await ensureSchema() : false
    if(!config.databaseUrl || hasSchema === false){
        return null
    }
    const result = await db.query(
        `select c.*, count(ci.schematic_id) as item_count
         from collections c
         left join collection_items ci on ci.collection_id = c.id
         where c.share_token = $1
         group by c.id`,
        [token]
    )
    if(result.rows.length === 0){
        return null
    }
    return mapCollectionRow(result.rows[0])
}

async function createCollection({ ownerId, creatorName, name, description, visibility, shareToken }){
    const id = randomUUID()
    const now = new Date()
    const hasSchema = config.databaseUrl ? await ensureSchema() : false
    if(!config.databaseUrl || hasSchema === false){
        const entry = {
            id,
            ownerId,
            creatorName,
            name,
            description,
            visibility,
            shareToken: shareToken || null,
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
            itemCount: 0,
            likes: 0,
            views: 0
        }
        COLLECTIONS.unshift(entry)
        return entry
    }
    await db.query(
        `insert into collections
         (id, owner_id, creator_name, name, description, visibility, share_token, created_at, updated_at)
         values
         ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id, ownerId || null, creatorName || '', name, description || null, visibility, shareToken || null, now, now]
    )
    return getCollection(id)
}

async function updateCollection(id, patch, userId){
    const hasSchema = config.databaseUrl ? await ensureSchema() : false
    if(!config.databaseUrl || hasSchema === false){
        return null
    }
    const fields = []
    const params = []
    const setField = (key, value) => {
        params.push(value)
        fields.push(`${key} = $${params.length}`)
    }
    if(patch.name != null){
        setField('name', patch.name)
    }
    if(patch.description != null){
        setField('description', patch.description)
    }
    if(patch.visibility != null){
        setField('visibility', patch.visibility)
    }
    if(patch.shareToken != null){
        setField('share_token', patch.shareToken)
    }
    if(patch.creatorName != null){
        setField('creator_name', patch.creatorName)
    }
    setField('updated_at', new Date())
    if(fields.length === 0){
        return getCollection(id)
    }
    params.push(id)
    const result = await db.query(
        `update collections set ${fields.join(', ')} where id = $${params.length} returning id`,
        params
    )
    if(result.rows.length === 0){
        return null
    }
    return getCollection(id)
}

async function deleteCollection(id){
    const hasSchema = config.databaseUrl ? await ensureSchema() : false
    if(!config.databaseUrl || hasSchema === false){
        return null
    }
    await db.query(
        `update collections set deleted_at = now() where id = $1`,
        [id]
    )
    return getCollection(id)
}

async function addCollectionItem(collectionId, schematicId){
    const hasSchema = config.databaseUrl ? await ensureSchema() : false
    if(!config.databaseUrl || hasSchema === false){
        const list = COLLECTION_ITEMS.get(collectionId) || []
        if(!list.includes(schematicId)){
            list.push(schematicId)
            COLLECTION_ITEMS.set(collectionId, list)
        }
        return true
    }
    await db.query(
        `insert into collection_items (collection_id, schematic_id)
         values ($1,$2)
         on conflict do nothing`,
        [collectionId, schematicId]
    )
    await db.query(`update collections set updated_at = now() where id = $1`, [collectionId])
    return true
}

async function removeCollectionItem(collectionId, schematicId){
    const hasSchema = config.databaseUrl ? await ensureSchema() : false
    if(!config.databaseUrl || hasSchema === false){
        const list = COLLECTION_ITEMS.get(collectionId) || []
        COLLECTION_ITEMS.set(collectionId, list.filter(id => id !== schematicId))
        return true
    }
    await db.query(
        `delete from collection_items where collection_id = $1 and schematic_id = $2`,
        [collectionId, schematicId]
    )
    await db.query(`update collections set updated_at = now() where id = $1`, [collectionId])
    return true
}

function getCollectionEntry(collectionId){
    return COLLECTIONS.find(item => item.id === collectionId) || null
}

function getCollectionLikeSet(collectionId){
    if(!collectionId){
        return null
    }
    let set = COLLECTION_LIKES.get(collectionId)
    if(!set){
        set = new Set()
        COLLECTION_LIKES.set(collectionId, set)
    }
    return set
}

function getCollectionViewMap(collectionId){
    if(!collectionId){
        return null
    }
    let map = COLLECTION_VIEWS.get(collectionId)
    if(!map){
        map = new Map()
        COLLECTION_VIEWS.set(collectionId, map)
    }
    return map
}

async function hasCollectionLike(collectionId, userId){
    if(!collectionId || !userId){
        return false
    }
    if(!config.databaseUrl || schemaAvailable === false){
        const set = getCollectionLikeSet(collectionId)
        return set ? set.has(String(userId)) : false
    }
    const hasSchema = await ensureSchema()
    if(!hasSchema){
        return false
    }
    const result = await db.query(
        `select 1 from collections_likes where collection_id = $1 and user_id = $2`,
        [collectionId, userId]
    )
    return result.rows.length > 0
}

async function loadCollectionLikes(ids, userId){
    if(!userId || !Array.isArray(ids) || ids.length === 0){
        return new Set()
    }
    if(!config.databaseUrl || schemaAvailable === false){
        const liked = new Set()
        ids.forEach((id) => {
            const set = getCollectionLikeSet(id)
            if(set && set.has(String(userId))){
                liked.add(id)
            }
        })
        return liked
    }
    const hasSchema = await ensureSchema()
    if(!hasSchema){
        return new Set()
    }
    const result = await db.query(
        `select collection_id
         from collections_likes
         where user_id = $1 and collection_id = any($2::uuid[])`,
        [userId, ids]
    )
    return new Set(result.rows.map(row => row.collection_id))
}

async function addCollectionLike(collectionId, userId){
    if(!collectionId || !userId){
        return false
    }
    if(!config.databaseUrl || schemaAvailable === false){
        const set = getCollectionLikeSet(collectionId)
        if(!set){
            return false
        }
        const key = String(userId)
        if(set.has(key)){
            return false
        }
        set.add(key)
        const entry = getCollectionEntry(collectionId)
        if(entry){
            entry.likes = Math.max(0, Number(entry.likes || 0) + 1)
        }
        return true
    }
    const hasSchema = await ensureSchema()
    if(!hasSchema){
        return false
    }
    const result = await db.query(
        `insert into collections_likes (collection_id, user_id)
         values ($1,$2)
         on conflict do nothing`,
        [collectionId, userId]
    )
    if(result.rowCount > 0){
        await db.query(`update collections set likes = likes + 1 where id = $1`, [collectionId])
        return true
    }
    return false
}

async function removeCollectionLike(collectionId, userId){
    if(!collectionId || !userId){
        return false
    }
    if(!config.databaseUrl || schemaAvailable === false){
        const set = getCollectionLikeSet(collectionId)
        if(!set){
            return false
        }
        const key = String(userId)
        if(!set.has(key)){
            return false
        }
        set.delete(key)
        const entry = getCollectionEntry(collectionId)
        if(entry){
            entry.likes = Math.max(0, Number(entry.likes || 0) - 1)
        }
        return true
    }
    const hasSchema = await ensureSchema()
    if(!hasSchema){
        return false
    }
    const result = await db.query(
        `delete from collections_likes where collection_id = $1 and user_id = $2`,
        [collectionId, userId]
    )
    if(result.rowCount > 0){
        await db.query(`update collections set likes = greatest(likes - 1, 0) where id = $1`, [collectionId])
        return true
    }
    return false
}

async function recordCollectionView(collectionId, userId){
    if(!collectionId || !userId){
        return false
    }
    if(!config.databaseUrl || schemaAvailable === false){
        const map = getCollectionViewMap(collectionId)
        if(!map){
            return false
        }
        const key = String(userId)
        const now = Date.now()
        const last = map.get(key) || 0
        if(now - last < COLLECTION_VIEW_THROTTLE_MS){
            return false
        }
        map.set(key, now)
        const entry = getCollectionEntry(collectionId)
        if(entry){
            entry.views = Math.max(0, Number(entry.views || 0) + 1)
        }
        return true
    }
    const hasSchema = await ensureSchema()
    if(!hasSchema){
        return false
    }
    const now = new Date()
    const result = await db.query(
        `select last_viewed_at
         from collections_views
         where collection_id = $1 and user_id = $2`,
        [collectionId, userId]
    )
    if(result.rows.length === 0){
        await db.query(
            `insert into collections_views (collection_id, user_id, last_viewed_at)
             values ($1,$2,$3)`,
            [collectionId, userId, now]
        )
        await db.query(`update collections set views = views + 1 where id = $1`, [collectionId])
        return true
    }
    const lastViewed = result.rows[0].last_viewed_at ? new Date(result.rows[0].last_viewed_at).getTime() : 0
    if(now.getTime() - lastViewed >= COLLECTION_VIEW_THROTTLE_MS){
        await db.query(
            `update collections_views set last_viewed_at = $1 where collection_id = $2 and user_id = $3`,
            [now, collectionId, userId]
        )
        await db.query(`update collections set views = views + 1 where id = $1`, [collectionId])
        return true
    }
    return false
}

async function listCollectionSchematics(collectionId){
    const hasSchema = config.databaseUrl ? await ensureSchema() : false
    if(!config.databaseUrl || hasSchema === false){
        return []
    }
    const result = await db.query(
        `select s.id, s.owner_id, s.name, s.creator, s.rating, s.release_date, s.downloads, s.version, s.format, s.tags, s.description,
                s.size_text, s.accent, s.visibility, s.status, s.likes, s.views, s.hash, s.size_bytes, s.block_count, s.share_token, s.deleted_at, s.object_key
         from collection_items ci
         join schematics s on s.id = ci.schematic_id
         where ci.collection_id = $1
         order by ci.added_at desc`,
        [collectionId]
    )
    const rows = result.rows.map(mapRow)
    const thumbMap = await loadThumbnailsForIds(rows.map(row => row.id))
    return rows.map((row) => {
        const thumbnails = thumbMap.get(row.id) || []
        const selected = pickThumbnail(thumbnails, 'tiny')
            || pickThumbnail(thumbnails, 'medium')
            || pickThumbnail(thumbnails, null)
            || null
        return {
            ...row,
            thumbnails,
            thumbnail: selected,
            thumbnailUrl: selected
                ? `/v1/schematics/${row.id}/thumbnail?size=${encodeURIComponent(selected.label)}`
                : null
        }
    })
}

module.exports = {
    ensureSchema,
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
}
