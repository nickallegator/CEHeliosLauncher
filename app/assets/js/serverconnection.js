const net = require('net')

const HOSTNAME_PATTERN = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/

function parseServerAddress(value, defaultPort = 25565) {
    const text = String(value || '').trim()
    if(!text || /[\s\x00-\x1f\x7f/@\\]/.test(text) || text.includes('://')) throw new Error('Enter a valid server address.')
    let host
    let port = defaultPort
    if(text.startsWith('[')) {
        const end = text.indexOf(']')
        if(end < 2) throw new Error('Enter IPv6 addresses inside brackets.')
        host = text.slice(1, end)
        const remainder = text.slice(end + 1)
        if(remainder) {
            if(!remainder.startsWith(':')) throw new Error('Enter a valid server address.')
            port = Number(remainder.slice(1))
        }
        if(net.isIP(host) !== 6) throw new Error('Enter a valid IPv6 address.')
    } else {
        const separator = text.lastIndexOf(':')
        if(separator >= 0) {
            if(text.indexOf(':') !== separator) throw new Error('Enter IPv6 addresses inside brackets.')
            host = text.slice(0, separator)
            port = Number(text.slice(separator + 1))
        } else host = text
        if(!net.isIP(host) && !HOSTNAME_PATTERN.test(host)) throw new Error('Enter a valid hostname or IP address.')
    }
    if(!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('The server port must be between 1 and 65535.')
    const normalizedHost = host.toLowerCase()
    return {
        host: normalizedHost,
        port,
        address: net.isIP(normalizedHost) === 6 ? `[${normalizedHost}]:${port}` : `${normalizedHost}:${port}`
    }
}

function getConnectionContract(server) {
    const value = server?.rawServer?.connection
    if(value?.schemaVersion !== 1 || value.enabled !== true) return null
    try {
        const endpoint = parseServerAddress(value.publicAddress || server.rawServer.address)
        return {
            ...value,
            publicAddress: endpoint.address,
            host: endpoint.host,
            port: endpoint.port,
            statusRefreshSeconds: Math.min(300, Math.max(15, Number(value.statusRefreshSeconds) || 30))
        }
    } catch(_err) {
        return null
    }
}

function getEffectiveConnection(server, override) {
    const contract = getConnectionContract(server)
    if(!contract) return null
    if(contract.localOverridesAllowed && String(override || '').trim()) {
        return { ...parseServerAddress(override), overridden: true }
    }
    return { host: contract.host, port: contract.port, address: contract.publicAddress, overridden: false }
}

function directConnectArguments(minecraftVersion, endpoint) {
    if(!endpoint) return []
    const parts = String(minecraftVersion || '').split('.').map(value => Number.parseInt(value, 10))
    const modern = parts[0] > 1 || (parts[0] === 1 && (parts[1] || 0) >= 20)
    return modern
        ? ['--quickPlayMultiplayer', endpoint.address]
        : ['--server', endpoint.host, '--port', String(endpoint.port)]
}

module.exports = {
    directConnectArguments,
    getConnectionContract,
    getEffectiveConnection,
    parseServerAddress
}
