'use strict'

const fs = require('fs')
const path = require('path')

function findDependencyDirectory(parentDirectory, dependencyName) {
    let current = path.resolve(parentDirectory)
    while(true){
        const candidate = path.join(current, 'node_modules', ...dependencyName.split('/'))
        if(fs.existsSync(path.join(candidate, 'package.json'))){
            return candidate
        }
        const parent = path.dirname(current)
        if(parent === current){
            return null
        }
        current = parent
    }
}

function buildDependencyTree(packageDirectory, visited = new Set()) {
    const resolvedDirectory = fs.realpathSync(packageDirectory)
    const metadata = JSON.parse(fs.readFileSync(path.join(resolvedDirectory, 'package.json'), 'utf8'))
    const dependencyRanges = {
        ...(metadata.dependencies || {}),
        ...(metadata.optionalDependencies || {})
    }
    const node = {
        name: metadata.name,
        version: metadata.version,
        path: resolvedDirectory,
        _dependencies: dependencyRanges,
        dependencies: {}
    }
    if(visited.has(resolvedDirectory)){
        return node
    }
    visited.add(resolvedDirectory)

    for(const dependencyName of Object.keys(dependencyRanges).sort()){
        const dependencyDirectory = findDependencyDirectory(resolvedDirectory, dependencyName)
        if(dependencyDirectory != null){
            node.dependencies[dependencyName] = buildDependencyTree(dependencyDirectory, visited)
        }
    }
    return node
}

function main(argv) {
    const command = argv[2]
    if(command === 'prefix'){
        console.log(process.cwd())
        return
    }
    if(command === 'config'){
        console.log('node-linker=hoisted')
        return
    }
    if(command === 'list'){
        console.log(JSON.stringify(buildDependencyTree(process.cwd())))
        return
    }
    throw new Error(`Unsupported npm shim command: ${command || '<missing>'}`)
}

if(require.main === module){
    try {
        main(process.argv)
    } catch(err) {
        console.error(err?.message || err)
        process.exitCode = 1
    }
}

module.exports = {
    buildDependencyTree,
    findDependencyDirectory
}
