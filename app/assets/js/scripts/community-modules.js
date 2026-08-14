'use strict'

class CommunityContentTypeRegistry {
    constructor(definitions = []){
        this.definitions = new Map()
        for(const definition of definitions) this.register(definition)
    }

    register(definition){
        if(!definition || typeof definition.id !== 'string' || !definition.id.trim()){
            throw new TypeError('Community content types require a stable id.')
        }
        if(this.definitions.has(definition.id)){
            throw new Error(`Duplicate Community content type id: ${definition.id}`)
        }
        if(typeof definition.isEnabled !== 'function' || typeof definition.normalize !== 'function' || typeof definition.openDetail !== 'function'){
            throw new TypeError(`Community content type ${definition.id} requires isEnabled, normalize, and openDetail functions.`)
        }
        for(const hook of ['publish', 'install', 'update', 'remove', 'manageInstalled', 'createDetailRenderer', 'preparePublicationPreview', 'onDetailClosed']){
            if(definition[hook] != null && typeof definition[hook] !== 'function'){
                throw new TypeError(`Community content type ${definition.id} hook ${hook} must be a function.`)
            }
        }
        this.definitions.set(definition.id, Object.freeze({ ...definition }))
        return this
    }

    async enabled(context = {}){
        const enabledTypes = []
        for(const definition of this.definitions.values()){
            if(await definition.isEnabled(context)) enabledTypes.push(definition)
        }
        return enabledTypes
    }

    get(id){
        return this.definitions.get(id) || null
    }
}

function isSchematicsEnabled(rawDistribution = {}, environment = {}){
    const configuredBase = String(environment.HELIOS_SCHEMATICS_API_URL || '').trim()
    const community = rawDistribution?.community || {}
    const service = rawDistribution?.schematics || {}
    const enabled = configuredBase.length > 0 || community.enabled === true || service.enabled === true
    const communityCompatible = community.schemaVersion == null || Number(community.schemaVersion) === 1
    const schematicCompatible = service.schemaVersion == null || Number(service.schemaVersion) === 2
    return enabled && communityCompatible && schematicCompatible && service.features?.core !== false
}

function normalizeSchematicCatalogEntry(entry){
    if(entry?.type !== 'schematics' || !entry.id) return null
    return {
        id: entry.id,
        communityKey: entry.key || `schematics:${entry.id}`,
        communityType: 'schematics',
        name: entry.title,
        title: entry.title,
        description: entry.description || '',
        creator: entry.creator?.name || 'Minecraft Player',
        creatorId: entry.creator?.id || null,
        ownerId: entry.creator?.id || null,
        tags: Array.isArray(entry.tags) ? entry.tags : [],
        thumbnailUrl: entry.thumbnailUrl || null,
        release: entry.publishedAt || entry.updatedAt || null,
        updatedAt: entry.updatedAt || entry.publishedAt || null,
        downloads: Number(entry.stats?.downloads || 0),
        likes: Number(entry.stats?.likes || 0),
        views: Number(entry.stats?.views || 0),
        version: entry.schematic?.version || null,
        revision: entry.schematic?.revision || null,
        capabilities: entry.capabilities || {}
    }
}

function normalizeGenericCatalogEntry(entry, expectedType){
    if(entry?.type !== expectedType || !entry.id) return null
    return {
        ...entry,
        id: entry.id,
        communityKey: entry.key || `${expectedType}:${entry.id}`,
        communityType: expectedType,
        name: entry.title,
        title: entry.title,
        description: entry.description || '',
        creator: entry.creator?.name || 'Minecraft Player',
        creatorId: entry.creator?.id || null,
        ownerId: entry.creator?.id || null,
        tags: Array.isArray(entry.tags) ? entry.tags : [],
        thumbnailUrl: entry.thumbnailUrl || null,
        release: entry.publishedAt || entry.updatedAt || null,
        updatedAt: entry.updatedAt || entry.publishedAt || null,
        downloads: Number(entry.stats?.downloads || 0),
        likes: Number(entry.stats?.likes || 0),
        views: Number(entry.stats?.views || 0),
        revision: entry.revision || null,
        license: entry.license || null,
        compatibility: entry.compatibility || {},
        dependencies: Array.isArray(entry.dependencies) ? entry.dependencies : [],
        typeData: entry.typeData || {},
        capabilities: entry.capabilities || {}
    }
}

function genericTypeDefinition(id, labelKey, icon){
    return {
        id,
        labelKey,
        icon,
        async isEnabled(context){
            const serverTypes = Array.isArray(context.capabilities?.categories)
                ? context.capabilities.categories.map(category => category.id)
                : []
            return serverTypes.includes(id)
        },
        normalize: entry => normalizeGenericCatalogEntry(entry, id),
        openDetail(entry, context){
            return context.openGenericCommunityDetail?.(entry)
        },
        publish(context){
            return context.openGenericCommunityPublisher?.(id)
        },
        install(entry, context){
            return context.installGenericCommunityItem?.(entry)
        },
        update(entry, context){
            return context.installGenericCommunityItem?.(entry)
        },
        remove(entry, context){
            return context.removeGenericCommunityItem?.(entry)
        },
        manageInstalled(context){
            return context.openGenericInstalledManager?.(id)
        },
        createDetailRenderer(entry, context){
            return context.mountRichCommunityPreview?.(entry)
        },
        preparePublicationPreview(source, context){
            return context.prepareGenericCommunityPublication?.(id, source)
        },
        onDetailClosed(_entry, context){
            return context.destroyRichCommunityPreview?.()
        }
    }
}

function createDefaultCommunityContentRegistry(options = {}){
    const environment = options.environment || (typeof process !== 'undefined' ? process.env : {})
    return new CommunityContentTypeRegistry([
        {
            id: 'schematics',
            labelKey: 'ejs.community.schematicsTitle',
            icon: 'schematic',
            async isEnabled(context){
                const rawDistribution = context.rawDistribution || await context.getDistribution?.()
                const serverTypes = Array.isArray(context.capabilities?.categories)
                    ? context.capabilities.categories.map(category => category.id)
                    : ['schematics']
                return serverTypes.includes('schematics') && isSchematicsEnabled(rawDistribution || {}, environment)
            },
            normalize: normalizeSchematicCatalogEntry,
            openDetail(entry, context){
                return context.openSchematicDetail?.(entry)
            },
            publish(context){
                return context.openSchematicUpload?.()
            }
        },
        genericTypeDefinition('automation', 'ejs.community.automation', 'automation'),
        genericTypeDefinition('battle-trainers', 'ejs.community.battleTrainers', 'trainer'),
        genericTypeDefinition('builder-presets', 'ejs.community.builderPresets', 'palette'),
        genericTypeDefinition('resource-packs', 'ejs.community.resourcePacks', 'resource-pack')
    ])
}

// Compatibility alias for extensions that imported the pre-catalog factory.
const createDefaultCommunityRegistry = createDefaultCommunityContentRegistry

if(typeof window !== 'undefined'){
    window.CommunityModules = {
        CommunityContentTypeRegistry,
        createDefaultCommunityRegistry,
        createDefaultCommunityContentRegistry,
        genericTypeDefinition,
        normalizeGenericCatalogEntry,
        normalizeSchematicCatalogEntry,
        isSchematicsEnabled
    }
}

if(typeof module !== 'undefined'){
    module.exports = {
        CommunityContentTypeRegistry,
        createDefaultCommunityRegistry,
        createDefaultCommunityContentRegistry,
        genericTypeDefinition,
        normalizeGenericCatalogEntry,
        normalizeSchematicCatalogEntry,
        isSchematicsEnabled
    }
}
