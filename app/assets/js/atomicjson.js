'use strict'

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

function writeJsonAtomic(filePath, value, options = {}) {
    const fileSystem = options.fileSystem || fs
    const resolved = path.resolve(filePath)
    fileSystem.mkdirSync(path.dirname(resolved), { recursive: true })
    const temporaryPath = `${resolved}.${process.pid}.${crypto.randomUUID()}.tmp`
    try {
        fileSystem.writeFileSync(temporaryPath, JSON.stringify(value, null, 4), 'utf8')
        if(options.beforeCommit) options.beforeCommit(temporaryPath, resolved)
        fileSystem.renameSync(temporaryPath, resolved)
    } finally {
        if(fileSystem.existsSync(temporaryPath)) fileSystem.rmSync(temporaryPath, { force: true })
    }
    return resolved
}

module.exports = { writeJsonAtomic }
