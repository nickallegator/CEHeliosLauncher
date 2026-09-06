const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const {
    directConnectArguments,
    getConnectionContract,
    getEffectiveConnection,
    parseServerAddress
} = require('../../app/assets/js/serverconnection')
const { ServerStatusManager } = require('../../app/assets/js/serverstatusmanager')

function server(connection = {}) {
    return {
        rawServer: {
            id: 'Cobble-Power-1.21.1',
            address: 'play.allegatorgames.com:25565',
            minecraftVersion: '1.21.1',
            connection: {
                schemaVersion: 1,
                enabled: true,
                publicAddress: 'play.allegatorgames.com:25565',
                localOverridesAllowed: true,
                ...connection
            }
        }
    }
}

test('connection contracts normalize public and local endpoints', () => {
    const contract = getConnectionContract(server())
    assert.equal(contract.publicAddress, 'play.allegatorgames.com:25565')
    assert.deepEqual(getEffectiveConnection(server(), '192.168.1.81:25565'), {
        host: '192.168.1.81', port: 25565, address: '192.168.1.81:25565', overridden: true
    })
    assert.equal(getEffectiveConnection(server(), '').overridden, false)
    assert.equal(getConnectionContract(server({ schemaVersion: 2 })), null)
})

test('address parsing rejects URLs, paths, credentials, whitespace, and invalid ports', () => {
    assert.equal(parseServerAddress('[2001:db8::1]:25565').host, '2001:db8::1')
    for(const value of ['https://example.com', '../server', 'name@example.com', 'bad host:25565', 'host:65536', 'host:0', '2001:db8::1']) {
        assert.throws(() => parseServerAddress(value))
    }
})

test('direct connection arguments use Quick Play for modern Minecraft and legacy flags otherwise', () => {
    const endpoint = parseServerAddress('play.allegatorgames.com:25565')
    assert.deepEqual(directConnectArguments('1.21.1', endpoint), ['--quickPlayMultiplayer', 'play.allegatorgames.com:25565'])
    assert.deepEqual(directConnectArguments('1.19.4', endpoint), ['--server', 'play.allegatorgames.com', '--port', '25565'])
})

test('ProcessBuilder direct intent is one-time and normal intent preserves Auto Connect behavior', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../app/assets/js/processbuilder.js'), 'utf8')
    const method = source.match(/_processAutoConnectArg\(args\)\{([\s\S]*?)\n {4}\}/)?.[1] || ''
    assert.match(method, /this\.launchOptions\.intent === 'direct'/)
    assert.match(method, /directConnectArguments\(this\.server\.rawServer\.minecraftVersion, endpoint\)/)
    assert.match(method, /return[\r\n]+\s*\}[\r\n]+\s*if\(ConfigManager\.getAutoConnect\(\)/)
    assert.match(method, /this\.server\.rawServer\.autoconnect/)
})

test('status manager cancels superseded requests and backs off without losing last success', async () => {
    const updates = []
    const timers = []
    let resolveFetch
    const manager = new ServerStatusManager({
        fetchStatus: (_server, signal) => new Promise((resolve, reject) => {
            resolveFetch = resolve
            signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })))
        }),
        onUpdate: value => updates.push(value),
        setTimer: (fn, delay) => { timers.push({ fn, delay }); return timers.length },
        clearTimer: () => {}
    })
    manager.select({ id: 'one', refreshSeconds: 30 })
    manager.setActive(true)
    assert.equal(updates.at(-1).state, 'checking')
    resolveFetch({ state: 'online', players: { online: 1, maximum: 20 }, checkedAt: new Date().toISOString() })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(updates.at(-1).state, 'online')
    assert.equal(timers.at(-1).delay, 30000)
    manager.select({ id: 'two', refreshSeconds: 30 })
    manager.setActive(false)
    manager.destroy()
})
