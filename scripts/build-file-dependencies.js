'use strict'

const path = require('path')
const { spawnSync } = require('child_process')

const root = path.resolve(__dirname, '..')
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const dependencies = ['CEhelios-distribution-types', 'CEhelios-core']

function run(args, cwd) {
    const result = spawnSync(npmCommand, args, { cwd, stdio: 'inherit' })
    if(result.error) throw result.error
    if(result.status !== 0) throw new Error(`${npmCommand} ${args.join(' ')} failed in ${cwd}`)
}

for(const dependency of dependencies) {
    const cwd = path.join(root, 'deps', dependency)
    run(['ci', '--ignore-scripts'], cwd)
    run(['run', 'build'], cwd)
}
