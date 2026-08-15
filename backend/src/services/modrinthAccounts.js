'use strict'

const config = require('../config')
const db = require('../db')
const { createExternalTokenEncryption } = require('./externalTokenEncryption')

function encryption() {
    return createExternalTokenEncryption(config.modrinth.tokenEncryptionKey, config.modrinth.tokenEncryptionKeyId)
}

async function getAccount(userId, { includeToken = false } = {}) {
    const { rows } = await db.query(
        `select user_id,provider_user_id,username,display_name,avatar_url,scopes,token_expires_at,
                token_ciphertext,token_iv,token_tag,token_key_id,connected_at,updated_at
         from external_accounts where user_id=$1 and provider='modrinth'`, [userId])
    const row = rows[0]
    if(!row) return null
    const expired = row.token_expires_at != null && new Date(row.token_expires_at).getTime() <= Date.now()
    return {
        userId: row.user_id,
        providerUserId: row.provider_user_id,
        username: row.username,
        displayName: row.display_name,
        avatarUrl: row.avatar_url,
        scopes: row.scopes || [],
        expiresAt: row.token_expires_at,
        connectedAt: row.connected_at,
        reconnectRequired: expired,
        ...(includeToken && !expired ? { token: encryption().decrypt(row) } : {})
    }
}

async function saveAccount(userId, identity, tokenResponse) {
    const encrypted = encryption().encrypt(tokenResponse.access_token)
    const scopes = String(tokenResponse.scope || config.modrinth.scopes.join(' ')).split(/[ ,]+/).filter(Boolean)
    if(['USER_READ','PROJECT_READ'].some(scope => !scopes.includes(scope))) {
        throw Object.assign(new Error('Modrinth did not grant the required read permissions.'), { code: 'modrinth_scope_required', statusCode: 403 })
    }
    const expiresAt = tokenResponse.expires_in ? new Date(Date.now() + Number(tokenResponse.expires_in) * 1000) : null
    await db.query(
        `insert into external_accounts
         (user_id,provider,provider_user_id,username,display_name,avatar_url,token_ciphertext,token_iv,token_tag,token_key_id,scopes,token_expires_at)
         values ($1,'modrinth',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         on conflict (user_id,provider) do update set
           provider_user_id=excluded.provider_user_id,username=excluded.username,display_name=excluded.display_name,
           avatar_url=excluded.avatar_url,token_ciphertext=excluded.token_ciphertext,token_iv=excluded.token_iv,
           token_tag=excluded.token_tag,token_key_id=excluded.token_key_id,scopes=excluded.scopes,
           token_expires_at=excluded.token_expires_at,updated_at=now()`,
        [userId, identity.id, identity.username || null, identity.name || identity.username || null, identity.avatar_url || null,
            encrypted.ciphertext, encrypted.iv, encrypted.tag, encrypted.keyId, scopes, expiresAt])
    return getAccount(userId)
}

async function disconnect(userId) {
    await db.query('delete from external_accounts where user_id=$1 and provider=\'modrinth\'', [userId])
    await db.query('update community_external_sources set status=\'disabled\',updated_at=now() where owner_id=$1 and provider=\'modrinth\'', [userId])
}

module.exports = { disconnect, getAccount, saveAccount }
