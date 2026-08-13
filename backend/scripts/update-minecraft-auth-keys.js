'use strict'

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const PUBLIC_KEYS_URL = 'https://api.minecraftservices.com/publickeys'
const outputPath = path.resolve(__dirname, '..', 'config', 'minecraft-auth-keys.json')
const checkOnly = process.argv.includes('--check')

function validateKeys(values) {
    if(!Array.isArray(values) || values.length === 0 || values.length > 8) {
        throw new Error('Minecraft public-key response did not contain a valid authenticationKeys array.')
    }
    return values.map((entry, index) => {
        const encoded = String(entry?.publicKey || '').trim()
        const key = crypto.createPublicKey({ key: Buffer.from(encoded, 'base64'), format: 'der', type: 'spki' })
        if(key.asymmetricKeyType !== 'rsa') throw new Error(`Authentication key ${index} is not RSA.`)
        return encoded
    })
}

async function main() {
    const response = await fetch(PUBLIC_KEYS_URL, {
        headers: { Accept: 'application/json', 'User-Agent': 'AG-Launcher-Key-Updater/1.0' },
        signal: AbortSignal.timeout(15_000)
    })
    if(!response.ok) throw new Error(`Minecraft public-key request failed with HTTP ${response.status}.`)
    const keys = validateKeys((await response.json()).authenticationKeys)
    const existing = JSON.parse(fs.readFileSync(outputPath, 'utf8'))
    if(JSON.stringify(existing.authenticationKeys) === JSON.stringify(keys)) {
        console.log(`Minecraft authentication keys are current (${keys.length} keys).`)
        return
    }
    if(checkOnly) {
        throw new Error('Minecraft authentication keys have rotated; run npm run minecraft-keys:update and deploy the reviewed change.')
    }
    const document = {
        schemaVersion: 1,
        source: PUBLIC_KEYS_URL,
        fetchedAt: new Date().toISOString(),
        authenticationKeys: keys
    }
    const temporaryPath = `${outputPath}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    fs.renameSync(temporaryPath, outputPath)
    console.log(`Updated ${outputPath} with ${keys.length} Minecraft authentication keys.`)
}

main().catch(error => {
    console.error(error.message)
    process.exitCode = 1
})
