'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const test = require('node:test')

const {
    LauncherUpdateManager,
    UpdateStatus,
    allowedVersion,
    errorCode,
    publicUpdateInfo
} = require('../../app/assets/js/launcherupdater')

class FakeUpdater extends EventEmitter {
    constructor() {
        super()
        this.checks = 0
        this.downloads = 0
        this.installs = 0
    }
    async checkForUpdates() { this.checks++ }
    async downloadUpdate() { this.downloads++ }
    quitAndInstall(silent, relaunch) { this.installs++; this.installArguments = [silent, relaunch] }
}

function fixture(options = {}) {
    const updater = new FakeUpdater()
    const states = []
    const manager = new LauncherUpdateManager({
        updater,
        currentVersion: '2.8.0-test.1',
        channel: 'test',
        enabled: true,
        broadcast: state => states.push(state),
        setInterval: () => ({ unref() {} }),
        clearInterval() {},
        now: () => Date.parse('2026-09-07T00:00:00.000Z'),
        ...options
    })
    manager.initialize()
    return { manager, states, updater }
}

test('test and stable channels reject cross-channel versions', () => {
    assert.equal(allowedVersion('2.8.0-test.2', 'test'), true)
    assert.equal(allowedVersion('2.8.0-beta.1', 'test'), false)
    assert.equal(allowedVersion('2.8.0', 'test'), false)
    assert.equal(allowedVersion('2.8.0', 'stable'), true)
    assert.equal(allowedVersion('2.8.0-test.2', 'stable'), false)
    assert.equal(allowedVersion('2.8.0-test.2', 'stable', true), true)
})

test('launcher request channel follows launcher SemVer instead of the mod-pack channel', () => {
    const { getLauncherChannel } = require('../../app/assets/js/launcheridentity')
    assert.equal(getLauncherChannel('2.8.0-test.1'), 'test')
    assert.equal(getLauncherChannel('2.8.0'), 'stable')
    assert.equal(getLauncherChannel('2.8.0-beta.1'), 'stable')
})

test('release metadata is bounded and contains no provider URLs', () => {
    const info = publicUpdateInfo({
        version: '2.8.0-test.2',
        releaseName: 'A'.repeat(500),
        releaseNotes: '<script>alert(1)</script>',
        files: [{ url: 'https://secret.invalid/query?token=secret', size: 1000 }],
        releaseDate: '2026-09-07T00:00:00Z'
    })
    assert.equal(info.releaseName.length, 300)
    assert.equal(info.releaseNotes, '<script>alert(1)</script>')
    assert.equal(info.sizeBytes, 1000)
    assert.equal(JSON.stringify(info).includes('secret.invalid'), false)
})

test('manager checks once, exposes an update, and defers it for the session', async () => {
    const { manager, updater } = fixture()
    await manager.check()
    assert.equal(updater.checks, 1)
    updater.emit('update-available', { version: '2.8.0-test.2', releaseName: 'Update', releaseNotes: 'Notes', files: [{ size: 42 }] })
    assert.equal(manager.snapshot().status, UpdateStatus.AVAILABLE)
    assert.equal(manager.snapshot().available.version, '2.8.0-test.2')
    manager.defer()
    assert.equal(manager.snapshot().dismissed, true)
})

test('stable prerelease opt-in is explicit and updates the provider setting', async () => {
    const { manager, updater } = fixture({ channel: 'stable', currentVersion: '2.8.0' })
    assert.equal(manager.snapshot().allowPrerelease, false)
    await manager.check({ allowPrerelease: true })
    assert.equal(manager.snapshot().allowPrerelease, true)
    assert.equal(updater.allowPrerelease, true)
    updater.emit('update-available', { version: '2.8.1-test.1' })
    assert.equal(manager.snapshot().status, UpdateStatus.AVAILABLE)
})

test('manager ignores older, stable, and foreign prerelease candidates', () => {
    const { manager, updater } = fixture()
    for(const version of ['2.7.0-test.9', '2.8.0', '2.8.0-beta.2']) {
        updater.emit('update-available', { version })
        assert.equal(manager.snapshot().status, UpdateStatus.IDLE)
        assert.equal(manager.snapshot().available, null)
    }
})

test('download progress becomes ready and installation waits for Minecraft', async () => {
    const { manager, updater } = fixture()
    const info = { version: '2.8.0-test.2', releaseName: 'Update', files: [{ size: 100 }] }
    updater.emit('update-available', info)
    await manager.download()
    assert.equal(updater.downloads, 1)
    updater.emit('download-progress', { transferred: 40, total: 100, percent: 40 })
    assert.equal(manager.snapshot().progress.percent, 40)
    updater.emit('update-downloaded', info)
    manager.setGameRunning(true)
    assert.throws(() => manager.install(), error => error.code === 'game_running')
    manager.setGameRunning(false)
    manager.install()
    assert.equal(updater.installs, 1)
    assert.deepEqual(updater.installArguments, [true, true])
})

test('disabled builds never initialize or contact the update service', async () => {
    const updater = new FakeUpdater()
    const manager = new LauncherUpdateManager({ updater, currentVersion: '2.8.0-test.1', channel: 'test', enabled: false })
    await manager.check()
    assert.equal(manager.snapshot().status, UpdateStatus.DISABLED)
    assert.equal(updater.checks, 0)
    assert.equal(updater.listenerCount('error'), 0)
})

test('errors are reduced to stable codes without leaking messages', () => {
    assert.equal(errorCode({ code: 'ERR_CHECKSUM_MISMATCH', message: 'token=secret' }), 'integrity_failed')
    assert.equal(errorCode({ code: 'ERR_HTTP_503', message: 'https://secret.invalid/?token=secret' }), 'network_unavailable')
    assert.equal(errorCode({ message: 'C:\\Users\\Nick\\private' }), 'update_failed')
})
