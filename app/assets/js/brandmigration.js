'use strict'

const fs = require('node:fs')
const path = require('node:path')

const STATE_ENTRIES = Object.freeze([
    'config.json',
    'distribution.json',
    'distribution_dev.json',
    'schematics-cache'
])

/**
 * Copy durable launcher state from the first recognized product identity.
 * Cache, GPU, cookie, and lock files are deliberately excluded. The source is
 * never modified, making rollback to an older test build possible.
 */
function migrateBrandUserData(options) {
    const appDataDirectory = path.resolve(options.appDataDirectory)
    const targetDirectory = path.resolve(options.targetDirectory)
    const legacyNames = Array.isArray(options.legacyNames) ? options.legacyNames : []
    const targetConfig = path.join(targetDirectory, 'config.json')
    if(fs.existsSync(targetConfig)) return { migrated: false, reason: 'target-config-exists' }

    for(const legacyName of legacyNames) {
        const sourceDirectory = path.resolve(appDataDirectory, legacyName)
        if(sourceDirectory === targetDirectory || !fs.existsSync(path.join(sourceDirectory, 'config.json'))) continue

        fs.mkdirSync(targetDirectory, { recursive: true })
        const copied = []
        for(const entry of STATE_ENTRIES) {
            const source = path.join(sourceDirectory, entry)
            const target = path.join(targetDirectory, entry)
            if(!fs.existsSync(source) || fs.existsSync(target)) continue
            fs.cpSync(source, target, { recursive: true, errorOnExist: false, force: false })
            copied.push(entry)
        }
        if(!fs.existsSync(targetConfig)) {
            throw new Error(`Brand migration did not copy ${path.join(sourceDirectory, 'config.json')}`)
        }
        return { migrated: true, sourceDirectory, targetDirectory, copied }
    }

    return { migrated: false, reason: 'legacy-config-not-found' }
}

module.exports = { migrateBrandUserData, STATE_ENTRIES }
