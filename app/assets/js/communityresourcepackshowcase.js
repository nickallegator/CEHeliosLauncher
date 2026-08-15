'use strict'

const fs = require('fs')
const { loadWorkspaceLibrary } = require('./workspacelibrary')
const {
    indexResourcePack,
    showcaseCandidatesFromComponents
} = loadWorkspaceLibrary('resource-pack-studio')

const MAX_SCAN_BYTES = 100 * 1024 * 1024
const MAX_ENTRIES = 10_000

function discoverResourcePackShowcase(filePath) {
    const stat = fs.statSync(filePath)
    if(!stat.isFile() || stat.size < 1 || stat.size > MAX_SCAN_BYTES) throw new Error('Resource Pack must be between 1 byte and 100 MiB.')
    return showcaseCandidatesFromComponents(indexResourcePack(filePath).components)
}

function defaultShowcase(candidates) {
    const subjects = []
    let pokemon = 0
    for(const candidate of candidates) {
        if(subjects.length >= 8) break
        if(candidate.kind === 'pokemon' && pokemon >= 4) continue
        subjects.push({ ...candidate, ...(candidate.defaultShiny === true ? { shiny: true } : {}) })
        if(candidate.kind === 'pokemon') pokemon += 1
    }
    return { schemaVersion: 1, subjects }
}

module.exports = { MAX_ENTRIES, MAX_SCAN_BYTES, defaultShowcase, discoverResourcePackShowcase }
