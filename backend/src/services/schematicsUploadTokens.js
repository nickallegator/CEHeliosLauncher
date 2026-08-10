const config = require('../config')
const db = require('../db')

let schemaAvailable = null
const TOKENS = new Map()

async function ensureSchema(){
    if(schemaAvailable != null){
        return schemaAvailable
    }
    try {
        await db.query('select 1 from schematics_upload_tokens limit 1')
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

function mapRow(row){
    let thumbnails = row.thumbnails
    if(typeof thumbnails === 'string'){
        try {
            thumbnails = JSON.parse(thumbnails)
        } catch (err) {
            thumbnails = []
        }
    }
    return {
        token: row.token,
        userId: row.user_id ?? null,
        sizeBytes: row.size_bytes ?? null,
        hash: row.hash || null,
        format: row.format || null,
        schematicId: row.schematic_id || null,
        schematicKey: row.schematic_key || null,
        thumbnails: Array.isArray(thumbnails) ? thumbnails : [],
        requiresUpload: row.requires_upload !== false,
        expiresAt: row.expires_at ? new Date(row.expires_at).getTime() : 0
    }
}

async function cleanupExpired(){
    if(!config.databaseUrl){
        const now = Date.now()
        for(const [token, entry] of TOKENS.entries()){
            if(entry.expiresAt <= now){
                TOKENS.delete(token)
            }
        }
        return
    }
    const hasSchema = await ensureSchema()
    if(!hasSchema){
        const now = Date.now()
        for(const [token, entry] of TOKENS.entries()){
            if(entry.expiresAt <= now){
                TOKENS.delete(token)
            }
        }
        return
    }
    await db.query('delete from schematics_upload_tokens where expires_at <= now()')
}

async function createToken(entry){
    const payload = {
        token: entry.token,
        userId: entry.userId ?? null,
        sizeBytes: Number.isFinite(Number(entry.sizeBytes)) ? Number(entry.sizeBytes) : null,
        hash: entry.hash || null,
        format: entry.format || null,
        schematicId: entry.schematicId || null,
        schematicKey: entry.schematicKey || null,
        thumbnails: Array.isArray(entry.thumbnails) ? entry.thumbnails : [],
        requiresUpload: entry.requiresUpload !== false,
        expiresAt: Number.isFinite(Number(entry.expiresAt)) ? Number(entry.expiresAt) : Date.now() + 5 * 60 * 1000
    }

    if(!config.databaseUrl){
        TOKENS.set(payload.token, payload)
        return payload
    }
    const hasSchema = await ensureSchema()
    if(!hasSchema){
        TOKENS.set(payload.token, payload)
        return payload
    }

    await db.query(
        `insert into schematics_upload_tokens
         (token, user_id, size_bytes, hash, format, schematic_id, schematic_key, thumbnails, requires_upload, expires_at)
         values
         ($1,$2,$3,$4,$5,$6,$7,$8,$9,to_timestamp($10 / 1000.0))`,
        [
            payload.token,
            payload.userId,
            payload.sizeBytes,
            payload.hash,
            payload.format,
            payload.schematicId,
            payload.schematicKey,
            JSON.stringify(payload.thumbnails || []),
            payload.requiresUpload,
            payload.expiresAt
        ]
    )
    return payload
}

async function getToken(token){
    if(!token){
        return null
    }
    if(!config.databaseUrl){
        return TOKENS.get(token) || null
    }
    const hasSchema = await ensureSchema()
    if(!hasSchema){
        return TOKENS.get(token) || null
    }
    const result = await db.query(
        `select token, user_id, size_bytes, hash, format, schematic_id, schematic_key, thumbnails, requires_upload, expires_at
         from schematics_upload_tokens
         where token = $1`,
        [token]
    )
    if(result.rows.length === 0){
        return null
    }
    return mapRow(result.rows[0])
}

async function deleteToken(token){
    if(!token){
        return
    }
    TOKENS.delete(token)
    if(!config.databaseUrl){
        return
    }
    const hasSchema = await ensureSchema()
    if(!hasSchema){
        return
    }
    await db.query('delete from schematics_upload_tokens where token = $1', [token])
}

module.exports = {
    cleanupExpired,
    createToken,
    getToken,
    deleteToken
}
