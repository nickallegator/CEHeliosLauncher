'use strict'

const path = require('path')
const { prepareRelease } = require('./lib/release-publisher')

function parseArgs(argv) {
    const command = argv[2]
    const args = {}
    for(let index = 3; index < argv.length; index++) {
        const token = argv[index]
        if(!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`)
        const next = argv[index + 1]
        if(next == null || next.startsWith('--')) args[token.slice(2)] = true
        else { args[token.slice(2)] = next; index++ }
    }
    return { command, args }
}

function required(args, key) {
    const value = String(args[key] || '').trim()
    if(!value) throw new Error(`--${key} is required`)
    return value
}

async function main(argv = process.argv) {
    const { command, args } = parseArgs(argv)
    if(command === 'prepare') {
        const result = await prepareRelease({
            modPath: required(args, 'mod'),
            modVersion: required(args, 'mod-version'),
            packVersion: required(args, 'pack-version'),
            sourceRepository: required(args, 'source-repository'),
            sourceTag: required(args, 'source-tag'),
            sourceCommit: required(args, 'source-commit'),
            sourceRepo: args['source-repo'] ? path.resolve(args['source-repo']) : null,
            releaseId: args['release-id'],
            expectedPreviousReleaseId: args['expected-previous'],
            outputDir: args.output,
            createdAt: args['created-at']
        })
        console.log(`Prepared ${result.state.releaseId} at ${result.outputDir}`)
        return result
    }

    const remote = require('./lib/release-remote')
    if(command === 'publish') {
        const state = await remote.publishPrepared(required(args, 'prepared'))
        console.log(`Published immutable objects for ${state.releaseId}`)
        return state
    }
    if(command === 'promote' || command === 'rollback') {
        const result = await remote.promoteRelease({
            releaseId: required(args, 'release-id'),
            channel: args.channel || 'test',
            expectedPreviousReleaseId: args['expected-previous'] || null
        })
        console.log(`${command === 'rollback' ? 'Rolled back' : 'Promoted'} ${result.releaseId}`)
        return result
    }
    if(command === 'verify') {
        const result = args['release-id']
            ? await remote.verifyRelease(args['release-id'], args.channel || 'test')
            : await remote.verifyCurrent(args.channel || 'test')
        console.log(`Verified ${result.releaseId}`)
        return result
    }
    if(command === 'current') {
        const result = await remote.getCurrentRelease(args.channel || 'test')
        if(args.json) console.log(JSON.stringify(result))
        else console.log(result.releaseId || '<none>')
        return result
    }
    throw new Error('Usage: release-publisher.js <prepare|publish|promote|verify|rollback|current> [options]')
}

if(require.main === module) {
    main().catch(err => {
        console.error(err.stack || err)
        process.exitCode = 1
    })
}

module.exports = { main, parseArgs }
