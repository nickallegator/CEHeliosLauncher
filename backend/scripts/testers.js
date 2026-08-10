'use strict'

const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') })

const store = require('../src/services/store')
const db = require('../src/db')

function parseArgs(argv) {
    const [command, ...rest] = argv.slice(2)
    const args = {}
    for(let index = 0; index < rest.length; index++) {
        const key = rest[index]
        if(!key.startsWith('--')) throw new Error(`Unexpected argument: ${key}`)
        const value = rest[index + 1]
        if(value == null || value.startsWith('--')) throw new Error(`${key} requires a value`)
        args[key.slice(2)] = value
        index++
    }
    return { command, args }
}

async function main() {
    const { command, args } = parseArgs(process.argv)
    if(command === 'add') {
        if(!args.uuid) throw new Error('--uuid is required')
        console.log(JSON.stringify(await store.upsertMinecraftTester(args.uuid, args.label || null), null, 2))
    } else if(command === 'disable') {
        if(!args.uuid) throw new Error('--uuid is required')
        const result = await store.disableMinecraftTester(args.uuid)
        if(!result) throw new Error('Tester UUID was not found')
        console.log(JSON.stringify(result, null, 2))
    } else if(command === 'list') {
        console.table(await store.listMinecraftTesters())
    } else {
        throw new Error('Usage: testers.js <add|disable|list> [--uuid <uuid>] [--label <name>]')
    }
}

main()
    .catch(err => {
        console.error(err.message || err)
        process.exitCode = 1
    })
    .finally(() => db.pool.end())
