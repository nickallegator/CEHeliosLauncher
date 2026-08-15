'use strict'

const crypto = require('crypto')
const { DEFAULT_COMPATIBILITY, FORMAT_CONTRACTS, TYPES } = require('@allegator-games/community-core')

const CATEGORY_ALL = 'all'
const CATEGORY_SCHEMATICS = 'schematics'
const SORT_POPULAR = 'popular'
const SORT_RECENT = 'recent'
const CURSOR_VERSION = 1
const MAX_LIMIT = 60

function requestError(code, message, statusCode = 400) {
    const error = new Error(message)
    error.code = code
    error.statusCode = statusCode
    return error
}

function cleanText(value, maxLength = 100) {
    return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

function cleanTags(value) {
    const source = Array.isArray(value) ? value : String(value || '').split(',')
    return Array.from(new Set(source.map(tag => cleanText(tag, 24)).filter(Boolean))).slice(0, 12)
}

function normalizeCategory(value, supported = [CATEGORY_SCHEMATICS]) {
    const normalized = cleanText(value || CATEGORY_ALL, 32).toLowerCase()
    if(![CATEGORY_ALL, ...supported].includes(normalized)) {
        throw requestError('unsupported_community_category', `Unsupported Community category: ${normalized}`)
    }
    return normalized
}

function normalizeSort(value) {
    const normalized = cleanText(value || SORT_POPULAR, 16).toLowerCase()
    if(![SORT_POPULAR, SORT_RECENT].includes(normalized)) {
        throw requestError('unsupported_community_sort', `Unsupported Community sort: ${normalized}`)
    }
    return normalized
}

function encodeCursor(value) {
    return Buffer.from(JSON.stringify({ version: CURSOR_VERSION, ...value }), 'utf8').toString('base64url')
}

function decodeCursor(value, expectedSort) {
    if(!value) return null
    try {
        const decoded = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'))
        if(decoded?.version !== CURSOR_VERSION || decoded?.sort !== expectedSort) throw new Error('version')
        if(!Number.isFinite(Number(decoded.likes)) || !Number.isFinite(Date.parse(decoded.updatedAt))) throw new Error('values')
        if(!/^[a-z0-9._:-]{1,160}$/i.test(String(decoded.type || ''))) throw new Error('type')
        if(!/^[a-z0-9._:-]{1,160}$/i.test(String(decoded.id || ''))) throw new Error('id')
        return {
            sort: expectedSort,
            likes: Number(decoded.likes),
            updatedAt: new Date(decoded.updatedAt).toISOString(),
            type: String(decoded.type).toLowerCase(),
            id: String(decoded.id).toLowerCase()
        }
    } catch(_error) {
        throw requestError('invalid_community_cursor', 'The Community catalog cursor is invalid.')
    }
}

function normalizeSchematicRow(row) {
    return {
        key: `${CATEGORY_SCHEMATICS}:${row.id}`,
        type: CATEGORY_SCHEMATICS,
        id: row.id,
        title: row.name,
        description: row.description || '',
        creator: {
            id: row.owner_id == null ? null : String(row.owner_id),
            name: row.creator_display_name || row.creator || 'Minecraft Player'
        },
        tags: row.tags || [],
        thumbnailUrl: `/v1/schematics/${row.id}/thumbnail?size=tiny`,
        publishedAt: row.created_at,
        updatedAt: row.updated_at,
        stats: {
            likes: Number(row.likes || 0),
            downloads: Number(row.downloads || 0),
            views: Number(row.views || 0)
        },
        capabilities: {
            install: true,
            revision: true,
            like: true,
            report: true
        },
        license: null,
        compatibility: {
            minecraft: '1.21.1',
            loader: 'neoforge',
            cobblePower: row.release_version || null,
            cobblemon: null
        },
        revision: row.revision_id ? {
            id: row.revision_id,
            number: Number(row.revision_number),
            sha256: row.sha256,
            sizeBytes: Number(row.revision_size_bytes),
            formatId: row.format_id,
            formatVersion: Number(row.format_version)
        } : null,
        dependencies: [],
        typeData: { blockCount: Number(row.block_count || 0) },
        schematic: {
            version: row.release_version || null,
            revision: row.revision_id ? {
                id: row.revision_id,
                number: Number(row.revision_number),
                sha256: row.sha256,
                sizeBytes: Number(row.revision_size_bytes),
                blockCount: Number(row.block_count),
                formatId: row.format_id,
                formatVersion: Number(row.format_version)
            } : null
        }
    }
}

function normalizeCommunityRow(row) {
    const compatibility = typeof row.compatibility === 'string' ? JSON.parse(row.compatibility) : (row.compatibility || {})
    const typeData = typeof row.type_data === 'string' ? JSON.parse(row.type_data) : (row.type_data || {})
    const dependencies = typeof row.dependencies === 'string' ? JSON.parse(row.dependencies) : (row.dependencies || [])
    const source = row.source_provider === 'modrinth' ? {
        provider: 'modrinth', projectId: row.provider_project_id, versionId: row.provider_version_id,
        versionNumber: row.provider_version_number, fileName: row.provider_file_name,
        projectUrl: row.provider_project_url,
        creator: typeof row.provider_creator === 'string' ? JSON.parse(row.provider_creator) : (row.provider_creator || null)
    } : { provider: 'r2' }
    return {
        key: `${row.type}:${row.id}`,
        type: row.type,
        id: row.id,
        title: row.title,
        description: row.description || '',
        creator: {
            id: row.owner_id == null ? null : String(row.owner_id),
            name: row.creator_display_name || 'Minecraft Player'
        },
        tags: row.tags || [],
        thumbnailUrl: `/v1/community/items/${row.type}/${row.id}/preview?size=tiny`,
        publishedAt: row.created_at,
        updatedAt: row.updated_at,
        stats: {
            likes: Number(row.likes || 0),
            downloads: Number(row.downloads || 0),
            views: Number(row.views || 0)
        },
        capabilities: {
            install: true,
            revision: true,
            like: true,
            report: true
        },
        license: row.license,
        compatibility,
        revision: {
            id: row.revision_id,
            number: Number(row.revision_number),
            sha256: row.sha256,
            sizeBytes: Number(row.revision_size_bytes),
            formatId: row.format_id,
            formatVersion: Number(row.format_version)
        },
        dependencies,
        typeData,
        source,
        availability: { available: row.source_available !== false, lastVerifiedAt: row.source_last_verified_at || null }
    }
}

class CommunityCatalogRegistry {
    constructor(providers = []) {
        this.providers = new Map()
        providers.forEach(provider => this.register(provider))
    }

    register(provider) {
        if(!provider || typeof provider.id !== 'string' || typeof provider.list !== 'function') {
            throw new TypeError('Community catalog providers require an id and list function.')
        }
        if(this.providers.has(provider.id)) throw new Error(`Duplicate Community catalog provider: ${provider.id}`)
        this.providers.set(provider.id, Object.freeze({ ...provider }))
        return this
    }

    get(id) {
        return this.providers.get(id) || null
    }

    capabilities(context = {}) {
        return Array.from(this.providers.values())
            .filter(provider => provider.isEnabled?.(context) !== false)
            .map(provider => provider.capability(context))
    }

    enabled(context = {}) {
        return Array.from(this.providers.values()).filter(provider => provider.isEnabled?.(context) !== false)
    }
}

function createSchematicProvider(options) {
    const database = options.database
    const settings = options.settings
    if(!database?.query) throw new TypeError('The schematic Community provider requires a database.')

    return {
        id: CATEGORY_SCHEMATICS,
        isEnabled: () => settings.enabled === true,
        capability: () => ({
            id: CATEGORY_SCHEMATICS,
            readable: true,
            writable: settings.writeMode !== 'disabled',
            features: {
                install: true,
                revisions: true
            }
        }),
        async list(input) {
            const params = []
            const where = ['s.visibility = \'public\'', 's.status = \'active\'']
            const add = value => {
                params.push(value)
                return `$${params.length}`
            }

            if(input.query) {
                const placeholder = add(`%${input.query}%`)
                where.push(`(s.name ilike ${placeholder} or s.creator ilike ${placeholder} or coalesce(u.display_name, '') ilike ${placeholder})`)
            }
            if(input.creator) {
                const placeholder = add(`%${input.creator}%`)
                where.push(`(s.creator ilike ${placeholder} or coalesce(u.display_name, '') ilike ${placeholder})`)
            }
            if(input.tags.length > 0) where.push(`s.tags @> ${add(input.tags)}::text[]`)
            if(input.ownerId != null) where.push(`s.owner_id = ${add(input.ownerId)}`)

            if(input.cursor) {
                const likes = add(input.cursor.likes)
                const updatedAt = add(input.cursor.updatedAt)
                const sameRankAfterCursor = this.id > input.cursor.type
                    ? 'true'
                    : (this.id === input.cursor.type ? `s.id > ${add(input.cursor.id)}` : 'false')
                if(input.sort === SORT_POPULAR) {
                    where.push(`(coalesce(s.likes, 0) < ${likes}
                        or (coalesce(s.likes, 0) = ${likes} and s.updated_at < ${updatedAt})
                        or (coalesce(s.likes, 0) = ${likes} and s.updated_at = ${updatedAt} and ${sameRankAfterCursor}))`)
                } else {
                    where.push(`(s.updated_at < ${updatedAt} or (s.updated_at = ${updatedAt} and ${sameRankAfterCursor}))`)
                }
            }

            const order = input.sort === SORT_RECENT
                ? 's.updated_at desc, s.id asc'
                : 'coalesce(s.likes, 0) desc, s.updated_at desc, s.id asc'
            const limit = add(input.limit + 1)
            const rows = await database.query(
                `select s.id, s.owner_id, s.name, s.creator, s.description, s.tags,
                        s.created_at, s.updated_at, s.downloads, s.likes, s.views,
                        s.version as release_version, u.display_name as creator_display_name,
                        r.id as revision_id, r.revision_number, r.sha256,
                        r.size_bytes as revision_size_bytes, r.block_count,
                        r.format_id, r.format_version
                 from schematics s
                 join schematic_revisions r on r.id = s.current_revision_id
                 left join users u on u.id = s.owner_id
                 where ${where.join(' and ')}
                 order by ${order}
                 limit ${limit}`,
                params
            )
            return rows.rows.map(normalizeSchematicRow)
        }
    }
}

function createCommunityProvider(options) {
    const database = options.database
    const settings = options.settings
    const id = options.id
    if(!database?.query) throw new TypeError('Community content providers require a database.')
    if(!FORMAT_CONTRACTS[id]) throw new TypeError(`Unknown Community content provider: ${id}`)
    return {
        id,
        isEnabled: () => settings.enabled === true && settings.types?.[id] === true,
        capability: () => ({
            id,
            readable: true,
            writable: settings.writeMode !== 'disabled',
            format: FORMAT_CONTRACTS[id],
            compatibility: DEFAULT_COMPATIBILITY,
            features: {
                install: true,
                revisions: true,
                dependencies: id === TYPES.AUTOMATION || id === TYPES.BATTLE_TRAINERS,
                autoEnable: id === TYPES.RESOURCE_PACKS
            }
        }),
        async list(input) {
            const params = []
            const where = ['i.type = $1', 'i.visibility = \'public\'', 'i.status = \'active\'']
            params.push(id)
            const add = value => {
                params.push(value)
                return `$${params.length}`
            }
            if(input.query) {
                const placeholder = add(`%${input.query}%`)
                where.push(`(i.title ilike ${placeholder} or i.description ilike ${placeholder} or coalesce(u.display_name, '') ilike ${placeholder})`)
            }
            if(input.creator) where.push(`coalesce(u.display_name, '') ilike ${add(`%${input.creator}%`)}`)
            if(input.tags.length > 0) where.push(`i.tags @> ${add(input.tags)}::text[]`)
            if(input.ownerId != null) where.push(`i.owner_id = ${add(input.ownerId)}`)
            if(input.cursor) {
                const likes = add(input.cursor.likes)
                const updatedAt = add(input.cursor.updatedAt)
                const sameRankAfterCursor = id > input.cursor.type
                    ? 'true'
                    : (id === input.cursor.type ? `i.id > ${add(input.cursor.id)}` : 'false')
                if(input.sort === SORT_POPULAR) {
                    where.push(`(i.likes < ${likes}
                        or (i.likes = ${likes} and i.updated_at < ${updatedAt})
                        or (i.likes = ${likes} and i.updated_at = ${updatedAt} and ${sameRankAfterCursor}))`)
                } else {
                    where.push(`(i.updated_at < ${updatedAt} or (i.updated_at = ${updatedAt} and ${sameRankAfterCursor}))`)
                }
            }
            const order = input.sort === SORT_RECENT
                ? 'i.updated_at desc, i.id asc'
                : 'i.likes desc, i.updated_at desc, i.id asc'
            const limit = add(input.limit + 1)
            const result = await database.query(
                `select i.id, i.type, i.owner_id, i.title, i.description, i.tags, i.license,
                        i.created_at, i.updated_at, i.likes, i.views, i.downloads,
                        u.display_name as creator_display_name,
                        r.id as revision_id, r.revision_number, r.sha256,
                        r.size_bytes as revision_size_bytes, r.format_id, r.format_version,
                        r.compatibility, r.type_data,
                        rs.provider as source_provider,rs.provider_project_id,rs.provider_version_id,
                        rs.provider_file_name,rs.provider_version_number,rs.provider_project_url,
                        rs.provider_creator,rs.available as source_available,rs.last_verified_at as source_last_verified_at,
                        coalesce((
                            select jsonb_agg(jsonb_build_object(
                                'type', d.dependency_type,
                                'itemId', d.dependency_item_id,
                                'revisionId', d.dependency_revision_id,
                                'required', d.required,
                                'installOrder', d.install_order
                            ) order by d.install_order, d.dependency_type, d.dependency_item_id)
                            from community_revision_dependencies d where d.revision_id = r.id
                        ), '[]'::jsonb) as dependencies
                 from community_items i
                 join community_revisions r on r.id = i.current_revision_id
                 left join community_revision_sources rs on rs.revision_id=r.id
                 left join users u on u.id = i.owner_id
                 where ${where.join(' and ')}
                 order by ${order}
                 limit ${limit}`,
                params
            )
            return result.rows.map(normalizeCommunityRow)
        }
    }
}

function compareCatalogEntries(left, right, sort) {
    const updated = Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
    if(sort === SORT_POPULAR) {
        const likes = Number(right.stats?.likes || 0) - Number(left.stats?.likes || 0)
        if(likes !== 0) return likes
    }
    if(updated !== 0) return updated
    return left.type.localeCompare(right.type) || left.id.localeCompare(right.id)
}

function createCommunityCatalog(options) {
    const schematicSettings = options.schematicSettings || options.settings || { enabled: false }
    const communitySettings = options.communitySettings || { enabled: false, types: {} }
    const registry = options.registry || new CommunityCatalogRegistry([
        createSchematicProvider({ database: options.database, settings: schematicSettings }),
        ...Object.values(TYPES).map(id => createCommunityProvider({ database: options.database, settings: communitySettings, id }))
    ])

    return {
        capabilities() {
            return {
                schemaVersion: 1,
                defaultCategory: CATEGORY_ALL,
                defaultSort: SORT_POPULAR,
                categories: registry.capabilities({ schematicSettings, communitySettings })
            }
        },
        async list(input = {}) {
            const availableProviders = registry.enabled({ schematicSettings, communitySettings })
            const category = normalizeCategory(input.category, availableProviders.map(provider => provider.id))
            const sort = normalizeSort(input.sort)
            const limit = Math.min(MAX_LIMIT, Math.max(1, Number(input.limit) || 24))
            const cursor = decodeCursor(input.cursor, sort)
            const providers = category === CATEGORY_ALL
                ? availableProviders
                : availableProviders.filter(provider => provider.id === category)
            if(providers.length === 0) {
                return { schemaVersion: 1, category, sort, items: [], nextCursor: null }
            }
            const providerInput = {
                category, sort, limit, cursor,
                query: cleanText(input.query, 100),
                creator: cleanText(input.creator, 80),
                tags: cleanTags(input.tags),
                ownerId: input.ownerId ?? null
            }
            const candidates = (await Promise.all(providers.map(provider => provider.list(providerInput))))
                .flat()
                .sort((left, right) => compareCatalogEntries(left, right, sort))
            const hasMore = candidates.length > limit
            const items = candidates.slice(0, limit)
            const last = items.at(-1)
            return {
                schemaVersion: 1,
                category,
                sort,
                items,
                nextCursor: hasMore && last ? encodeCursor({
                    sort,
                    likes: Number(last.stats?.likes || 0),
                    updatedAt: new Date(last.updatedAt).toISOString(),
                    type: last.type,
                    id: last.id
                }) : null
            }
        },
        etag(value) {
            return `"${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}"`
        }
    }
}

module.exports = {
    CATEGORY_ALL,
    CATEGORY_SCHEMATICS,
    CommunityCatalogRegistry,
    SORT_POPULAR,
    SORT_RECENT,
    cleanTags,
    compareCatalogEntries,
    createCommunityCatalog,
    createCommunityProvider,
    createSchematicProvider,
    decodeCursor,
    encodeCursor,
    normalizeCategory,
    normalizeSchematicRow,
    normalizeCommunityRow,
    normalizeSort
}
