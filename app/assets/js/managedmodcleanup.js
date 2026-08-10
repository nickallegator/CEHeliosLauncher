'use strict'

const fs = require('fs')
const path = require('path')

const COBBLE_POWER_JAR = /^cobblepower-.+\.jar$/i

function assertContained(root, candidate) {
    const resolvedRoot = path.resolve(root)
    const resolved = path.resolve(candidate)
    if(resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
        throw new Error(`Managed mod cleanup path escapes ${resolvedRoot}`)
    }
    return resolved
}

function quarantineManagedDropins(instanceDirectory, serverId, minecraftVersion, now = Date.now()) {
    const instanceRoot = assertContained(instanceDirectory, path.join(instanceDirectory, serverId))
    const modsRoot = assertContained(instanceRoot, path.join(instanceRoot, 'mods'))
    const candidates = [modsRoot, path.join(modsRoot, minecraftVersion)]
    const quarantineRoot = path.join(modsRoot, '.cobblepower-superseded')
    const moved = []
    for(const directory of candidates) {
        if(!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) continue
        for(const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            if(!entry.isFile() || !COBBLE_POWER_JAR.test(entry.name)) continue
            const source = assertContained(modsRoot, path.join(directory, entry.name))
            fs.mkdirSync(quarantineRoot, { recursive: true })
            const relative = path.relative(modsRoot, source).replace(/[\\/]/g, '_')
            let destination = path.join(quarantineRoot, `${now}-${relative}`)
            let suffix = 1
            while(fs.existsSync(destination)) destination = path.join(quarantineRoot, `${now}-${suffix++}-${relative}`)
            fs.renameSync(source, destination)
            moved.push({ source, destination })
        }
    }
    return moved
}

module.exports = { COBBLE_POWER_JAR, assertContained, quarantineManagedDropins }
