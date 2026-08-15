'use strict'

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const { writeJsonAtomic } = require('./atomicjson')

const PROJECT_SCHEMA_VERSION = 1
const PROJECT_ID = /^[a-f0-9-]{36}$/i
const COMPONENT_KEY = /^[a-z0-9-]+:[a-z0-9_.-]+:[a-z0-9/._-]+$/i

function projectRecipeHash(project) {
    const recipe = {
        schemaVersion: PROJECT_SCHEMA_VERSION,
        selections: [...(project?.selections || [])].sort((left, right) => `${left.sourceRevisionId}:${left.componentKey}`.localeCompare(`${right.sourceRevisionId}:${right.componentKey}`)),
        conflictResolutions: Object.fromEntries(Object.entries(project?.conflictResolutions || {}).sort(([left], [right]) => left.localeCompare(right)))
    }
    return crypto.createHash('sha256').update(JSON.stringify(recipe)).digest('hex')
}

function normalizeProject(value) {
    if(!value || typeof value !== 'object') throw new Error('Pack Studio project is invalid.')
    const id = String(value.id || '').toLowerCase()
    if(!PROJECT_ID.test(id)) throw new Error('Pack Studio project ID is invalid.')
    const name = String(value.name || '').trim().slice(0, 80)
    if(!name) throw new Error('Pack Studio project name is required.')
    const selections = Array.isArray(value.selections) ? value.selections.slice(0, 512).map(selection => {
        const normalized = {
            sourceItemId: String(selection.sourceItemId || '').toLowerCase(),
            sourceRevisionId: String(selection.sourceRevisionId || '').toLowerCase(),
            componentKey: String(selection.componentKey || '').toLowerCase()
        }
        if(!PROJECT_ID.test(normalized.sourceItemId) || !PROJECT_ID.test(normalized.sourceRevisionId) || !COMPONENT_KEY.test(normalized.componentKey)) {
            throw new Error('Pack Studio project contains an invalid component selection.')
        }
        return normalized
    }) : []
    const uniqueSelections = [...new Map(selections.map(selection => [`${selection.sourceRevisionId}:${selection.componentKey}`, selection])).values()]
    const conflictResolutions = value.conflictResolutions && typeof value.conflictResolutions === 'object'
        ? Object.fromEntries(Object.entries(value.conflictResolutions).slice(0, 1024).map(([key, winner]) => [String(key), String(winner)]))
        : {}
    return {
        schemaVersion: PROJECT_SCHEMA_VERSION,
        id,
        name,
        description: String(value.description || '').trim().slice(0, 300),
        selections: uniqueSelections,
        conflictResolutions,
        createdAt: value.createdAt || new Date().toISOString(),
        updatedAt: value.updatedAt || new Date().toISOString(),
        lastBuild: value.lastBuild || null
    }
}

class PackStudioProjectStore {
    constructor(directory) {
        this.directory = path.resolve(directory)
    }
    projectPath(id) {
        if(!PROJECT_ID.test(String(id || ''))) throw new Error('Pack Studio project ID is invalid.')
        return path.join(this.directory, `${String(id).toLowerCase()}.json`)
    }
    list() {
        if(!fs.existsSync(this.directory)) return []
        return fs.readdirSync(this.directory).filter(name => name.endsWith('.json')).flatMap(name => {
            try { return [normalizeProject(JSON.parse(fs.readFileSync(path.join(this.directory, name), 'utf8')))] } catch(_error) { return [] }
        }).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    }
    get(id) {
        try { return normalizeProject(JSON.parse(fs.readFileSync(this.projectPath(id), 'utf8'))) } catch(_error) { return null }
    }
    create(name = 'My Resource Pack') {
        const now = new Date().toISOString()
        return this.save({ schemaVersion: 1, id: crypto.randomUUID(), name, selections: [], conflictResolutions: {}, createdAt: now, updatedAt: now })
    }
    save(project) {
        const normalized = normalizeProject({ ...project, updatedAt: new Date().toISOString() })
        fs.mkdirSync(this.directory, { recursive: true })
        writeJsonAtomic(this.projectPath(normalized.id), normalized)
        return normalized
    }
    duplicate(id) {
        const source = this.get(id)
        if(!source) throw new Error('Pack Studio project was not found.')
        return this.save({ ...source, id: crypto.randomUUID(), name: `${source.name} Copy`, createdAt: new Date().toISOString(), lastBuild: null })
    }
    remove(id) {
        const filePath = this.projectPath(id)
        if(!fs.existsSync(filePath)) return false
        fs.rmSync(filePath, { force: true })
        return true
    }
}

module.exports = { PROJECT_SCHEMA_VERSION, PackStudioProjectStore, normalizeProject, projectRecipeHash }
