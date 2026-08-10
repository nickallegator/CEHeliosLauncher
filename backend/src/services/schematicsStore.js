const { randomUUID } = require('crypto')

const config = require('../config')
const db = require('../db')
const storage = require('./schematicsStorage')

const SCHEMATICS = []
let seeded = false
let schemaAvailable = null

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

function normalizeThumbnailLabel(value){
    const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
    if(!raw){
        return 'thumb'
    }
    return raw === 'small' ? 'tiny' : raw
}

function normalizeThumbnails(thumbnails){
    if(!Array.isArray(thumbnails)){
        return []
    }
    return thumbnails
        .filter(entry => entry && typeof entry === 'object')
        .map((entry) => ({
            label: normalizeThumbnailLabel(entry.label || entry.size || 'thumb'),
            mime: String(entry.mime || 'image/png').toLowerCase(),
            width: Number.isFinite(Number(entry.width)) ? Number(entry.width) : null,
            height: Number.isFinite(Number(entry.height)) ? Number(entry.height) : null,
            sizeBytes: Number.isFinite(Number(entry.sizeBytes)) ? Number(entry.sizeBytes) : null,
            objectKey: entry.objectKey || null
        }))
        .filter(entry => entry.objectKey)
}

function decodeThumbnailData(thumbnail){
    if(!thumbnail?.data || typeof thumbnail.data !== 'string'){
        return null
    }
    try {
        return Buffer.from(thumbnail.data, 'base64')
    } catch (err) {
        return null
    }
}

function normalizeFormat(value){
    return storage.normalizeFormat ? storage.normalizeFormat(value) : 'json'
}

async function loadThumbnailsForIds(ids){
    if(!ids || ids.length === 0){
        return new Map()
    }
    const hasSchema = config.databaseUrl ? await ensureSchema() : false
    if(!config.databaseUrl || hasSchema === false){
        return new Map()
    }
    try {
        const result = await db.query(
            `select schematic_id, size_label, mime, object_key, width, height, size_bytes
             from schematics_thumbnails
             where schematic_id = any($1::uuid[])`,
            [ids]
        )
        const map = new Map()
        result.rows.forEach((row) => {
            const list = map.get(row.schematic_id) || []
            list.push({
                label: normalizeThumbnailLabel(row.size_label),
                mime: row.mime ? String(row.mime).toLowerCase() : 'image/png',
                objectKey: row.object_key,
                width: row.width,
                height: row.height,
                sizeBytes: row.size_bytes
            })
            map.set(row.schematic_id, list)
        })
        return map
    } catch (err) {
        if(err?.code === '42P01'){
            return new Map()
        }
        throw err
    }
}

function buildTowerBlocks() {
    const blocks = []
    for(let x=0; x<3; x++){
        for(let z=0; z<3; z++){
            blocks.push({ pos: [x, 0, z], block: 'minecraft:stone_bricks' })
        }
    }
    for(let y=1; y<=6; y++){
        blocks.push({ pos: [0, y, 0], block: 'minecraft:stone_bricks' })
        blocks.push({ pos: [2, y, 0], block: 'minecraft:stone_bricks' })
        blocks.push({ pos: [0, y, 2], block: 'minecraft:stone_bricks' })
        blocks.push({ pos: [2, y, 2], block: 'minecraft:stone_bricks' })
    }
    blocks.push({ pos: [1, 7, 1], block: 'minecraft:torch' })
    return blocks
}

function buildVariedBlocks(){
    const blocks = []
    const palette = [
        { block: 'minecraft:stone_bricks' },
        { block: 'minecraft:oak_planks' },
        { block: 'minecraft:glass' },
        { block: 'minecraft:water', state: { level: 0 } },
        { block: 'minecraft:oak_leaves', state: { persistent: true } },
        { block: 'minecraft:glowstone' },
        { block: 'minecraft:torch' },
        { block: 'minecraft:sea_lantern' },
        { block: 'minecraft:grass_block' }
    ]
    let index = 0
    for(let y=0; y<4; y++){
        for(let x=0; x<4; x++){
            for(let z=0; z<4; z++){
                const entry = palette[index % palette.length]
                blocks.push({ pos: [x, y, z], block: entry.block, state: entry.state })
                index += 1
            }
        }
    }
    blocks.push({ pos: [1, 4, 1], block: 'minecraft:lantern' })
    blocks.push({ pos: [2, 4, 2], block: 'minecraft:campfire' })
    return blocks
}

function buildGardenBlocks(){
    const blocks = []
    for(let x=0; x<5; x++){
        for(let z=0; z<5; z++){
            blocks.push({ pos: [x, 0, z], block: 'minecraft:grass_block' })
        }
    }
    blocks.push({ pos: [2, 1, 2], block: 'minecraft:oak_leaves', state: { persistent: true } })
    blocks.push({ pos: [2, 2, 2], block: 'minecraft:glowstone' })
    blocks.push({ pos: [1, 1, 3], block: 'minecraft:water', state: { level: 0 } })
    return blocks
}

function buildGlassBlocks(){
    const blocks = []
    for(let y=0; y<4; y++){
        blocks.push({ pos: [0, y, 0], block: 'minecraft:glass' })
        blocks.push({ pos: [2, y, 0], block: 'minecraft:glass' })
        blocks.push({ pos: [0, y, 2], block: 'minecraft:glass' })
        blocks.push({ pos: [2, y, 2], block: 'minecraft:glass' })
    }
    blocks.push({ pos: [1, 0, 1], block: 'minecraft:sea_lantern' })
    blocks.push({ pos: [1, 1, 1], block: 'minecraft:water', state: { level: 0 } })
    return blocks
}

function buildSeedRows() {
    const now = Date.now()
    const data = [
        {
            name: 'Crimson Keep',
            creator: 'RedstoneRook',
            rating: 4.9,
            release: new Date(now - 7 * 86400000).toISOString(),
            tags: ['castle', 'defense'],
            downloads: 12450,
            version: '1.20.4',
            format: 'json',
            schematic: {
                name: 'Crimson Keep',
                category: 'defense',
                icon: 'minecraft:stone_bricks',
                blocks: buildVariedBlocks()
            }
        },
        {
            name: 'Sunken Library',
            creator: 'Tidebound',
            rating: 4.4,
            release: new Date(now - 140 * 86400000).toISOString(),
            tags: ['library', 'ocean'],
            downloads: 7850,
            version: '1.20.2',
            format: 'json',
            schematic: {
                name: 'Sunken Library',
                category: 'structure',
                icon: 'minecraft:stone_bricks',
                blocks: buildGlassBlocks()
            }
        },
        {
            name: 'Verdant Terrace',
            creator: 'Oakweaver',
            rating: 4.6,
            release: new Date(now - 28 * 86400000).toISOString(),
            tags: ['village', 'garden'],
            downloads: 9620,
            version: '1.20.4',
            format: 'json',
            schematic: {
                name: 'Verdant Terrace',
                category: 'village',
                icon: 'minecraft:stone_bricks',
                blocks: buildGardenBlocks()
            }
        },
        {
            name: 'Glassspire Tower',
            creator: 'SkylineFlux',
            rating: 4.5,
            release: new Date(now - 40 * 86400000).toISOString(),
            tags: ['tower', 'modern'],
            downloads: 9200,
            version: '1.20.4',
            format: 'json',
            schematic: {
                name: 'Glassspire Tower',
                category: 'tower',
                icon: 'minecraft:glass',
                blocks: buildGlassBlocks()
            }
        },
        {
            name: 'Hanging Gardens',
            creator: 'Ivyspire',
            rating: 4.8,
            release: new Date(now - 70 * 86400000).toISOString(),
            tags: ['gardens', 'organic'],
            downloads: 11400,
            version: '1.20.4',
            format: 'json',
            schematic: {
                name: 'Hanging Gardens',
                category: 'garden',
                icon: 'minecraft:oak_leaves',
                blocks: buildGardenBlocks()
            }
        }
    ]
    return data.map((entry) => ({
        ...entry,
        visibility: entry.visibility || 'public',
        status: entry.status || 'active',
        id: randomUUID()
    }))
}

async function ensureSchema(){
    if(schemaAvailable != null){
        return schemaAvailable
    }
    try {
        await db.query('select 1 from schematics limit 1')
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

async function findObjectKeyByHash(hash, format){
    const normalized = normalizeHash(hash)
    if(!normalized){
        return null
    }
    const normalizedFormat = normalizeFormat(format)
    await seedSchematics()
    if(!config.databaseUrl || schemaAvailable === false){
        const match = SCHEMATICS.find((entry) => entry.hash === normalized && normalizeFormat(entry.format) === normalizedFormat && entry.objectKey && entry.status !== 'deleted')
        return match?.objectKey || null
    }
    const hasSchema = await ensureSchema()
    if(!hasSchema){
        return null
    }
    const result = await db.query(
        `select object_key
         from schematics
         where hash = $1 and coalesce(format, 'json') = $2 and object_key is not null and status != 'deleted'
         order by created_at desc
         limit 1`,
        [normalized, normalizedFormat]
    )
    return result.rows[0]?.object_key || null
}

async function seedSchematics(){
    if(seeded){
        return
    }
    seeded = true

    if(!config.databaseUrl){
        if(SCHEMATICS.length === 0){
            SCHEMATICS.push(...buildSeedRows())
        }
        return
    }

    const hasSchema = await ensureSchema()
    if(!hasSchema){
        if(SCHEMATICS.length === 0){
            SCHEMATICS.push(...buildSeedRows())
        }
        return
    }

    const existing = await db.query('select count(*)::int as count from schematics')
    if(existing.rows[0].count > 0){
        return
    }

    const seeds = buildSeedRows()
    for(const entry of seeds){
        const objectKey = storage.buildObjectKey(entry.id, entry.format)
        await storage.writeSchematic(objectKey, entry.schematic)
        await db.query(
            `insert into schematics
            (id, owner_id, name, creator, rating, release_date, downloads, version, format, tags, description, size_text, accent, visibility, status, likes, views, hash, size_bytes, block_count, share_token, object_key)
            values
            ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
            [
                entry.id,
                entry.ownerId ?? null,
                entry.name,
                entry.creator,
                entry.rating,
                entry.release ? new Date(entry.release) : null,
                entry.downloads,
                entry.version,
                normalizeFormat(entry.format),
                entry.tags,
                entry.description || null,
                entry.size || null,
                entry.accent || null,
                entry.visibility || 'public',
                entry.status || 'active',
                entry.likes || 0,
                entry.views || 0,
                entry.hash || null,
                entry.sizeBytes || null,
                entry.blockCount || null,
                entry.shareToken || null,
                objectKey
            ]
        )
    }
}

function mapRow(row){
    return {
        id: row.id,
        ownerId: row.owner_id ?? null,
        name: row.name,
        creator: row.creator,
        rating: Number(row.rating) || 0,
        release: row.release_date ? new Date(row.release_date).toISOString() : null,
        tags: row.tags || [],
        downloads: row.downloads,
        version: row.version,
        format: row.format || 'json',
        description: row.description,
        size: row.size_text,
        accent: row.accent,
        visibility: row.visibility || 'public',
        status: row.status || 'active',
        likes: Number(row.likes) || 0,
        views: Number(row.views) || 0,
        hash: row.hash || null,
        sizeBytes: row.size_bytes ?? null,
        blockCount: row.block_count ?? null,
        shareToken: row.share_token || null,
        deletedAt: row.deleted_at || null,
        objectKey: row.object_key
    }
}

function pickThumbnail(thumbnails, label, preferredMime = 'image/webp'){
    if(!Array.isArray(thumbnails) || thumbnails.length === 0){
        return null
    }
    const normalizedLabel = label === 'small' ? 'tiny' : label
    const list = normalizedLabel
        ? thumbnails.filter(item => item.label === normalizedLabel)
        : thumbnails.slice()
    if(list.length === 0){
        return null
    }
    const preferred = preferredMime
        ? list.find(item => item.mime === preferredMime)
        : null
    if(preferred){
        return preferred
    }
    return list[0] || null
}

async function listSchematics({ query, sort, offset, limit, userId, isAdmin, creator, tags, ownerOnly }){
    await seedSchematics()
    if(!config.databaseUrl || schemaAvailable === false){
        let items = SCHEMATICS.slice()
        if(query){
            const q = query.toLowerCase()
            items = items.filter((entry) => {
                return entry.name.toLowerCase().includes(q) || entry.creator.toLowerCase().includes(q)
            })
        }
        if(creator){
            const c = creator.toLowerCase()
            items = items.filter((entry) => (entry.creator || '').toLowerCase().includes(c))
        }
        if(Array.isArray(tags) && tags.length > 0){
            const tagSet = new Set(tags.map(tag => tag.toLowerCase()))
            items = items.filter((entry) => (entry.tags || []).some(tag => tagSet.has(String(tag).toLowerCase())))
        }
        if(!isAdmin){
            items = items.filter(entry => (entry.status || 'active') === 'active')
            items = items.filter(entry => (entry.visibility || 'public') === 'public' || (userId && entry.ownerId && Number(entry.ownerId) === Number(userId)))
        }
        if(ownerOnly && userId){
            items = items.filter(entry => entry.ownerId && Number(entry.ownerId) === Number(userId))
        }
        if(sort === 'rating'){
            items.sort((a, b) => b.rating - a.rating)
        } else if(sort === 'release'){
            items.sort((a, b) => new Date(b.release).getTime() - new Date(a.release).getTime())
        }
        const total = items.length
        const start = Math.max(0, offset || 0)
        const end = limit ? start + limit : items.length
        items = items.slice(start, end)
        return { items, total }
    }

    const conditions = []
    const params = []
    if(query){
        params.push(`%${query.toLowerCase()}%`)
        params.push(`%${query.toLowerCase()}%`)
        conditions.push(`(lower(name) like $${params.length - 1} or lower(creator) like $${params.length})`)
    }
    if(creator){
        params.push(`%${creator.toLowerCase()}%`)
        conditions.push(`lower(creator) like $${params.length}`)
    }
    if(Array.isArray(tags) && tags.length > 0){
        params.push(tags)
        conditions.push(`tags && $${params.length}::text[]`)
    }
    if(!isAdmin){
        conditions.push(`status = 'active'`)
    }
    if(ownerOnly && userId){
        params.push(userId)
        conditions.push(`owner_id = $${params.length}`)
    }
    if(!isAdmin){
        if(userId){
            params.push(userId)
            conditions.push(`(visibility = 'public' or (visibility in ('unlisted','private') and owner_id = $${params.length}))`)
        } else {
            conditions.push(`visibility = 'public'`)
        }
    }
    const where = conditions.length > 0 ? `where ${conditions.join(' and ')}` : ''
    const order = sort === 'release' ? 'release_date desc nulls last' : 'rating desc'
    const offsetVal = Number.isFinite(Number(offset)) ? Number(offset) : 0
    const limitVal = Number.isFinite(Number(limit)) ? Number(limit) : 24
    params.push(limitVal)
    params.push(offsetVal)

    const result = await db.query(
        `select id, owner_id, name, creator, rating, release_date, downloads, version, format, tags, description, size_text, accent, visibility, status, likes, views, hash, size_bytes, block_count, share_token, deleted_at, object_key
         from schematics
         ${where}
         order by ${order}
         limit $${params.length - 1} offset $${params.length}`,
        params
    )
    const totalResult = await db.query(`select count(*)::int as count from schematics ${where}`, conditions.length ? params.slice(0, params.length - 2) : [])
    const rows = result.rows.map(mapRow)
    const thumbMap = await loadThumbnailsForIds(rows.map(row => row.id))
    const items = rows.map((row) => ({
        ...row,
        thumbnails: thumbMap.get(row.id) || [],
        thumbnail: pickThumbnail(thumbMap.get(row.id), 'tiny')
            || pickThumbnail(thumbMap.get(row.id), 'medium')
            || pickThumbnail(thumbMap.get(row.id), null)
            || null
    }))
    return {
        items,
        total: totalResult.rows[0].count
    }
}

async function getSchematic(id){
    await seedSchematics()
    if(!config.databaseUrl || schemaAvailable === false){
        return SCHEMATICS.find((item) => item.id === id) || null
    }
    const result = await db.query(
        `select id, owner_id, name, creator, rating, release_date, downloads, version, format, tags, description, size_text, accent, visibility, status, likes, views, hash, size_bytes, block_count, share_token, deleted_at, object_key
         from schematics
         where id = $1`,
        [id]
    )
    if(result.rows.length === 0){
        return null
    }
    const row = mapRow(result.rows[0])
    const schematic = await storage.readSchematic(row.objectKey)
    const thumbMap = await loadThumbnailsForIds([row.id])
    return {
        ...row,
        thumbnails: thumbMap.get(row.id) || [],
        thumbnail: pickThumbnail(thumbMap.get(row.id), 'medium') || null,
        schematic
    }
}

async function incrementDownloads(id){
    if(!config.databaseUrl || schemaAvailable === false){
        return
    }
    const hasSchema = await ensureSchema()
    if(!hasSchema){
        return
    }
    try {
        await db.query(`update schematics set downloads = downloads + 1 where id = $1`, [id])
    } catch (err) {
        if(err?.code !== '42P01'){
            throw err
        }
    }
}

async function hasLike(schematicId, userId){
    if(!schematicId || !userId){
        return false
    }
    if(!config.databaseUrl || schemaAvailable === false){
        return false
    }
    const hasSchema = await ensureSchema()
    if(!hasSchema){
        return false
    }
    const result = await db.query(
        `select 1 from schematics_likes where schematic_id = $1 and user_id = $2`,
        [schematicId, userId]
    )
    return result.rows.length > 0
}

async function loadLikedForIds(ids, userId){
    if(!userId || !Array.isArray(ids) || ids.length === 0){
        return new Set()
    }
    if(!config.databaseUrl || schemaAvailable === false){
        return new Set()
    }
    const hasSchema = await ensureSchema()
    if(!hasSchema){
        return new Set()
    }
    const result = await db.query(
        `select schematic_id
         from schematics_likes
         where user_id = $1 and schematic_id = any($2::uuid[])`,
        [userId, ids]
    )
    return new Set(result.rows.map(row => row.schematic_id))
}

async function addLike(schematicId, userId){
    if(!schematicId || !userId){
        return false
    }
    if(!config.databaseUrl || schemaAvailable === false){
        return false
    }
    const hasSchema = await ensureSchema()
    if(!hasSchema){
        return false
    }
    const result = await db.query(
        `insert into schematics_likes (schematic_id, user_id)
         values ($1,$2)
         on conflict do nothing`,
        [schematicId, userId]
    )
    if(result.rowCount > 0){
        await db.query(`update schematics set likes = likes + 1 where id = $1`, [schematicId])
        return true
    }
    return false
}

async function removeLike(schematicId, userId){
    if(!schematicId || !userId){
        return false
    }
    if(!config.databaseUrl || schemaAvailable === false){
        return false
    }
    const hasSchema = await ensureSchema()
    if(!hasSchema){
        return false
    }
    const result = await db.query(
        `delete from schematics_likes where schematic_id = $1 and user_id = $2`,
        [schematicId, userId]
    )
    if(result.rowCount > 0){
        await db.query(`update schematics set likes = greatest(likes - 1, 0) where id = $1`, [schematicId])
        return true
    }
    return false
}

const VIEW_THROTTLE_MS = 60 * 60 * 1000

async function recordView(schematicId, userId){
    if(!schematicId || !userId){
        return false
    }
    if(!config.databaseUrl || schemaAvailable === false){
        return false
    }
    const hasSchema = await ensureSchema()
    if(!hasSchema){
        return false
    }
    const now = new Date()
    const result = await db.query(
        `select last_viewed_at
         from schematics_views
         where schematic_id = $1 and user_id = $2`,
        [schematicId, userId]
    )
    if(result.rows.length === 0){
        await db.query(
            `insert into schematics_views (schematic_id, user_id, last_viewed_at)
             values ($1,$2,$3)`,
            [schematicId, userId, now]
        )
        await db.query(`update schematics set views = views + 1 where id = $1`, [schematicId])
        return true
    }
    const lastViewed = result.rows[0].last_viewed_at ? new Date(result.rows[0].last_viewed_at).getTime() : 0
    if(now.getTime() - lastViewed >= VIEW_THROTTLE_MS){
        await db.query(
            `update schematics_views set last_viewed_at = $1 where schematic_id = $2 and user_id = $3`,
            [now, schematicId, userId]
        )
        await db.query(`update schematics set views = views + 1 where id = $1`, [schematicId])
        return true
    }
    return false
}

async function getSchematicByShareToken(token){
    if(!config.databaseUrl || schemaAvailable === false){
        return null
    }
    const result = await db.query(
        `select id, owner_id, name, creator, rating, release_date, downloads, version, format, tags, description, size_text, accent, visibility, status, likes, views, hash, size_bytes, block_count, share_token, deleted_at, object_key
         from schematics
         where share_token = $1`,
        [token]
    )
    if(result.rows.length === 0){
        return null
    }
    const row = mapRow(result.rows[0])
    const schematic = await storage.readSchematic(row.objectKey)
    const thumbMap = await loadThumbnailsForIds([row.id])
    return {
        ...row,
        thumbnails: thumbMap.get(row.id) || [],
        thumbnail: pickThumbnail(thumbMap.get(row.id), 'medium') || null,
        schematic
    }
}

async function updateSchematic(id, patch, userId){
    if(!config.databaseUrl || schemaAvailable === false){
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
    if(patch.tags != null){
        setField('tags', patch.tags)
    }
    if(patch.visibility != null){
        setField('visibility', patch.visibility)
    }
    if(patch.version != null){
        setField('version', patch.version)
    }
    if(patch.accent != null){
        setField('accent', patch.accent)
    }
    if(patch.shareToken != null){
        setField('share_token', patch.shareToken)
    }
    if(patch.hash != null){
        setField('hash', patch.hash)
    }
    if(patch.sizeBytes != null){
        setField('size_bytes', patch.sizeBytes)
    }
    if(patch.blockCount != null){
        setField('block_count', patch.blockCount)
    }
    setField('updated_at', new Date())
    setField('updated_by', userId ?? null)
    if(fields.length === 0){
        return getSchematic(id)
    }
    params.push(id)
    const result = await db.query(
        `update schematics set ${fields.join(', ')} where id = $${params.length} returning id`,
        params
    )
    if(result.rows.length === 0){
        return null
    }
    return getSchematic(id)
}

async function setSchematicStatus(id, status, userId){
    if(!config.databaseUrl || schemaAvailable === false){
        return null
    }
    const params = [status, new Date(), userId ?? null, id]
    const result = await db.query(
        `update schematics set status = $1, updated_at = $2, updated_by = $3, deleted_at = case when $1 = 'deleted' then now() else deleted_at end
         where id = $4 returning id`,
        params
    )
    if(result.rows.length === 0){
        return null
    }
    return getSchematic(id)
}

async function addAuditEntry(schematicId, userId, action, detail){
    if(!config.databaseUrl || schemaAvailable === false){
        return
    }
    await db.query(
        `insert into schematics_audit (schematic_id, user_id, action, detail)
         values ($1,$2,$3,$4)`,
        [schematicId || null, userId || null, action, detail ? JSON.stringify(detail) : null]
    )
}

async function addReport(schematicId, userId, reason, detail){
    if(!config.databaseUrl || schemaAvailable === false){
        return
    }
    await db.query(
        `insert into schematics_reports (schematic_id, user_id, reason, detail)
         values ($1,$2,$3,$4)`,
        [schematicId, userId || null, reason || null, detail || null]
    )
}

async function upsertThumbnail(schematicId, thumb){
    if(!schematicId || !thumb){
        return null
    }
    const label = normalizeThumbnailLabel(thumb.label || 'medium')
    const mime = typeof thumb.mime === 'string' ? thumb.mime.toLowerCase() : 'image/png'
    let objectKey = thumb.objectKey || null
    let buffer = null
    if(!objectKey && thumb.data){
        buffer = decodeThumbnailData(thumb)
        if(buffer){
            objectKey = storage.buildThumbnailKey(schematicId, label, mime)
            await storage.writeThumbnail(objectKey, buffer)
        }
    }
    if(!objectKey){
        return null
    }
    if(!config.databaseUrl || schemaAvailable === false){
        return { label, mime, objectKey }
    }
    const hasSchema = await ensureSchema()
    if(!hasSchema){
        return { label, mime, objectKey }
    }
    const sizeBytes = Number.isFinite(Number(thumb.sizeBytes)) ? Number(thumb.sizeBytes) : (buffer ? buffer.length : null)
    await db.query(
        `insert into schematics_thumbnails
        (schematic_id, size_label, mime, object_key, width, height, size_bytes)
        values
        ($1,$2,$3,$4,$5,$6,$7)
        on conflict (schematic_id, size_label, mime) do update
        set mime = excluded.mime,
            object_key = excluded.object_key,
            width = excluded.width,
            height = excluded.height,
            size_bytes = excluded.size_bytes`,
        [
            schematicId,
            label,
            mime,
            objectKey,
            Number.isFinite(Number(thumb.width)) ? Number(thumb.width) : null,
            Number.isFinite(Number(thumb.height)) ? Number(thumb.height) : null,
            sizeBytes
        ]
    )
    return { label, mime, objectKey }
}
async function listTags({ limit = 50 } = {}){
    if(!config.databaseUrl || schemaAvailable === false){
        return []
    }
    const result = await db.query(
        `select tag, count(*)::int as count
         from (
           select unnest(tags) as tag
           from schematics
           where visibility = 'public' and status = 'active'
         ) t
         group by tag
         order by count desc, tag asc
         limit $1`,
        [limit]
    )
    return result.rows.map(row => ({ tag: row.tag, count: row.count }))
}
async function createSchematic(entry){
    const id = entry.id || randomUUID()
    const now = new Date()
    const normalizedHash = normalizeHash(entry.hash)
    const format = normalizeFormat(entry.format)
    let objectKey = entry.objectKey || null
    let reusedObjectKey = false
    if(!objectKey && normalizedHash){
        const existingKey = await findObjectKeyByHash(normalizedHash, format)
        if(existingKey){
            objectKey = existingKey
            reusedObjectKey = true
        } else {
            objectKey = storage.buildHashObjectKey(normalizedHash, format)
        }
    }
    if(!objectKey){
        objectKey = storage.buildObjectKey(id, format)
    }
    if(entry.schematic){
        if(!reusedObjectKey){
            await storage.writeSchematic(objectKey, entry.schematic)
        } else {
            const exists = await storage.objectExists(objectKey)
            if(!exists){
                await storage.writeSchematic(objectKey, entry.schematic)
            }
        }
    }
    const uploadedThumbnails = Array.isArray(entry.thumbnails) ? entry.thumbnails : []
    const storedThumbnails = []
    for(const thumb of uploadedThumbnails){
        if(thumb.objectKey){
            storedThumbnails.push({
                label: thumb.label,
                mime: thumb.mime,
                objectKey: thumb.objectKey,
                width: Number.isFinite(Number(thumb.width)) ? Number(thumb.width) : null,
                height: Number.isFinite(Number(thumb.height)) ? Number(thumb.height) : null,
                sizeBytes: Number.isFinite(Number(thumb.sizeBytes)) ? Number(thumb.sizeBytes) : null
            })
            continue
        }
        const buffer = decodeThumbnailData(thumb)
        if(!buffer){
            continue
        }
        const mime = typeof thumb.mime === 'string' ? thumb.mime : 'image/png'
        const label = typeof thumb.label === 'string' ? thumb.label : 'thumb'
        const objectKeyThumb = storage.buildThumbnailKey(id, label, mime)
        await storage.writeThumbnail(objectKeyThumb, buffer)
        storedThumbnails.push({
            label,
            mime,
            objectKey: objectKeyThumb,
            width: Number.isFinite(Number(thumb.width)) ? Number(thumb.width) : null,
            height: Number.isFinite(Number(thumb.height)) ? Number(thumb.height) : null,
            sizeBytes: buffer.length
        })
    }

    const payload = {
        id,
        ownerId: entry.ownerId ?? null,
        name: entry.name,
        creator: entry.creator || 'Unknown',
        rating: 0,
        release: now.toISOString(),
        tags: entry.tags || [],
        downloads: 0,
        version: entry.version || null,
        format,
        description: entry.description || null,
        size: entry.sizeText || null,
        accent: entry.accent || null,
        visibility: entry.visibility || 'public',
        status: entry.status || 'active',
        likes: 0,
        views: 0,
        hash: normalizedHash,
        sizeBytes: Number.isFinite(Number(entry.sizeBytes)) ? Number(entry.sizeBytes) : null,
        blockCount: Number.isFinite(Number(entry.blockCount)) ? Number(entry.blockCount) : null,
        shareToken: entry.shareToken || null,
        objectKey,
        thumbnails: normalizeThumbnails(storedThumbnails),
        schematic: entry.schematic
    }

    if(!config.databaseUrl || schemaAvailable === false){
        SCHEMATICS.unshift(payload)
        return payload
    }

    const hasSchema = await ensureSchema()
    if(!hasSchema){
        SCHEMATICS.unshift(payload)
        return payload
    }

    await db.query(
        `insert into schematics
        (id, owner_id, name, creator, rating, release_date, downloads, version, format, tags, description, size_text, accent, visibility, status, likes, views, hash, size_bytes, block_count, share_token, object_key)
        values
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
        [
            payload.id,
            payload.ownerId,
            payload.name,
            payload.creator,
            payload.rating,
            now,
            payload.downloads,
            payload.version,
            payload.format,
            payload.tags,
            payload.description,
            payload.size,
            payload.accent,
            payload.visibility || 'public',
            payload.status || 'active',
            payload.likes,
            payload.views,
            payload.hash,
            payload.sizeBytes,
            payload.blockCount,
            payload.shareToken,
            payload.objectKey
        ]
    )

    if(payload.thumbnails.length > 0){
        try {
            for(const thumb of payload.thumbnails){
                await db.query(
                    `insert into schematics_thumbnails
                    (schematic_id, size_label, mime, object_key, width, height, size_bytes)
                    values
                    ($1,$2,$3,$4,$5,$6,$7)
                    on conflict (schematic_id, size_label, mime) do update
                    set mime = excluded.mime,
                        object_key = excluded.object_key,
                        width = excluded.width,
                        height = excluded.height,
                        size_bytes = excluded.size_bytes`,
                    [
                        payload.id,
                        thumb.label,
                        thumb.mime,
                        thumb.objectKey,
                        thumb.width,
                        thumb.height,
                        thumb.sizeBytes
                    ]
                )
            }
        } catch (err) {
            if(err?.code !== '42P01'){
                throw err
            }
        }
    }

    return payload
}

module.exports = {
    listSchematics,
    getSchematic,
    getSchematicByShareToken,
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
    createSchematic,
    findObjectKeyByHash,
    mapRow,
    pickThumbnail,
    loadThumbnailsForIds
}
