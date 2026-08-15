'use strict'

const path = require('path')

function loadWorkspaceLibrary(name) {
    if(!/^[a-z0-9-]+$/i.test(String(name || ''))) throw new Error('Workspace library name is invalid.')
    const candidates = [
        process.resourcesPath ? path.join(process.resourcesPath, 'libraries', name) : null,
        path.resolve(process.cwd(), 'libraries', name),
        path.resolve(__dirname, '..', '..', '..', 'libraries', name)
    ].filter(Boolean)
    const failures = []
    for(const candidate of candidates) {
        try { return require(candidate) } catch(error) {
            if(error?.code !== 'MODULE_NOT_FOUND' || !String(error.message).includes(candidate)) throw error
            failures.push(candidate)
        }
    }
    throw new Error(`Required AG Launcher library ${name} is unavailable (${failures.join(', ')}).`)
}

module.exports = { loadWorkspaceLibrary }
