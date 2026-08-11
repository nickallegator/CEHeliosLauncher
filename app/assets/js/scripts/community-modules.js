'use strict'

class CommunityModuleRegistry {
    constructor(modules = []){
        this.modules = new Map()
        for(const definition of modules) this.register(definition)
    }

    register(definition){
        if(!definition || typeof definition.id !== 'string' || !definition.id.trim()){
            throw new TypeError('Community modules require a stable id.')
        }
        if(this.modules.has(definition.id)){
            throw new Error(`Duplicate community module id: ${definition.id}`)
        }
        if(typeof definition.isEnabled !== 'function' || typeof definition.open !== 'function'){
            throw new TypeError(`Community module ${definition.id} requires isEnabled and open functions.`)
        }
        this.modules.set(definition.id, Object.freeze({ ...definition }))
        return this
    }

    async enabled(context = {}){
        const enabledModules = []
        for(const definition of this.modules.values()){
            if(await definition.isEnabled(context)) enabledModules.push(definition)
        }
        return enabledModules
    }

    get(id){
        return this.modules.get(id) || null
    }
}

function isSchematicsEnabled(rawDistribution = {}, environment = {}){
    const configuredBase = String(environment.HELIOS_SCHEMATICS_API_URL || '').trim()
    const service = rawDistribution?.schematics || {}
    const enabled = configuredBase.length > 0 || service.enabled === true
    const compatible = Number(service.schemaVersion || 2) === 2
    return enabled && compatible && service.features?.core !== false
}

function createDefaultCommunityRegistry(options = {}){
    const environment = options.environment || (typeof process !== 'undefined' ? process.env : {})
    return new CommunityModuleRegistry([
        {
            id: 'schematics',
            labelKey: 'ejs.community.schematicsTitle',
            descriptionKey: 'ejs.community.schematicsBody',
            actionKey: 'ejs.community.schematicsAction',
            metaKey: 'ejs.community.schematicsMeta',
            defaultRoute: 'community/schematics',
            async isEnabled(context){
                const rawDistribution = context.rawDistribution || await context.getDistribution?.()
                return isSchematicsEnabled(rawDistribution || {}, environment)
            },
            async load(context){
                await context.ensureReady?.()
            },
            async open(context){
                await context.navigate?.('community/schematics')
            }
        }
    ])
}

if(typeof window !== 'undefined'){
    window.CommunityModules = {
        CommunityModuleRegistry,
        createDefaultCommunityRegistry,
        isSchematicsEnabled
    }
}

if(typeof module !== 'undefined'){
    module.exports = {
        CommunityModuleRegistry,
        createDefaultCommunityRegistry,
        isSchematicsEnabled
    }
}
