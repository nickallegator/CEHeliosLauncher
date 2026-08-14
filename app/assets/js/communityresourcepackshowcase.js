'use strict'

const fs = require('fs')
const AdmZip = require('adm-zip')

const MAX_SCAN_BYTES = 100 * 1024 * 1024
const MAX_ENTRIES = 10_000

function discoverResourcePackShowcase(filePath) {
    const stat = fs.statSync(filePath)
    if(!stat.isFile() || stat.size < 1 || stat.size > MAX_SCAN_BYTES) throw new Error('Resource Pack must be between 1 byte and 100 MiB.')
    const zip = new AdmZip(filePath)
    const entries = zip.getEntries()
    if(entries.length > MAX_ENTRIES) throw new Error('Resource Pack contains too many files to preview safely.')
    const candidates = []
    for(const entry of entries) {
        if(entry.isDirectory) continue
        const name = String(entry.entryName || '').replaceAll('\\', '/')
        if(name.startsWith('/') || /^[a-z]:/i.test(name) || name.split('/').some(part => part === '..' || part === '.')) throw new Error('Resource Pack contains an unsafe path.')
        const block = name.match(/^assets\/([^/]+)\/blockstates\/(.+)\.json$/i)
        if(block) candidates.push({ kind: 'block', id: `${block[1].toLowerCase()}:${block[2].toLowerCase()}`, state: {} })
        const resolver = name.match(/^assets\/cobblemon\/bedrock\/pokemon\/resolvers\/(.+)\.json$/i)
        if(resolver && entry.header?.size <= 1024 * 1024) {
            try {
                const document = JSON.parse(entry.getData().toString('utf8'))
                const raw = String(document.species || resolver[1].split('/').at(-1)).toLowerCase()
                candidates.push({ kind: 'pokemon', species: raw.includes(':') ? raw : `cobblemon:${raw}`, form: '', gender: 'MALE' })
            } catch(_error) { /* Backend reports malformed JSON authoritatively during finalization. */ }
        }
    }
    const unique = new Map()
    for(const candidate of candidates) unique.set(candidate.kind === 'block' ? `block:${candidate.id}` : `pokemon:${candidate.species}`, candidate)
    return [...unique.values()].sort((left, right) => (left.id || left.species).localeCompare(right.id || right.species))
}

function defaultShowcase(candidates) {
    const subjects = []
    let pokemon = 0
    for(const candidate of candidates) {
        if(subjects.length >= 8) break
        if(candidate.kind === 'pokemon' && pokemon >= 4) continue
        subjects.push({ ...candidate })
        if(candidate.kind === 'pokemon') pokemon += 1
    }
    return { schemaVersion: 1, subjects }
}

module.exports = { MAX_ENTRIES, MAX_SCAN_BYTES, defaultShowcase, discoverResourcePackShowcase }
