'use strict'

const path = require('path')
const { spawnSync } = require('child_process')

console.warn('[db:setup] schema.sql is deprecated; applying the authoritative migration chain.')
const result = spawnSync(process.execPath, [path.resolve(__dirname, 'db-migrate.js')], {
    stdio: 'inherit',
    env: process.env
})
if(result.error) throw result.error
process.exitCode = result.status || 0
