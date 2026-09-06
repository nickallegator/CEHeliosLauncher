const assert = require('node:assert/strict')
const test = require('node:test')

const {
    createGameServerRegistry,
    isServerStatusAuthorized,
    parseGameServerRegistry,
    parseServerAddress
} = require('../../backend/src/services/gameServerRegistry')
const {
    createMinecraftStatusMonitor,
    encodeVarInt,
    isPublicIp,
    parseStatusPacket,
    resolvePublicAddresses
} = require('../../backend/src/services/minecraftStatus')
const { injectGameServerServices } = require('../../backend/src/routes/releases')

function statusPacket(value) {
    const json = Buffer.from(JSON.stringify(value))
    const payload = Buffer.concat([Buffer.from([0]), encodeVarInt(json.length), json])
    return Buffer.concat([encodeVarInt(payload.length), payload])
}

test('server addresses normalize hostnames, IPv4, and bracketed IPv6', () => {
    assert.deepEqual(parseServerAddress('Play.AllegatorGames.com'), {
        host: 'play.allegatorgames.com', port: 25565, address: 'play.allegatorgames.com:25565'
    })
    assert.equal(parseServerAddress('192.168.1.81:25566').port, 25566)
    assert.equal(parseServerAddress('[2001:db8::1]:25565').address, '[2001:db8::1]:25565')
    for(const invalid of ['https://example.com', 'user@example.com', '../host', 'host:0', '2001:db8::1']) {
        assert.throws(() => parseServerAddress(invalid))
    }
})

test('server registry rejects duplicate and incomplete profiles', () => {
    const entry = { profileId: 'Cobble-Power-1.21.1', address: 'play.allegatorgames.com:25565', requiredEntitlement: 'cobblepower:test' }
    assert.equal(createGameServerRegistry([entry]).get(entry.profileId).port, 25565)
    assert.throws(() => parseGameServerRegistry([entry, entry]), /Duplicate/)
    assert.throws(() => parseGameServerRegistry([{ ...entry, requiredEntitlement: '' }]), /entitlement/)
})

test('server status authorization requires both an active tester and the profile entitlement', () => {
    const entry = { requiredEntitlement: 'cobblepower:test' }
    assert.equal(isServerStatusAuthorized(entry, ['cobblepower:test'], true), true)
    assert.equal(isServerStatusAuthorized(entry, ['cobblepower:test'], false), false)
    assert.equal(isServerStatusAuthorized(entry, ['other'], true), false)
})

test('status parser returns aggregate data and rejects invalid counts', () => {
    const parsed = parseStatusPacket(statusPacket({ version: { name: '1.21.1' }, players: { online: 2, max: 20, sample: [{ name: 'private' }] } }))
    assert.deepEqual(parsed, { players: { online: 2, maximum: 20 }, version: '1.21.1' })
    assert.throws(() => parseStatusPacket(statusPacket({ players: { online: -1, max: 20 } })), /player counts/)
})

test('status target resolution rejects private and link-local addresses', async () => {
    assert.equal(isPublicIp('8.8.8.8'), true)
    for(const address of [
        '127.0.0.1', '10.0.0.1', '192.168.1.81', '169.254.1.1',
        '192.0.2.10', '198.51.100.20', '203.0.113.30',
        '::1', 'fd00::1', '2001:db8::1', '::ffff:127.0.0.1'
    ]) {
        assert.equal(isPublicIp(address), false)
    }
    assert.equal(isPublicIp('2606:4700:4700::1111'), true)
    await assert.rejects(() => resolvePublicAddresses('example.test', async () => [{ address: '127.0.0.1', family: 4 }]), /non-public/)
})

test('status monitor coalesces requests and applies success and failure cache windows', async () => {
    let now = 1000
    let calls = 0
    let reject = false
    const monitor = createMinecraftStatusMonitor({
        now: () => now,
        cacheMs: 15000,
        failureCacheMs: 5000,
        query: async () => {
            calls++
            if(reject) throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })
            await new Promise(resolve => setImmediate(resolve))
            return { players: { online: 3, maximum: 20 }, version: '1.21.1', latencyMs: 12 }
        }
    })
    const entry = { profileId: 'Cobble-Power-1.21.1' }
    const [first, second] = await Promise.all([monitor.get(entry), monitor.get(entry)])
    assert.equal(calls, 1)
    assert.equal(first.state, 'online')
    assert.deepEqual(first, second)
    await monitor.get(entry)
    assert.equal(calls, 1)
    now += 15001
    reject = true
    const offline = await monitor.get(entry)
    assert.equal(offline.state, 'offline')
    assert.equal(calls, 2)
})

test('authorized distribution injection updates only registered profiles', () => {
    const distribution = { servers: [{ id: 'Cobble-Power-1.21.1', address: 'localhost:25565' }, { id: 'other', address: 'other.example:25565' }] }
    injectGameServerServices(distribution, {
        statusEnabled: true,
        publicApiUrl: 'https://access.example/',
        entries: [{
            profileId: 'Cobble-Power-1.21.1',
            address: 'play.allegatorgames.com:25565',
            requiredEntitlement: 'cobblepower:test'
        }]
    })
    assert.equal(distribution.servers[0].address, 'play.allegatorgames.com:25565')
    assert.equal(distribution.servers[0].connection.statusUrl, 'https://access.example/v1/game-servers/Cobble-Power-1.21.1/status')
    assert.equal(distribution.servers[1].address, 'other.example:25565')
    assert.equal(distribution.servers[1].connection, undefined)
})
