'use strict'

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const root = path.resolve(__dirname, '..')
const dependencies = [
    {
        name: 'CEhelios-core',
        url: 'https://github.com/nickallegator/CEhelios-core.git',
        ref: 'launcher-pinned-neoforge',
        commit: '56b2d9782761aa7d9d646b7eca5a13573592c2a8',
        patch: path.join(root, 'patches', 'helios-core-private-url-redaction.patch')
    },
    {
        name: 'CEhelios-distribution-types',
        url: 'https://github.com/nickallegator/CEhelios-distribution-types.git',
        ref: 'launcher-pinned-neoforge',
        commit: 'eaf83367c0d830fb2ec735291d043626c48712c3'
    }
]

function git(args, cwd = root, allowFailure = false) {
    const result = spawnSync('git', args, { cwd, stdio: allowFailure ? 'pipe' : 'inherit', encoding: 'utf8' })
    if(result.error) throw result.error
    if(result.status !== 0 && !allowFailure) throw new Error(`git ${args.join(' ')} exited with ${result.status}`)
    return result
}

function bootstrapDependency(dependency) {
    const target = path.join(root, 'deps', dependency.name)
    if(!fs.existsSync(path.join(target, '.git'))) {
        fs.mkdirSync(path.dirname(target), { recursive: true })
        git(['clone', '--branch', dependency.ref, '--no-checkout', dependency.url, target])
        git(['checkout', dependency.commit], target)
    }
    const current = git(['rev-parse', 'HEAD'], target, true).stdout.trim()
    if(!current.startsWith(dependency.commit)) {
        throw new Error(`${dependency.name} is at ${current}; expected ${dependency.commit}. Preserve local work, then reconcile it manually.`)
    }
    if(dependency.patch) {
        const check = git(['apply', '--check', dependency.patch], target, true)
        if(check.status === 0) git(['apply', dependency.patch], target)
        else {
            const reverse = git(['apply', '--reverse', '--check', dependency.patch], target, true)
            if(reverse.status !== 0) throw new Error(`${dependency.name} does not accept the required launcher patch`)
        }
    }
    console.log(`Ready: ${dependency.name} @ ${current.slice(0, 12)}`)
}

for(const dependency of dependencies) bootstrapDependency(dependency)
