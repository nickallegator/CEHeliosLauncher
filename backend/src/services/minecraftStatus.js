const dns = require('dns').promises
const net = require('net')

const MAX_STATUS_BYTES = 64 * 1024

function encodeVarInt(input) {
    let value = input >>> 0
    const bytes = []
    do {
        let current = value & 0x7f
        value >>>= 7
        if(value !== 0) current |= 0x80
        bytes.push(current)
    } while(value !== 0)
    return Buffer.from(bytes)
}

function decodeVarInt(buffer, offset = 0) {
    let value = 0
    let position = 0
    let cursor = offset
    while(cursor < buffer.length) {
        const current = buffer[cursor++]
        value |= (current & 0x7f) << position
        if((current & 0x80) === 0) return { value, bytes: cursor - offset }
        position += 7
        if(position >= 35) throw new Error('Minecraft status VarInt is too large')
    }
    return null
}

function packet(payload) {
    return Buffer.concat([encodeVarInt(payload.length), payload])
}

function stringField(value) {
    const data = Buffer.from(value, 'utf8')
    return Buffer.concat([encodeVarInt(data.length), data])
}

function createHandshake(host, port) {
    const portBuffer = Buffer.allocUnsafe(2)
    portBuffer.writeUInt16BE(port)
    return packet(Buffer.concat([
        encodeVarInt(0),
        encodeVarInt(767),
        stringField(host),
        portBuffer,
        encodeVarInt(1)
    ]))
}

function parseStatusPacket(buffer) {
    const packetLength = decodeVarInt(buffer)
    if(!packetLength || packetLength.value > MAX_STATUS_BYTES) return null
    if(buffer.length < packetLength.bytes + packetLength.value) return null
    let cursor = packetLength.bytes
    const packetId = decodeVarInt(buffer, cursor)
    if(!packetId) return null
    cursor += packetId.bytes
    if(packetId.value !== 0) throw new Error('Minecraft status response used an unexpected packet ID')
    const jsonLength = decodeVarInt(buffer, cursor)
    if(!jsonLength) return null
    cursor += jsonLength.bytes
    if(jsonLength.value < 2 || jsonLength.value > MAX_STATUS_BYTES || cursor + jsonLength.value > buffer.length) return null
    const status = JSON.parse(buffer.subarray(cursor, cursor + jsonLength.value).toString('utf8'))
    const online = Number(status?.players?.online)
    const maximum = Number(status?.players?.max)
    if(!Number.isInteger(online) || online < 0 || !Number.isInteger(maximum) || maximum < 0) {
        throw new Error('Minecraft status response has invalid player counts')
    }
    return {
        players: { online, maximum },
        version: String(status?.version?.name || '').slice(0, 80) || null
    }
}

function isPublicIp(address) {
    if(net.isIP(address) === 4) {
        const [a, b, c] = address.split('.').map(Number)
        return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
            (a === 100 && b >= 64 && b <= 127) ||
            (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 0 && (c === 0 || c === 2)) ||
            (a === 192 && b === 168) ||
            (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
            (a === 203 && b === 0 && c === 113))
    }
    if(net.isIP(address) === 6) {
        const normalized = address.toLowerCase()
        const mapped = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/)
        if(normalized.startsWith('::ffff:')) return mapped ? isPublicIp(mapped[1]) : false
        return normalized !== '::' && normalized !== '::1' &&
            !normalized.startsWith('fe8') && !normalized.startsWith('fe9') &&
            !normalized.startsWith('fea') && !normalized.startsWith('feb') &&
            !normalized.startsWith('fc') && !normalized.startsWith('fd') &&
            !normalized.startsWith('ff') && !normalized.startsWith('2001:db8:')
    }
    return false
}

async function resolvePublicAddresses(host, lookup = dns.lookup) {
    const directFamily = net.isIP(host)
    const results = directFamily ? [{ address: host, family: directFamily }] : await lookup(host, { all: true, verbatim: true })
    if(!Array.isArray(results) || results.length === 0) throw new Error('Game server hostname did not resolve')
    const unique = [...new Map(results.map(item => [item.address, item])).values()].slice(0, 4)
    if(unique.some(item => !isPublicIp(item.address))) throw new Error('Game server hostname resolved to a non-public address')
    return unique
}

async function queryAddress(endpoint, resolved, options = {}) {
    const timeoutMs = Number(options.timeoutMs) || 2500
    return await new Promise((resolve, reject) => {
        const startedAt = Date.now()
        let settled = false
        let received = Buffer.alloc(0)
        const socket = (options.connect || net.createConnection)({ host: resolved.address, port: endpoint.port, family: resolved.family })
        const finish = (err, result) => {
            if(settled) return
            settled = true
            socket.destroy()
            if(err) reject(err)
            else resolve({ ...result, latencyMs: Date.now() - startedAt })
        }
        socket.setTimeout(timeoutMs, () => {
            const error = new Error('Minecraft status query timed out')
            error.code = 'ETIMEDOUT'
            finish(error)
        })
        socket.once('error', finish)
        socket.once('connect', () => {
            socket.write(createHandshake(endpoint.host, endpoint.port))
            socket.write(Buffer.from([0x01, 0x00]))
        })
        socket.on('data', chunk => {
            received = Buffer.concat([received, chunk])
            if(received.length > MAX_STATUS_BYTES + 8) return finish(new Error('Minecraft status response exceeded the size limit'))
            try {
                const result = parseStatusPacket(received)
                if(result) finish(null, result)
            } catch(err) {
                finish(err)
            }
        })
        socket.once('end', () => {
            if(!settled) finish(new Error('Minecraft status connection closed before a complete response'))
        })
    })
}

async function queryMinecraftStatus(endpoint, options = {}) {
    const addresses = await resolvePublicAddresses(endpoint.host, options.lookup)
    let lastError
    for(const resolved of addresses) {
        try {
            return await queryAddress(endpoint, resolved, options)
        } catch(err) {
            lastError = err
        }
    }
    throw lastError || new Error('Minecraft status query failed')
}

function createMinecraftStatusMonitor(options = {}) {
    const query = options.query || queryMinecraftStatus
    const now = options.now || Date.now
    const cacheMs = Math.max(1000, Number(options.cacheMs) || 15000)
    const failureCacheMs = Math.max(1000, Number(options.failureCacheMs) || 5000)
    const cache = new Map()
    const inFlight = new Map()

    async function get(entry) {
        const cached = cache.get(entry.profileId)
        if(cached && cached.expiresAt > now()) return cached.value
        if(inFlight.has(entry.profileId)) return inFlight.get(entry.profileId)
        const pending = (async () => {
            const checkedAt = new Date(now()).toISOString()
            try {
                const result = await query(entry, { timeoutMs: options.timeoutMs })
                const value = { state: 'online', ...result, checkedAt, stale: false }
                cache.set(entry.profileId, { value, expiresAt: now() + cacheMs })
                return value
            } catch(err) {
                const state = err?.code === 'ECONNREFUSED' ? 'offline' : 'unknown'
                const value = { state, players: { online: 0, maximum: 0 }, version: null, latencyMs: null, checkedAt, stale: false }
                cache.set(entry.profileId, { value, expiresAt: now() + failureCacheMs })
                return value
            } finally {
                inFlight.delete(entry.profileId)
            }
        })()
        inFlight.set(entry.profileId, pending)
        return pending
    }

    return { get }
}

module.exports = {
    MAX_STATUS_BYTES,
    createHandshake,
    createMinecraftStatusMonitor,
    decodeVarInt,
    encodeVarInt,
    isPublicIp,
    parseStatusPacket,
    queryMinecraftStatus,
    resolvePublicAddresses
}
