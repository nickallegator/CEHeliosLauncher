'use strict'

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const { writeJsonAtomic } = require('./atomicjson')

const CACHE_SCHEMA_VERSION = 1
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024
const SHA256 = /^[a-f0-9]{64}$/

function hashBuffer(value) {
    return crypto.createHash('sha256').update(value).digest('hex')
}

class CommunityArtifactCache {
    constructor(options = {}) {
        if(!options.directory) throw new TypeError('Community artifact cache requires a directory.')
        this.directory = path.resolve(options.directory)
        this.objectsDirectory = path.join(this.directory, 'objects')
        this.indexPath = path.join(this.directory, 'index.json')
        this.maxBytes = Math.max(16 * 1024 * 1024, Number(options.maxBytes) || DEFAULT_MAX_BYTES)
    }

    readIndex() {
        try {
            const value = JSON.parse(fs.readFileSync(this.indexPath, 'utf8'))
            if(value?.schemaVersion === CACHE_SCHEMA_VERSION && value.entries && typeof value.entries === 'object') return value
        } catch(_error) {
            // A missing or corrupt index is reconstructed lazily.
        }
        return { schemaVersion: CACHE_SCHEMA_VERSION, entries: {} }
    }

    objectPath(sha256) {
        const normalized = String(sha256 || '').toLowerCase()
        if(!SHA256.test(normalized)) throw new Error('Community artifact has an invalid SHA-256.')
        return path.join(this.objectsDirectory, normalized.slice(0, 2), normalized)
    }

    get(sha256, expectedSize = null) {
        const normalized = String(sha256 || '').toLowerCase()
        const filePath = this.objectPath(normalized)
        if(!fs.existsSync(filePath)) return null
        const stat = fs.statSync(filePath)
        if(expectedSize != null && stat.size !== Number(expectedSize)) {
            fs.rmSync(filePath, { force: true })
            return null
        }
        const bytes = fs.readFileSync(filePath)
        if(hashBuffer(bytes) !== normalized) {
            fs.rmSync(filePath, { force: true })
            return null
        }
        const index = this.readIndex()
        index.entries[normalized] = { sizeBytes: bytes.length, lastAccessedAt: Date.now() }
        fs.mkdirSync(this.directory, { recursive: true })
        writeJsonAtomic(this.indexPath, index)
        return bytes
    }

    put(sha256, bytes, metadata = {}) {
        const normalized = String(sha256 || '').toLowerCase()
        const value = Buffer.from(bytes)
        if(hashBuffer(value) !== normalized) {
            const error = new Error('Community artifact checksum did not match its revision.')
            error.code = 'community_checksum_mismatch'
            throw error
        }
        if(metadata.sizeBytes != null && value.length !== Number(metadata.sizeBytes)) {
            const error = new Error('Community artifact size did not match its revision.')
            error.code = 'community_size_mismatch'
            throw error
        }
        const destination = this.objectPath(normalized)
        fs.mkdirSync(path.dirname(destination), { recursive: true })
        if(!fs.existsSync(destination)) {
            const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`
            fs.writeFileSync(temporary, value, { flag: 'wx' })
            try { fs.renameSync(temporary, destination) }
            catch(error) { fs.rmSync(temporary, { force: true }); if(!fs.existsSync(destination)) throw error }
        }
        const index = this.readIndex()
        index.entries[normalized] = {
            sizeBytes: value.length,
            lastAccessedAt: Date.now(),
            role: metadata.role || 'artifact',
            mimeType: metadata.mimeType || 'application/octet-stream'
        }
        this.evict(index)
        writeJsonAtomic(this.indexPath, index)
        return destination
    }

    evict(index = this.readIndex()) {
        const entries = Object.entries(index.entries).sort((left, right) => Number(left[1].lastAccessedAt) - Number(right[1].lastAccessedAt))
        let total = entries.reduce((sum, entry) => sum + Number(entry[1].sizeBytes || 0), 0)
        for(const [sha256, metadata] of entries) {
            if(total <= this.maxBytes) break
            fs.rmSync(this.objectPath(sha256), { force: true })
            total -= Number(metadata.sizeBytes || 0)
            delete index.entries[sha256]
        }
    }

    async resolve(descriptor, fetchImpl, options = {}) {
        const cached = this.get(descriptor.sha256, descriptor.sizeBytes)
        if(cached) return { bytes: cached, cached: true }
        if(options.offline || !descriptor.downloadUrl) {
            const error = new Error('This preview is not cached and requires a connection.')
            error.code = 'community_preview_not_cached'
            throw error
        }
        const response = await fetchImpl(descriptor.downloadUrl, { method: 'GET', signal: options.signal })
        if(!response.ok) throw new Error(`Community preview download returned HTTP ${response.status}.`)
        const bytes = Buffer.from(await response.arrayBuffer())
        this.put(descriptor.sha256, bytes, descriptor)
        return { bytes, cached: false }
    }
}

module.exports = {
    CACHE_SCHEMA_VERSION,
    CommunityArtifactCache,
    DEFAULT_MAX_BYTES,
    hashBuffer
}
