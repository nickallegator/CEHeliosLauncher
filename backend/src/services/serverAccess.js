'use strict'

const crypto = require('crypto')

const SERVER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const MINECRAFT_NAME_PATTERN = /^[A-Za-z0-9_]{1,16}$/

function parseCredentials(value) {
    const credentials = new Map()
    for(const entry of String(value || '').split(',').map(item => item.trim()).filter(Boolean)) {
        const separator = entry.indexOf('=')
        if(separator <= 0) throw new Error('SERVER_ACCESS_SYNC_CREDENTIALS entries must use server-id=sha256')
        const serverId = entry.slice(0, separator).trim().toLowerCase()
        const digest = entry.slice(separator + 1).trim().toLowerCase()
        if(!SERVER_ID_PATTERN.test(serverId)) throw new Error(`Invalid server access ID: ${serverId}`)
        if(!SHA256_PATTERN.test(digest)) throw new Error(`Invalid server access credential hash for ${serverId}`)
        if(credentials.has(serverId)) throw new Error(`Duplicate server access ID: ${serverId}`)
        credentials.set(serverId, digest)
    }
    return credentials
}

function authenticateCredential(serverId, token, credentials) {
    const normalizedId = String(serverId || '').trim().toLowerCase()
    const suppliedToken = String(token || '')
    if(!SERVER_ID_PATTERN.test(normalizedId) || suppliedToken.length < 32 || suppliedToken.length > 512) return false
    const expectedHex = credentials.get(normalizedId)
    if(!expectedHex) return false
    const actual = crypto.createHash('sha256').update(suppliedToken, 'utf8').digest()
    const expected = Buffer.from(expectedHex, 'hex')
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual)
}

function hyphenateUuid(value) {
    const normalized = String(value || '').trim().toLowerCase().replace(/-/g, '')
    if(!/^[a-f0-9]{32}$/.test(normalized)) throw new Error('Invalid Minecraft UUID in server access list')
    return `${normalized.slice(0, 8)}-${normalized.slice(8, 12)}-${normalized.slice(12, 16)}-${normalized.slice(16, 20)}-${normalized.slice(20)}`
}

function buildWhitelistPayload(rows, now = new Date()) {
    const players = []
    const uuids = new Set()
    const names = new Set()
    let pendingProfileCount = 0

    for(const row of rows || []) {
        const uuid = hyphenateUuid(row.minecraftUuid ?? row.minecraft_uuid)
        const name = String(row.displayName ?? row.display_name ?? '').trim()
        if(uuids.has(uuid)) throw new Error(`Duplicate Minecraft UUID in server access list: ${uuid}`)
        uuids.add(uuid)
        if(!MINECRAFT_NAME_PATTERN.test(name)) {
            pendingProfileCount++
            continue
        }
        const normalizedName = name.toLowerCase()
        if(names.has(normalizedName)) throw new Error(`Duplicate Minecraft name in server access list: ${name}`)
        names.add(normalizedName)
        players.push({ uuid, name })
    }

    players.sort((left, right) => left.uuid.localeCompare(right.uuid))
    const revisionInput = JSON.stringify({ activeCount: uuids.size, pendingProfileCount, players })
    const revision = crypto.createHash('sha256').update(revisionInput, 'utf8').digest('hex')
    return {
        schemaVersion: 1,
        authoritative: true,
        source: 'minecraft_testers',
        revision,
        generatedAt: now.toISOString(),
        activeCount: uuids.size,
        resolvedCount: players.length,
        pendingProfileCount,
        players
    }
}

module.exports = {
    SERVER_ID_PATTERN,
    MINECRAFT_NAME_PATTERN,
    parseCredentials,
    authenticateCredential,
    hyphenateUuid,
    buildWhitelistPayload
}
