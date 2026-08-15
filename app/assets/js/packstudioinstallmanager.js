'use strict'

const fs = require('fs')
const path = require('path')

const { writeJsonAtomic } = require('./atomicjson')
const {
    ensureInside,
    hashFile,
    reorderResourcePackOptions,
    resourcePackState,
    updateResourcePacksOptions,
    writeFilesTransaction
} = require('./communityinstallmanager')

const INDEX_SCHEMA_VERSION = 1
const SAFE_ID = /^[a-f0-9-]{36}$/i
const SAFE_PROFILE = /^[a-z0-9._-]{1,96}$/i

class PackStudioInstallManager {
    constructor(options = {}) {
        this.instanceDirectory = path.resolve(options.instanceDirectory)
        this.indexPath = path.resolve(options.indexPath)
        this.isGameRunning = options.isGameRunning || (() => false)
        this.records = this.load()
    }
    load() {
        try {
            const value = JSON.parse(fs.readFileSync(this.indexPath, 'utf8'))
            return value?.schemaVersion === INDEX_SCHEMA_VERSION && Array.isArray(value.records) ? value.records : []
        } catch(_error) { return [] }
    }
    save() {
        writeJsonAtomic(this.indexPath, { schemaVersion: INDEX_SCHEMA_VERSION, records: this.records })
    }
    key(profileId, projectId) { return `${profileId}:${projectId}` }
    get(profileId, projectId) { return this.records.find(record => record.key === this.key(profileId, projectId)) || null }
    paths(profileId, projectId) {
        if(!SAFE_PROFILE.test(profileId) || !SAFE_ID.test(projectId)) throw new Error('Pack Studio install target is invalid.')
        const root = ensureInside(this.instanceDirectory, path.join(this.instanceDirectory, profileId), 'Pack Studio instance')
        const filename = `ag-studio-${projectId}.zip`
        return {
            root,
            packPath: ensureInside(root, path.join(root, 'resourcepacks', filename), 'Pack Studio Resource Pack'),
            optionsPath: ensureInside(root, path.join(root, 'options.txt'), 'Minecraft options'),
            backupPath: ensureInside(root, path.join(root, 'options.txt.ag-launcher.bak'), 'Minecraft options backup'),
            packId: `file/${filename}`
        }
    }
    assertStopped() {
        if(this.isGameRunning()) throw Object.assign(new Error('Close Minecraft before changing Pack Studio Resource Packs.'), { code: 'game_running' })
    }
    assertUnmodified(record, confirmModified) {
        if(!record) return
        const changed = []
        if(fs.existsSync(record.packPath) && hashFile(record.packPath) !== record.sha256) changed.push(record.packPath)
        const state = resourcePackState(record.optionsPath, record.packId)
        if(state.enabled !== record.enabled || state.orderIndex !== record.orderIndex) changed.push(record.optionsPath)
        if(changed.length && !(typeof confirmModified === 'function' && confirmModified(changed))) {
            throw Object.assign(new Error('The installed Pack Studio pack or its priority was modified outside AG Launcher.'), { code: 'locally_modified', paths: changed })
        }
    }
    status(profileId, projectId) {
        const record = this.get(profileId, projectId)
        if(!record) return { state: 'install', record: null }
        if(!fs.existsSync(record.packPath)) return { state: 'repair', record }
        if(hashFile(record.packPath) !== record.sha256) return { state: 'modified', record }
        const state = resourcePackState(record.optionsPath, record.packId)
        if(!state.enabled) return { state: 'disabled', record }
        return { state: 'installed', record }
    }
    install({ profileId, project, build, confirmModified }) {
        this.assertStopped()
        const existing = this.get(profileId, project.id)
        this.assertUnmodified(existing, confirmModified)
        const targets = this.paths(profileId, project.id)
        if(fs.existsSync(targets.packPath) && !existing && !(typeof confirmModified === 'function' && confirmModified([targets.packPath]))) {
            throw Object.assign(new Error('A Resource Pack already exists at the Pack Studio install target.'), { code: 'untracked_file', paths: [targets.packPath] })
        }
        const originalOptions = fs.existsSync(targets.optionsPath) ? fs.readFileSync(targets.optionsPath) : Buffer.alloc(0)
        const options = updateResourcePacksOptions(targets.optionsPath, targets.packId, { enabled: true, highestPriority: true })
        writeFilesTransaction([
            { path: targets.packPath, sourcePath: build.outputPath },
            { path: targets.backupPath, content: originalOptions },
            { path: targets.optionsPath, content: options.content }
        ])
        const record = {
            key: this.key(profileId, project.id),
            profileId,
            projectId: project.id,
            name: project.name,
            packPath: targets.packPath,
            optionsPath: targets.optionsPath,
            backupPath: targets.backupPath,
            packId: targets.packId,
            sha256: hashFile(targets.packPath),
            enabled: true,
            orderIndex: options.orderIndex,
            installedAt: new Date().toISOString()
        }
        this.records = this.records.filter(value => value.key !== record.key)
        this.records.push(record); this.save()
        return record
    }
    setEnabled({ profileId, projectId, enabled, confirmModified }) {
        this.assertStopped()
        const record = this.get(profileId, projectId)
        if(!record) return false
        this.assertUnmodified(record, confirmModified)
        const original = fs.existsSync(record.optionsPath) ? fs.readFileSync(record.optionsPath) : Buffer.alloc(0)
        const options = updateResourcePacksOptions(record.optionsPath, record.packId, { enabled, highestPriority: true })
        writeFilesTransaction([{ path: record.backupPath, content: original }, { path: record.optionsPath, content: options.content }])
        record.enabled = enabled; record.orderIndex = options.orderIndex; this.save(); return true
    }
    reorder({ profileId, projectId, direction, confirmModified }) {
        this.assertStopped()
        const record = this.get(profileId, projectId)
        if(!record) return false
        this.assertUnmodified(record, confirmModified)
        const original = fs.existsSync(record.optionsPath) ? fs.readFileSync(record.optionsPath) : Buffer.alloc(0)
        const options = reorderResourcePackOptions(record.optionsPath, record.packId, direction)
        writeFilesTransaction([{ path: record.backupPath, content: original }, { path: record.optionsPath, content: options.content }])
        record.orderIndex = options.orderIndex; this.save(); return true
    }
    remove({ profileId, projectId, confirmModified }) {
        this.assertStopped()
        const record = this.get(profileId, projectId)
        if(!record) return false
        this.assertUnmodified(record, confirmModified)
        const original = fs.existsSync(record.optionsPath) ? fs.readFileSync(record.optionsPath) : Buffer.alloc(0)
        const options = updateResourcePacksOptions(record.optionsPath, record.packId, { enabled: false })
        writeFilesTransaction([
            { path: record.packPath, content: null },
            { path: record.backupPath, content: original },
            { path: record.optionsPath, content: options.content }
        ])
        this.records = this.records.filter(value => value.key !== record.key); this.save(); return true
    }
}

module.exports = { INDEX_SCHEMA_VERSION, PackStudioInstallManager }
