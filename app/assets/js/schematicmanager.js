'use strict'

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const { writeJsonAtomic } = require('./atomicjson')

function loadCore(options = {}) {
    if(options.core) return options.core
    const candidates = [
        path.resolve(process.cwd(), 'libraries', 'schematics-core'),
        process.resourcesPath ? path.resolve(process.resourcesPath, 'libraries', 'schematics-core') : null,
        path.resolve(__dirname, '..', '..', '..', 'libraries', 'schematics-core')
    ].filter(Boolean)
    for(const candidate of candidates) {
        try { return require(candidate) } catch(error) {
            if(error?.code !== 'MODULE_NOT_FOUND') throw error
        }
    }
    throw new Error('The Cobble Power schematic format library is missing.')
}

function redactUrl(value) {
    return String(value || '').replace(/https?:\/\/[^\s"'<>]+/gi, match => {
        try {
            const parsed = new URL(match)
            return `${parsed.origin}${parsed.pathname}${parsed.search ? '?[redacted]' : ''}`
        } catch(_err) {
            return '[invalid URL]'
        }
    })
}

class SchematicApiError extends Error {
    constructor(message, options = {}) {
        super(redactUrl(message))
        this.name = 'SchematicApiError'
        this.code = options.code || 'schematic_api_error'
        this.status = options.status || null
        this.requestId = options.requestId || null
    }
}

class SchematicApiClient {
    constructor(options = {}) {
        this.baseUrl = String(options.baseUrl || '').replace(/\/+$/, '')
        this.fetch = options.fetch || global.fetch
        this.timeoutMs = Number(options.timeoutMs) || 10_000
        this.cachePath = options.cachePath || null
        if(!this.baseUrl || !this.fetch) throw new Error('SchematicApiClient requires baseUrl and fetch.')
    }

    async request(pathname, options = {}) {
        const method = String(options.method || 'GET').toUpperCase()
        const attempts = method === 'GET' ? 2 : 1
        let lastError
        for(let attempt = 0; attempt < attempts; attempt++) {
            const timeoutController = new AbortController()
            const timer = setTimeout(() => timeoutController.abort(), this.timeoutMs)
            const signal = options.signal
            const onAbort = () => timeoutController.abort()
            if(signal) signal.addEventListener('abort', onAbort, { once: true })
            try {
                const response = await this.fetch(`${this.baseUrl}${pathname}`, {
                    ...options,
                    method,
                    signal: timeoutController.signal
                })
                if(response.status === 304) return { response, data: null }
                if(!response.ok) {
                    const body = await response.json().catch(() => ({}))
                    throw new SchematicApiError(body.message || `Schematic service returned HTTP ${response.status}.`, {
                        code: body.error,
                        status: response.status,
                        requestId: response.headers.get('x-request-id')
                    })
                }
                const type = response.headers.get('content-type') || ''
                return { response, data: type.includes('application/json') ? await response.json() : await response.arrayBuffer() }
            } catch(error) {
                if(signal?.aborted) {
                    const aborted = new Error('Request aborted.')
                    aborted.name = 'AbortError'
                    throw aborted
                }
                lastError = error?.name === 'AbortError'
                    ? new SchematicApiError('Schematic service request timed out.', { code: 'timeout' })
                    : error
                if(signal?.aborted || attempt === attempts - 1 || error instanceof SchematicApiError) break
            } finally {
                clearTimeout(timer)
                if(signal) signal.removeEventListener('abort', onAbort)
            }
        }
        if(lastError instanceof SchematicApiError) throw lastError
        throw new SchematicApiError(lastError?.message || 'Schematic service is unavailable.', { code: 'network_error' })
    }

    readCatalogCache(cacheKey) {
        if(!this.cachePath || !fs.existsSync(this.cachePath)) return null
        try {
            const value = JSON.parse(fs.readFileSync(this.cachePath, 'utf8'))
            if(value?.schemaVersion !== 2 || !value.entries || typeof value.entries !== 'object') return null
            const entry = value.entries[cacheKey]
            return entry?.catalog?.schemaVersion === 2 ? entry : null
        } catch(_err) {
            return null
        }
    }

    writeCatalogCache(cacheKey, entry) {
        if(!this.cachePath) return
        let entries = {}
        try {
            const current = JSON.parse(fs.readFileSync(this.cachePath, 'utf8'))
            if(current?.schemaVersion === 2 && current.entries && typeof current.entries === 'object') entries = current.entries
        } catch(_err) {
            // A corrupt cache is safely replaced by the latest successful response.
        }
        entries[cacheKey] = entry
        writeJsonAtomic(this.cachePath, { schemaVersion: 2, entries })
    }

    async list(params, options = {}) {
        const query = new URLSearchParams(params || {})
        query.sort()
        const cacheKey = query.toString()
        const cached = this.readCatalogCache(cacheKey)
        const headers = { Accept: 'application/json', ...(options.headers || {}) }
        if(cached?.etag) headers['If-None-Match'] = cached.etag
        try {
            const suffix = cacheKey ? `?${cacheKey}` : ''
            const { response, data } = await this.request(`/v1/schematics${suffix}`, { headers, signal: options.signal })
            if(response.status === 304 && cached) return { ...cached.catalog, offline: false, cached: true }
            const record = {
                etag: response.headers.get('etag'),
                fetchedAt: new Date().toISOString(),
                catalog: data
            }
            this.writeCatalogCache(cacheKey, record)
            return { ...data, offline: false, cached: false }
        } catch(error) {
            if(cached) return { ...cached.catalog, offline: true, cached: true, cacheFetchedAt: cached.fetchedAt }
            throw error
        }
    }
}

function moduleContainsCobblePower(modules) {
    for(const module of modules || []) {
        const raw = module.rawModule || module
        const id = String(raw?.id || '')
        if(id === 'net.allegator.cobblepower:cobblepower' || id.startsWith('net.allegator.cobblepower:cobblepower:')) return true
        if(moduleContainsCobblePower(module.subModules || raw?.subModules)) return true
    }
    return false
}

function normalizeSegment(value, label) {
    const normalized = String(value || '').trim()
    if(!/^[A-Za-z0-9._-]{1,96}$/.test(normalized) || normalized === '.' || normalized === '..') throw new Error(`${label} contains unsafe path characters.`)
    return normalized
}

function hashFile(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

class SchematicInstallManager {
    constructor(options) {
        this.instanceDirectory = path.resolve(options.instanceDirectory)
        this.launcherDirectory = path.resolve(options.launcherDirectory)
        this.core = loadCore(options)
        this.indexPath = options.indexPath || path.join(this.launcherDirectory, 'schematics-cache', 'install-index-v2.json')
        this.index = this.loadIndex()
    }

    loadIndex() {
        try {
            const value = JSON.parse(fs.readFileSync(this.indexPath, 'utf8'))
            return value?.schemaVersion === 2 && Array.isArray(value.items) ? value.items : []
        } catch(_err) {
            return []
        }
    }

    saveIndex() {
        writeJsonAtomic(this.indexPath, { schemaVersion: 2, items: this.index })
    }

    key(profileId, playerUuid, schematicId) {
        return `${normalizeSegment(profileId, 'Profile id')}:${this.core.normalizeUuid(playerUuid)}:${this.core.validateCommunitySchematicId(schematicId)}`
    }

    directory(profileId, playerUuid) {
        const profile = normalizeSegment(profileId, 'Profile id')
        const player = this.core.normalizeUuid(playerUuid)
        const instanceRoot = path.resolve(this.instanceDirectory, profile)
        const target = path.resolve(instanceRoot, 'config', 'cobblepower', 'schematics', player)
        if(target !== instanceRoot && !target.startsWith(`${instanceRoot}${path.sep}`)) throw new Error('Resolved schematic directory escaped the selected instance.')
        return target
    }

    targetPath(profileId, playerUuid, schematicId) {
        const id = this.core.validateCommunitySchematicId(schematicId)
        return path.join(this.directory(profileId, playerUuid), `${id}.json`)
    }

    get(profileId, playerUuid, schematicId) {
        const key = this.key(profileId, playerUuid, schematicId)
        return this.index.find(item => item.key === key) || null
    }

    status(profileId, playerUuid, entry) {
        const installed = this.get(profileId, playerUuid, entry.id)
        if(!installed) return { state: 'install', installed: null }
        if(!fs.existsSync(installed.filePath)) return { state: 'repair', installed }
        if(entry.revision?.sha256 && entry.revision.sha256 !== installed.sourceSha256) return { state: 'update', installed }
        return { state: 'installed', installed }
    }

    assertUnmodified(record, confirmModified) {
        if(!record || !fs.existsSync(record.filePath)) return true
        const actual = hashFile(record.filePath)
        if(actual === record.installedFileSha256) return true
        if(typeof confirmModified === 'function' && confirmModified(record.filePath)) return true
        const error = new Error('The installed schematic was modified locally.')
        error.code = 'locally_modified'
        throw error
    }

    install({ profileId, playerUuid, entry, canonical, confirmModified }) {
        if(!entry?.id || !entry?.revision?.sha256) throw new Error('Schematic revision metadata is missing.')
        const parsed = this.core.parseCanonicalSchematic(canonical)
        if(parsed.sha256 !== entry.revision.sha256) {
            const error = new Error('Downloaded schematic failed its SHA-256 integrity check.')
            error.code = 'hash_mismatch'
            throw error
        }
        const existing = this.get(profileId, playerUuid, entry.id)
        this.assertUnmodified(existing, confirmModified)
        const installedCanonical = this.core.adaptCanonicalForPlayer(parsed.canonical, playerUuid, entry.id)
        const filePath = this.targetPath(profileId, playerUuid, entry.id)
        writeJsonAtomic(filePath, installedCanonical)
        const record = {
            key: this.key(profileId, playerUuid, entry.id),
            profileId,
            playerUuid: this.core.normalizeUuid(playerUuid),
            schematicId: entry.id,
            name: entry.name || installedCanonical.name,
            filePath,
            sourceRevisionId: entry.revision.id,
            sourceRevisionNumber: entry.revision.number,
            sourceSha256: entry.revision.sha256,
            installedFileSha256: hashFile(filePath),
            installedAt: new Date().toISOString()
        }
        this.index = this.index.filter(item => item.key !== record.key)
        this.index.push(record)
        this.saveIndex()
        return record
    }

    remove({ profileId, playerUuid, schematicId, confirmModified }) {
        const record = this.get(profileId, playerUuid, schematicId)
        if(!record) return false
        this.assertUnmodified(record, confirmModified)
        if(fs.existsSync(record.filePath)) fs.rmSync(record.filePath, { force: true })
        this.index = this.index.filter(item => item.key !== record.key)
        this.saveIndex()
        return true
    }
}

module.exports = {
    SchematicApiClient,
    SchematicApiError,
    SchematicInstallManager,
    hashFile,
    loadCore,
    moduleContainsCobblePower,
    redactUrl
}
