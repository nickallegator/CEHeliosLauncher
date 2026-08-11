const db = require('../db')

async function upsertUser(provider, providerUserId, displayName = null, avatarUrl = null) {
    const { rows } = await db.query(
        `insert into users (provider, provider_user_id, display_name, avatar_url)
         values ($1, $2, $3, $4)
         on conflict (provider, provider_user_id) do update
         set provider_user_id = excluded.provider_user_id,
             display_name = coalesce(excluded.display_name, users.display_name),
             avatar_url = coalesce(excluded.avatar_url, users.avatar_url)
         returning id`,
        [provider, providerUserId, displayName, avatarUrl]
    )
    return rows[0].id
}

async function savePatreonTokens(userId, tokenResponse) {
    const expiresAt = tokenResponse.expires_in
        ? new Date(Date.now() + (Number(tokenResponse.expires_in) * 1000))
        : null
    await db.query(
        `insert into patreon_tokens (user_id, access_token, refresh_token, scope, token_type, expires_at)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (user_id) do update
         set access_token = excluded.access_token,
             refresh_token = excluded.refresh_token,
             scope = excluded.scope,
             token_type = excluded.token_type,
             expires_at = excluded.expires_at,
             updated_at = now()`,
        [
            userId,
            tokenResponse.access_token,
            tokenResponse.refresh_token || null,
            tokenResponse.scope || null,
            tokenResponse.token_type || null,
            expiresAt
        ]
    )
}

async function replaceEntitlements(userId, entitlements, source) {
    await db.query('delete from entitlements where user_id = $1 and source = $2', [userId, source])
    if(entitlements.length === 0) {
        return
    }
    const values = []
    const params = []
    let i = 1
    for(const entitlement of entitlements) {
        values.push(`($${i++}, $${i++}, $${i++})`)
        params.push(userId, entitlement, source)
    }
    await db.query(
        `insert into entitlements (user_id, entitlement, source)
         values ${values.join(', ')}`,
        params
    )
}

async function getEntitlements(userId) {
    const { rows } = await db.query(
        'select entitlement from entitlements where user_id = $1',
        [userId]
    )
    return rows.map(row => row.entitlement)
}

async function getUser(userId) {
    const { rows } = await db.query(
        'select id, display_name, avatar_url from users where id = $1',
        [userId]
    )
    return rows[0] || null
}

async function getMinecraftIdentity(userId) {
    const { rows } = await db.query(
        `select id, provider_user_id, display_name, avatar_url
         from users where id = $1 and provider = 'minecraft'`,
        [userId]
    )
    if(rows.length === 0) return null
    return {
        userId: rows[0].id,
        uuid: normalizeMinecraftUuid(rows[0].provider_user_id),
        displayName: rows[0].display_name || null,
        avatarUrl: rows[0].avatar_url || null
    }
}

function normalizeMinecraftUuid(value) {
    const normalized = String(value || '').trim().toLowerCase().replace(/-/g, '')
    if(!/^[a-f0-9]{32}$/.test(normalized)) {
        throw new Error('Minecraft UUID must contain 32 hexadecimal characters')
    }
    return normalized
}

async function isMinecraftTester(uuid) {
    const normalized = normalizeMinecraftUuid(uuid)
    const { rows } = await db.query(
        'select enabled from minecraft_testers where minecraft_uuid = $1',
        [normalized]
    )
    return rows.length > 0 && rows[0].enabled === true
}

async function isUserActiveMinecraftTester(userId) {
    const { rows } = await db.query(
        `select mt.enabled
         from users u
         join minecraft_testers mt on mt.minecraft_uuid = replace(lower(u.provider_user_id), '-', '')
         where u.id = $1 and u.provider = 'minecraft'`,
        [userId]
    )
    return rows.length > 0 && rows[0].enabled === true
}

async function upsertMinecraftTester(uuid, label = null) {
    const normalized = normalizeMinecraftUuid(uuid)
    const { rows } = await db.query(
        `insert into minecraft_testers (minecraft_uuid, label, enabled)
         values ($1, $2, true)
         on conflict (minecraft_uuid) do update
         set label = coalesce(excluded.label, minecraft_testers.label),
             enabled = true,
             updated_at = now()
         returning minecraft_uuid, label, enabled, created_at, updated_at`,
        [normalized, label || null]
    )
    return rows[0]
}

async function disableMinecraftTester(uuid) {
    const normalized = normalizeMinecraftUuid(uuid)
    const { rows } = await db.query(
        `update minecraft_testers set enabled = false, updated_at = now()
         where minecraft_uuid = $1
         returning minecraft_uuid, label, enabled, created_at, updated_at`,
        [normalized]
    )
    return rows[0] || null
}

async function listMinecraftTesters() {
    const { rows } = await db.query(
        `select minecraft_uuid, label, enabled, created_at, updated_at
         from minecraft_testers order by enabled desc, label nulls last, minecraft_uuid`
    )
    return rows
}

function normalizeEntitlement(value) {
    const normalized = String(value || '').trim().toLowerCase()
    if(!/^[a-z0-9][a-z0-9:_-]{1,127}$/.test(normalized)) {
        throw new Error('Entitlement must use lowercase letters, numbers, colon, underscore, or hyphen')
    }
    return normalized
}

async function getMinecraftEntitlementGrants(uuid) {
    const normalized = normalizeMinecraftUuid(uuid)
    const { rows } = await db.query(
        `select entitlement from minecraft_entitlement_grants
         where minecraft_uuid = $1 and enabled = true
         order by entitlement`,
        [normalized]
    )
    return rows.map(row => row.entitlement)
}

async function grantMinecraftEntitlement(uuid, entitlement, label = null) {
    const normalizedUuid = normalizeMinecraftUuid(uuid)
    const normalizedEntitlement = normalizeEntitlement(entitlement)
    const { rows } = await db.query(
        `insert into minecraft_entitlement_grants(minecraft_uuid, entitlement, label, enabled)
         values ($1, $2, $3, true)
         on conflict (minecraft_uuid, entitlement) do update
         set label = coalesce(excluded.label, minecraft_entitlement_grants.label),
             enabled = true,
             updated_at = now()
         returning minecraft_uuid, entitlement, label, enabled, created_at, updated_at`,
        [normalizedUuid, normalizedEntitlement, label || null]
    )
    return rows[0]
}

async function revokeMinecraftEntitlement(uuid, entitlement) {
    const normalizedUuid = normalizeMinecraftUuid(uuid)
    const normalizedEntitlement = normalizeEntitlement(entitlement)
    const { rows } = await db.query(
        `update minecraft_entitlement_grants set enabled = false, updated_at = now()
         where minecraft_uuid = $1 and entitlement = $2
         returning minecraft_uuid, entitlement, label, enabled, created_at, updated_at`,
        [normalizedUuid, normalizedEntitlement]
    )
    return rows[0] || null
}

async function listMinecraftEntitlementGrants(entitlement = null) {
    const normalized = entitlement ? normalizeEntitlement(entitlement) : null
    const { rows } = await db.query(
        `select minecraft_uuid, entitlement, label, enabled, created_at, updated_at
         from minecraft_entitlement_grants
         where ($1::text is null or entitlement = $1)
         order by entitlement, enabled desc, label nulls last, minecraft_uuid`,
        [normalized]
    )
    return rows
}

async function createOAuthState(state, redirectUrl, expiresAt) {
    await db.query(
        'insert into oauth_states (state, redirect_url, expires_at) values ($1, $2, $3)',
        [state, redirectUrl, expiresAt]
    )
}

async function consumeOAuthState(state) {
    const { rows } = await db.query(
        'delete from oauth_states where state = $1 returning redirect_url, expires_at',
        [state]
    )
    if(rows.length === 0) {
        return null
    }
    const record = rows[0]
    if(new Date(record.expires_at).getTime() < Date.now()) {
        return null
    }
    return { redirectUrl: record.redirect_url }
}

module.exports = {
    upsertUser,
    savePatreonTokens,
    replaceEntitlements,
    getEntitlements,
    getUser,
    getMinecraftIdentity,
    normalizeMinecraftUuid,
    isMinecraftTester,
    isUserActiveMinecraftTester,
    upsertMinecraftTester,
    disableMinecraftTester,
    listMinecraftTesters,
    normalizeEntitlement,
    getMinecraftEntitlementGrants,
    grantMinecraftEntitlement,
    revokeMinecraftEntitlement,
    listMinecraftEntitlementGrants,
    createOAuthState,
    consumeOAuthState
}
