'use strict'

const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') })

const store = require('../src/services/store')
const { pool } = require('../src/db')

function argument(name) {
    const index = process.argv.indexOf(`--${name}`)
    return index >= 0 ? process.argv[index + 1] : null
}

async function run() {
    const command = process.argv[2]
    if(command === 'grant') {
        const row = await store.grantMinecraftEntitlement(argument('uuid'), argument('entitlement'), argument('label'))
        console.log(JSON.stringify(row, null, 2))
    } else if(command === 'revoke') {
        const row = await store.revokeMinecraftEntitlement(argument('uuid'), argument('entitlement'))
        console.log(JSON.stringify(row, null, 2))
    } else if(command === 'list') {
        console.log(JSON.stringify(await store.listMinecraftEntitlementGrants(argument('entitlement')), null, 2))
    } else {
        throw new Error('Usage: entitlements.js <grant|revoke|list> [--uuid <uuid>] [--entitlement <value>] [--label <name>]')
    }
}

run().catch(error => {
    console.error(error.message || error)
    process.exitCode = 1
}).finally(() => pool.end())
