'use strict'

const config = require('../config')
const { createModrinthProvider } = require('./modrinth')

let registry = null

function createExternalProviderRegistry(dependencies = {}) {
    const providers = new Map()
    if(config.modrinth.enabled || dependencies.includeDisabled) {
        providers.set('modrinth', createModrinthProvider(config.modrinth, dependencies.modrinth || {}))
    }
    return {
        get(id) { return providers.get(String(id || '').toLowerCase()) || null },
        list() { return [...providers.keys()] }
    }
}

function getExternalProviderRegistry() {
    if(!registry) registry = createExternalProviderRegistry()
    return registry
}

module.exports = { createExternalProviderRegistry, getExternalProviderRegistry }
