'use strict'

const fs = require('fs')

const { writeJsonAtomic } = require('./atomicjson')
const { SchematicApiClient } = require('./schematicmanager')

const COMMUNITY_CACHE_SCHEMA = 1
const COMMUNITY_CACHE_LIMIT = 16

function normalizeCommunityParams(params = {}) {
    const normalized = new URLSearchParams(params)
    for(const [key, value] of [...normalized.entries()]) {
        if(value == null || String(value).trim() === '') normalized.delete(key)
    }
    normalized.sort()
    return normalized
}

function normalizeCommunityEntry(entry) {
    const type = String(entry?.type || '').trim().toLowerCase()
    const id = String(entry?.id || '').trim()
    if(!type || !id) return null
    return {
        ...entry,
        key: `${type}:${id}`,
        type,
        id,
        title: String(entry.title || '').trim(),
        description: String(entry.description || ''),
        creator: {
            id: entry.creator?.id == null ? null : String(entry.creator.id),
            name: String(entry.creator?.name || 'Minecraft Player')
        },
        tags: Array.isArray(entry.tags) ? entry.tags.map(String) : [],
        stats: {
            likes: Number(entry.stats?.likes || 0),
            downloads: Number(entry.stats?.downloads || 0),
            views: Number(entry.stats?.views || 0)
        }
    }
}

function deduplicateCommunityEntries(entries = []) {
    const unique = new Map()
    for(const raw of entries) {
        const entry = normalizeCommunityEntry(raw)
        if(entry && !unique.has(entry.key)) unique.set(entry.key, entry)
    }
    return [...unique.values()]
}

function createCommunitySessionState(value = {}) {
    const rawCategory = String(value.category || 'all').trim().toLowerCase()
    return {
        category: /^[a-z0-9-]{1,40}$/.test(rawCategory) ? rawCategory : 'all',
        query: String(value.query || ''),
        sort: value.sort === 'recent' ? 'recent' : 'popular',
        filters: {
            creator: String(value.filters?.creator || ''),
            tags: String(value.filters?.tags || '')
        },
        scrollTop: Math.max(0, Number(value.scrollTop) || 0),
        items: deduplicateCommunityEntries(value.items)
    }
}

class CommunityApiClient extends SchematicApiClient {
    readCommunityCache(cacheKey) {
        if(!this.cachePath || !fs.existsSync(this.cachePath)) return null
        try {
            const value = JSON.parse(fs.readFileSync(this.cachePath, 'utf8'))
            if(value?.schemaVersion !== COMMUNITY_CACHE_SCHEMA || !Array.isArray(value.entries)) return null
            return value.entries.find(entry => entry.key === cacheKey) || null
        } catch(_error) {
            return null
        }
    }

    writeCommunityCache(cacheKey, record) {
        if(!this.cachePath) return
        let entries = []
        try {
            const current = JSON.parse(fs.readFileSync(this.cachePath, 'utf8'))
            if(current?.schemaVersion === COMMUNITY_CACHE_SCHEMA && Array.isArray(current.entries)) entries = current.entries
        } catch(_error) {
            // A corrupt cache is safely replaced by the current catalog response.
        }
        entries = entries.filter(entry => entry.key !== cacheKey)
        entries.unshift({ key: cacheKey, ...record })
        writeJsonAtomic(this.cachePath, {
            schemaVersion: COMMUNITY_CACHE_SCHEMA,
            entries: entries.slice(0, COMMUNITY_CACHE_LIMIT)
        })
    }

    async capabilities(options = {}) {
        const { data } = await this.request('/v1/community/capabilities', {
            headers: { Accept: 'application/json', ...(options.headers || {}) },
            signal: options.signal
        })
        return data
    }

    async catalog(params, options = {}) {
        const query = normalizeCommunityParams(params)
        const cacheKey = query.toString()
        const cacheable = query.get('mine') !== 'true'
        const cached = cacheable ? this.readCommunityCache(cacheKey) : null
        const headers = { Accept: 'application/json', ...(options.headers || {}) }
        if(cached?.etag) headers['If-None-Match'] = cached.etag
        try {
            const suffix = cacheKey ? `?${cacheKey}` : ''
            const { response, data } = await this.request(`/v1/community/catalog${suffix}`, {
                headers,
                signal: options.signal
            })
            if(response.status === 304 && cached) {
                return { ...cached.catalog, offline: false, cached: true }
            }
            const catalog = {
                ...data,
                items: deduplicateCommunityEntries(data?.items)
            }
            if(cacheable) {
                this.writeCommunityCache(cacheKey, {
                    etag: response.headers.get('etag'),
                    fetchedAt: new Date().toISOString(),
                    catalog
                })
            }
            return { ...catalog, offline: false, cached: false }
        } catch(error) {
            if(cached && !options.signal?.aborted) {
                return {
                    ...cached.catalog,
                    items: deduplicateCommunityEntries(cached.catalog?.items),
                    offline: true,
                    cached: true,
                    cacheFetchedAt: cached.fetchedAt
                }
            }
            throw error
        }
    }

    async detail(type, id, options = {}) {
        const { data } = await this.request(`/v1/community/items/${encodeURIComponent(type)}/${encodeURIComponent(id)}`, {
            headers: { Accept: 'application/json', ...(options.headers || {}) },
            signal: options.signal
        })
        return normalizeCommunityEntry(data)
    }

    async download(type, id, options = {}) {
        const { data: descriptor } = await this.request(`/v1/community/items/${encodeURIComponent(type)}/${encodeURIComponent(id)}/download`, {
            headers: { Accept: 'application/json', ...(options.headers || {}) },
            signal: options.signal
        })
        const response = await this.fetch(descriptor.downloadUrl, { method: 'GET', signal: options.signal })
        if(!response.ok) throw new Error(`Community artifact download returned HTTP ${response.status}.`)
        return { descriptor, artifact: Buffer.from(await response.arrayBuffer()) }
    }

    async previewAssets(type, id, options = {}) {
        const { data } = await this.request(`/v1/community/items/${encodeURIComponent(type)}/${encodeURIComponent(id)}/preview-assets`, {
            headers: { Accept: 'application/json', ...(options.headers || {}) },
            signal: options.signal
        })
        if(Number(data?.schemaVersion) !== 1 || !Array.isArray(data.assets)) throw new Error('Community preview asset response is invalid.')
        return data
    }

    async createUpload(metadata, options = {}) {
        const { data } = await this.request('/v1/community/uploads', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(options.headers || {}) },
            body: JSON.stringify(metadata),
            signal: options.signal
        })
        return data
    }

    async uploadSigned(url, body, mimeType, options = {}) {
        const response = await this.fetch(url, {
            method: 'PUT',
            headers: { 'Content-Type': mimeType },
            body,
            signal: options.signal
        })
        if(!response.ok) throw new Error(`Community upload returned HTTP ${response.status}.`)
    }

    async finalizeUpload(token, options = {}) {
        const { data } = await this.request(`/v1/community/uploads/${encodeURIComponent(token)}/finalize`, {
            method: 'POST',
            headers: { Accept: 'application/json', ...(options.headers || {}) },
            signal: options.signal
        })
        return normalizeCommunityEntry(data)
    }

    async publish(metadata, artifact, preview, options = {}) {
        const session = await this.createUpload({
            ...metadata,
            previewMime: preview?.mimeType || (metadata.type === 'resource-packs' ? null : 'image/png')
        }, options)
        await this.uploadSigned(session.uploads.artifact.uploadUrl, artifact, session.uploads.artifact.mimeType, options)
        if(session.uploads.preview) {
            if(!preview?.bytes) throw new Error('A preview image is required for this Community content type.')
            await this.uploadSigned(session.uploads.preview.uploadUrl, preview.bytes, session.uploads.preview.mimeType, options)
        }
        return this.finalizeUpload(session.token, options)
    }

    async engagement(type, id, action, options = {}) {
        const method = options.method || 'POST'
        const { data } = await this.request(`/v1/community/items/${encodeURIComponent(type)}/${encodeURIComponent(id)}/${action}`, {
            method,
            headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(options.headers || {}) },
            body: options.body == null ? undefined : JSON.stringify(options.body),
            signal: options.signal
        })
        return data
    }
}

module.exports = {
    COMMUNITY_CACHE_LIMIT,
    COMMUNITY_CACHE_SCHEMA,
    CommunityApiClient,
    createCommunitySessionState,
    deduplicateCommunityEntries,
    normalizeCommunityEntry,
    normalizeCommunityParams
}
