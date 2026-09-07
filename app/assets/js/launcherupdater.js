'use strict'

const semver = require('semver')

const UPDATE_SCHEMA_VERSION = 1
const RELEASE_NOTES_LIMIT = 20_000
const RELEASE_NOTES_SOURCE_LIMIT = RELEASE_NOTES_LIMIT * 4
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

const UpdateStatus = Object.freeze({
    DISABLED: 'disabled',
    IDLE: 'idle',
    CHECKING: 'checking',
    AVAILABLE: 'available',
    DOWNLOADING: 'downloading',
    READY: 'ready',
    ERROR: 'error'
})

function text(value, limit = RELEASE_NOTES_LIMIT) {
    return String(value == null ? '' : value)
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
        .slice(0, limit)
}

function decodeHtmlEntities(value) {
    const named = {
        amp: '&',
        apos: '\'',
        gt: '>',
        lt: '<',
        nbsp: ' ',
        quot: '"'
    }
    return value.replace(/&(?:#(\d+)|#x([a-f0-9]+)|([a-z]+));/gi, (match, decimal, hexadecimal, name) => {
        if(name) return named[name.toLowerCase()] ?? match
        const point = Number.parseInt(decimal || hexadecimal, hexadecimal ? 16 : 10)
        if(!Number.isInteger(point) || point < 0 || point > 0x10FFFF || (point >= 0xD800 && point <= 0xDFFF)) return '\uFFFD'
        return String.fromCodePoint(point)
    })
}

function htmlToPlainText(value) {
    return decodeHtmlEntities(String(value == null ? '' : value).slice(0, RELEASE_NOTES_SOURCE_LIMIT))
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<(script|style|iframe|object|embed|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
        .replace(/<li\b[^>]*>/gi, '\n\u2022 ')
        .replace(/<\/li\s*>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(?:p|div|h[1-6]|ul|ol|pre|blockquote|section|article|table|tr|td|th)\s*>/gi, '\n')
        .replace(/<(?:p|div|h[1-6]|ul|ol|pre|blockquote|section|article|table|tr)\b[^>]*>/gi, '\n')
        .replace(/<[^>]*>/g, '')
        .replace(/\r\n?/g, '\n')
        .replace(/[\t\f\v ]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
}

function normalizeReleaseNotes(value, limit = RELEASE_NOTES_LIMIT) {
    const combined = Array.isArray(value)
        ? value.map(entry => entry?.note || entry?.version || '').filter(Boolean).join('\n\n')
        : value
    return text(htmlToPlainText(combined), limit)
}

function updateSize(info) {
    const files = Array.isArray(info?.files) ? info.files : []
    const sizes = files.map(file => Number(file?.size)).filter(Number.isFinite)
    return sizes.length ? Math.max(...sizes) : null
}

function publicUpdateInfo(info) {
    if(!info || !semver.valid(info.version)) return null
    return {
        version: info.version,
        releaseName: normalizeReleaseNotes(info.releaseName || `AG Launcher ${info.version}`, 300),
        releaseNotes: normalizeReleaseNotes(info.releaseNotes),
        sizeBytes: updateSize(info),
        releaseDate: Number.isNaN(Date.parse(info.releaseDate)) ? null : new Date(info.releaseDate).toISOString()
    }
}

function allowedVersion(version, channel, allowPrerelease = false) {
    if(!semver.valid(version)) return false
    const prerelease = semver.prerelease(version)
    if(channel === 'test') return Array.isArray(prerelease) && String(prerelease[0]).toLowerCase() === 'test'
    return prerelease == null || (allowPrerelease && String(prerelease?.[0]).toLowerCase() === 'test')
}

function errorCode(error) {
    const code = String(error?.code || '').toUpperCase()
    if(code.includes('CHECKSUM') || code.includes('SHA') || code.includes('SIGNATURE')) return 'integrity_failed'
    if(code.includes('HTTP') || code.includes('NETWORK') || code.includes('TIMEOUT') || code.includes('CONNECTION')) return 'network_unavailable'
    if(code.includes('CANCEL')) return 'cancelled'
    return 'update_failed'
}

class LauncherUpdateManager {
    constructor(options) {
        this.updater = options.updater
        this.currentVersion = options.currentVersion
        this.channel = options.channel === 'test' ? 'test' : 'stable'
        this.allowPrerelease = this.channel === 'test' || options.allowPrerelease === true
        this.enabled = options.enabled === true
        this.broadcast = typeof options.broadcast === 'function' ? options.broadcast : () => {}
        this.setInterval = options.setInterval || setInterval
        this.clearInterval = options.clearInterval || clearInterval
        this.now = options.now || (() => Date.now())
        this.checkIntervalMs = options.checkIntervalMs || CHECK_INTERVAL_MS
        this.initialized = false
        this.checkPromise = null
        this.downloadPromise = null
        this.timer = null
        this.gameRunning = false
        this.availableInfo = null
        this.dismissedVersion = null
        this.state = {
            schemaVersion: UPDATE_SCHEMA_VERSION,
            status: this.enabled ? UpdateStatus.IDLE : UpdateStatus.DISABLED,
            channel: this.channel,
            allowPrerelease: this.allowPrerelease,
            currentVersion: this.currentVersion,
            available: null,
            progress: null,
            lastCheckedAt: null,
            errorCode: null,
            gameRunning: false,
            dismissed: false
        }
    }

    snapshot() {
        return JSON.parse(JSON.stringify(this.state))
    }

    emit(patch = {}) {
        this.state = { ...this.state, ...patch, schemaVersion: UPDATE_SCHEMA_VERSION }
        this.broadcast(this.snapshot())
        return this.snapshot()
    }

    initialize() {
        if(this.initialized || !this.enabled) return this.snapshot()
        this.initialized = true
        this.updater.autoDownload = false
        this.updater.autoInstallOnAppQuit = false
        this.updater.allowPrerelease = this.allowPrerelease
        this.updater.allowDowngrade = false

        this.updater.on('checking-for-update', () => this.emit({ status: UpdateStatus.CHECKING, errorCode: null }))
        this.updater.on('update-available', info => {
            const normalized = publicUpdateInfo(info)
            if(!normalized || !allowedVersion(normalized.version, this.channel, this.allowPrerelease) || !semver.gt(normalized.version, this.currentVersion)) {
                this.availableInfo = null
                this.emit({ status: UpdateStatus.IDLE, available: null, progress: null, lastCheckedAt: new Date(this.now()).toISOString() })
                return
            }
            this.availableInfo = normalized
            this.emit({
                status: UpdateStatus.AVAILABLE,
                available: normalized,
                progress: null,
                lastCheckedAt: new Date(this.now()).toISOString(),
                dismissed: this.dismissedVersion === normalized.version
            })
        })
        this.updater.on('update-not-available', () => {
            this.availableInfo = null
            this.emit({ status: UpdateStatus.IDLE, available: null, progress: null, lastCheckedAt: new Date(this.now()).toISOString(), errorCode: null })
        })
        this.updater.on('download-progress', progress => {
            const total = Number(progress?.total)
            const transferred = Number(progress?.transferred)
            const percent = Number(progress?.percent)
            this.emit({
                status: UpdateStatus.DOWNLOADING,
                progress: {
                    transferredBytes: Number.isFinite(transferred) ? Math.max(0, transferred) : 0,
                    totalBytes: Number.isFinite(total) ? Math.max(0, total) : null,
                    percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null
                },
                errorCode: null
            })
        })
        this.updater.on('update-downloaded', info => {
            const normalized = publicUpdateInfo(info) || this.availableInfo
            this.availableInfo = normalized
            this.emit({ status: UpdateStatus.READY, available: normalized, progress: { transferredBytes: normalized?.sizeBytes || 0, totalBytes: normalized?.sizeBytes, percent: 100 }, errorCode: null })
        })
        this.updater.on('error', error => this.emit({ status: UpdateStatus.ERROR, errorCode: errorCode(error), progress: null }))

        this.timer = this.setInterval(() => {
            this.check().catch(() => {})
        }, this.checkIntervalMs)
        if(typeof this.timer?.unref === 'function') this.timer.unref()
        return this.snapshot()
    }

    setAllowPrerelease(value) {
        this.allowPrerelease = this.channel === 'test' || value === true
        if(this.initialized) this.updater.allowPrerelease = this.allowPrerelease
        return this.emit({ allowPrerelease: this.allowPrerelease })
    }

    async check(options = {}) {
        if(!this.enabled) return this.snapshot()
        this.initialize()
        if(Object.hasOwn(options, 'allowPrerelease')) this.setAllowPrerelease(options.allowPrerelease)
        if(this.checkPromise || this.state.status === UpdateStatus.DOWNLOADING || this.state.status === UpdateStatus.READY) return this.snapshot()
        this.checkPromise = Promise.resolve(this.updater.checkForUpdates())
            .catch(error => {
                this.emit({ status: UpdateStatus.ERROR, errorCode: errorCode(error), progress: null })
            })
            .finally(() => { this.checkPromise = null })
        await this.checkPromise
        return this.snapshot()
    }

    async download() {
        if(!this.enabled || !this.availableInfo) throw Object.assign(new Error('No launcher update is available.'), { code: 'update_unavailable' })
        if(this.downloadPromise || this.state.status === UpdateStatus.READY) return this.snapshot()
        this.emit({ status: UpdateStatus.DOWNLOADING, progress: { transferredBytes: 0, totalBytes: this.availableInfo.sizeBytes, percent: 0 }, dismissed: false, errorCode: null })
        this.downloadPromise = Promise.resolve(this.updater.downloadUpdate())
            .catch(error => {
                this.emit({ status: UpdateStatus.ERROR, errorCode: errorCode(error), progress: null })
            })
            .finally(() => { this.downloadPromise = null })
        await this.downloadPromise
        return this.snapshot()
    }

    defer() {
        if(this.availableInfo) this.dismissedVersion = this.availableInfo.version
        return this.emit({ dismissed: true })
    }

    setGameRunning(value) {
        this.gameRunning = value === true
        return this.emit({ gameRunning: this.gameRunning })
    }

    install() {
        if(!this.enabled || this.state.status !== UpdateStatus.READY) throw Object.assign(new Error('The launcher update is not ready.'), { code: 'update_not_ready' })
        if(this.gameRunning) throw Object.assign(new Error('Close Minecraft before installing the launcher update.'), { code: 'game_running' })
        this.updater.quitAndInstall(true, true)
        return this.snapshot()
    }

    dispose() {
        if(this.timer != null) this.clearInterval(this.timer)
        this.timer = null
    }
}

module.exports = {
    CHECK_INTERVAL_MS,
    LauncherUpdateManager,
    RELEASE_NOTES_LIMIT,
    UPDATE_SCHEMA_VERSION,
    UpdateStatus,
    allowedVersion,
    errorCode,
    normalizeReleaseNotes,
    publicUpdateInfo
}
