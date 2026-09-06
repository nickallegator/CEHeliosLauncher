const net = require('net')

const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const HOSTNAME_PATTERN = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/

function parseServerAddress(value, defaultPort = 25565) {
    const text = String(value || '').trim()
    if(!text || /[\s\x00-\x1f\x7f/@\\]/.test(text) || text.includes('://')) {
        throw new Error('Game server address is invalid')
    }

    let host
    let port = defaultPort
    if(text.startsWith('[')) {
        const end = text.indexOf(']')
        if(end < 2) throw new Error('Game server IPv6 address is invalid')
        host = text.slice(1, end)
        const remainder = text.slice(end + 1)
        if(remainder) {
            if(!remainder.startsWith(':')) throw new Error('Game server address is invalid')
            port = Number(remainder.slice(1))
        }
        if(net.isIP(host) !== 6) throw new Error('Game server IPv6 address is invalid')
    } else {
        const separator = text.lastIndexOf(':')
        if(separator > -1) {
            if(text.indexOf(':') !== separator) throw new Error('IPv6 addresses must be enclosed in brackets')
            host = text.slice(0, separator)
            port = Number(text.slice(separator + 1))
        } else {
            host = text
        }
        if(!net.isIP(host) && !HOSTNAME_PATTERN.test(host)) throw new Error('Game server hostname is invalid')
    }

    if(!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Game server port is invalid')
    return {
        host: host.toLowerCase(),
        port,
        address: net.isIP(host) === 6 ? `[${host.toLowerCase()}]:${port}` : `${host.toLowerCase()}:${port}`
    }
}

function parseGameServerRegistry(value) {
    let entries = value
    if(typeof entries === 'string') {
        try {
            entries = JSON.parse(entries)
        } catch(_err) {
            throw new Error('GAME_SERVERS_JSON must be valid JSON')
        }
    }
    if(!Array.isArray(entries)) throw new Error('GAME_SERVERS_JSON must be an array')

    const seen = new Set()
    return entries.map((entry) => {
        const profileId = String(entry?.profileId || '').trim()
        if(!PROFILE_ID_PATTERN.test(profileId)) throw new Error('Game server profileId is invalid')
        if(seen.has(profileId)) throw new Error(`Duplicate game server profileId: ${profileId}`)
        seen.add(profileId)
        const endpoint = parseServerAddress(entry.address)
        const requiredEntitlement = String(entry.requiredEntitlement || '').trim().toLowerCase()
        if(!requiredEntitlement) throw new Error(`Game server ${profileId} requires an entitlement`)
        return Object.freeze({
            profileId,
            ...endpoint,
            requiredEntitlement,
            statusEnabled: entry.statusEnabled !== false,
            directConnectEnabled: entry.directConnectEnabled !== false,
            localOverridesAllowed: entry.localOverridesAllowed !== false
        })
    })
}

function createGameServerRegistry(entries) {
    const parsed = parseGameServerRegistry(entries)
    const byProfile = new Map(parsed.map(entry => [entry.profileId, entry]))
    return Object.freeze({
        entries: parsed,
        get(profileId) {
            return byProfile.get(String(profileId || '')) || null
        }
    })
}

function isServerStatusAuthorized(entry, entitlements, activeTester) {
    return Boolean(activeTester) && Array.isArray(entitlements) && entitlements.some(
        value => String(value || '').trim().toLowerCase() === entry?.requiredEntitlement
    )
}

module.exports = {
    createGameServerRegistry,
    isServerStatusAuthorized,
    parseGameServerRegistry,
    parseServerAddress
}
