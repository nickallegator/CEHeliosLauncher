'use strict'

const path = require('path')
const { spawnSync } = require('child_process')

const root = path.resolve(__dirname, '..')
const dependencies = ['CEhelios-distribution-types', 'CEhelios-core']

function npmInvocation(args, platform = process.platform, commandProcessor = process.env.ComSpec) {
    if(platform === 'win32') {
        return {
            command: commandProcessor || 'cmd.exe',
            args: ['/d', '/s', '/c', 'npm.cmd', ...args]
        }
    }
    return { command: 'npm', args }
}

function run(args, cwd) {
    const invocation = npmInvocation(args)
    const result = spawnSync(invocation.command, invocation.args, { cwd, stdio: 'inherit' })
    if(result.error) throw result.error
    if(result.status !== 0) throw new Error(`npm ${args.join(' ')} failed in ${cwd}`)
}

function main() {
    for(const dependency of dependencies) {
        const cwd = path.join(root, 'deps', dependency)
        run(['ci', '--ignore-scripts'], cwd)
        run(['run', 'build'], cwd)
    }
}

if(require.main === module) main()

module.exports = { main, npmInvocation }
