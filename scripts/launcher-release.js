'use strict'

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const packageMetadata = require('../package.json')

function parseArguments(argv) {
    const result = { command: argv[2] || '' }
    for(let index = 3; index < argv.length; index++) {
        const key = argv[index]
        if(!key.startsWith('--')) throw new Error(`Unexpected argument: ${key}`)
        const value = argv[index + 1]
        if(value == null || value.startsWith('--')) result[key.slice(2)] = true
        else {
            result[key.slice(2)] = value
            index++
        }
    }
    return result
}

function releaseChannel(version) {
    if(/^\d+\.\d+\.\d+-test\.\d+$/.test(version)) return 'test'
    if(/^\d+\.\d+\.\d+$/.test(version)) return 'stable'
    throw new Error(`Unsupported launcher release version: ${version}`)
}

function validateTag(tag, version = packageMetadata.version) {
    const expected = `v${version}`
    if(tag !== expected) throw new Error(`Release tag ${tag || '(missing)'} must equal ${expected}`)
    return expected
}

function assertSigningPolicy(version, env = process.env) {
    if(releaseChannel(version) === 'test') return
    const required = [
        'AG_WINDOWS_PUBLIC_TRUST_SIGNING',
        'AZURE_TENANT_ID',
        'AZURE_CLIENT_ID',
        'AZURE_CLIENT_SECRET',
        'AZURE_ARTIFACT_SIGNING_ENDPOINT',
        'AZURE_ARTIFACT_SIGNING_ACCOUNT',
        'AZURE_ARTIFACT_SIGNING_PROFILE',
        'AZURE_ARTIFACT_SIGNING_PUBLISHER'
    ]
    const missing = required.filter(key => !String(env[key] || '').trim())
    if(env.AG_WINDOWS_PUBLIC_TRUST_SIGNING !== 'true' || missing.length) {
        throw new Error(`Stable launcher releases require Windows Public Trust signing (${missing.join(', ') || 'enable the signing gate'})`)
    }
}

function sha256(filePath) {
    const hash = crypto.createHash('sha256')
    hash.update(fs.readFileSync(filePath))
    return hash.digest('hex')
}

function fileMetadata(filePath) {
    return {
        name: path.basename(filePath),
        sizeBytes: fs.statSync(filePath).size,
        sha256: sha256(filePath)
    }
}

function packageName(packagePath, entry) {
    if(entry.name) return entry.name
    const marker = 'node_modules/'
    const normalized = packagePath.replace(/\\/g, '/')
    const offset = normalized.lastIndexOf(marker)
    return offset === -1 ? normalized : normalized.slice(offset + marker.length)
}

function createSbom(lock) {
    const seen = new Set()
    const components = []
    for(const [packagePath, entry] of Object.entries(lock.packages || {})) {
        if(!packagePath || !entry?.version) continue
        const name = packageName(packagePath, entry)
        const key = `${name}@${entry.version}`
        if(seen.has(key)) continue
        seen.add(key)
        const component = {
            type: 'library',
            'bom-ref': key,
            name,
            version: entry.version,
            scope: entry.dev ? 'optional' : 'required'
        }
        if(entry.license) component.licenses = [{ expression: String(entry.license) }]
        if(String(entry.integrity || '').startsWith('sha512-')) {
            component.hashes = [{
                alg: 'SHA-512',
                content: Buffer.from(String(entry.integrity).slice('sha512-'.length), 'base64').toString('hex')
            }]
        }
        components.push(component)
    }
    components.sort((left, right) => left['bom-ref'].localeCompare(right['bom-ref']))
    return {
        bomFormat: 'CycloneDX',
        specVersion: '1.6',
        serialNumber: `urn:uuid:${crypto.createHash('sha256').update(`${packageMetadata.version}\n${JSON.stringify(lock.packages || {})}`).digest('hex').replace(/^(........)(....)(....)(....)(............).*$/, '$1-$2-$3-$4-$5')}`,
        version: 1,
        metadata: {
            component: {
                type: 'application',
                name: packageMetadata.productName,
                version: packageMetadata.version
            }
        },
        components
    }
}

function latestVersion(latestPath) {
    const match = fs.readFileSync(latestPath, 'utf8').match(/^version:\s*['"]?([^'"\s]+)['"]?\s*$/m)
    return match?.[1] || null
}

function expectedArtifactNames(version) {
    const installer = `AG-Launcher-Test-setup-${version}.exe`
    return [installer, `${installer}.blockmap`, 'latest.yml', 'bom.cdx.json', 'RELEASE_NOTES.md', 'launcher-release.json']
}

function prepare(options) {
    const version = packageMetadata.version
    const tag = validateTag(options.tag || process.env.RELEASE_TAG, version)
    const channel = releaseChannel(version)
    assertSigningPolicy(version)
    const directory = path.resolve(options.dir || path.join(root, 'dist', 'channel-output'))
    const notesSource = path.resolve(options.notes || path.join(root, 'docs', 'releases', `${version}.md`))
    const [installer, blockmap, latestName] = expectedArtifactNames(version)
    for(const name of [installer, blockmap, latestName]) {
        if(!fs.existsSync(path.join(directory, name))) throw new Error(`Required release artifact is missing: ${name}`)
    }
    if(latestVersion(path.join(directory, latestName)) !== version) throw new Error('latest.yml version does not match package.json')
    if(!fs.existsSync(notesSource)) throw new Error(`Release notes are missing: ${notesSource}`)

    fs.copyFileSync(notesSource, path.join(directory, 'RELEASE_NOTES.md'))
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'))
    fs.writeFileSync(path.join(directory, 'bom.cdx.json'), `${JSON.stringify(createSbom(lock), null, 2)}\n`, 'utf8')

    const descriptor = {
        schemaVersion: 1,
        product: packageMetadata.productName,
        version,
        tag,
        channel,
        repository: 'nickallegator/CEHeliosLauncher',
        unsignedTestBuild: channel === 'test',
        artifacts: [installer, blockmap, latestName]
    }
    fs.writeFileSync(path.join(directory, 'launcher-release.json'), `${JSON.stringify(descriptor, null, 2)}\n`, 'utf8')

    const manifestEntries = expectedArtifactNames(version)
        .map(name => fileMetadata(path.join(directory, name)))
        .sort((left, right) => left.name.localeCompare(right.name))
    fs.writeFileSync(
        path.join(directory, 'SHA256SUMS.txt'),
        `${manifestEntries.map(entry => `${entry.sha256}  ${entry.name}`).join('\n')}\n`,
        'utf8'
    )
    return { directory, descriptor, manifestEntries }
}

function parseChecksumManifest(contents) {
    const entries = new Map()
    for(const line of contents.split(/\r?\n/).filter(Boolean)) {
        const match = line.match(/^([a-f0-9]{64}) {2}([^/\\]+)$/)
        if(!match) throw new Error(`Invalid SHA-256 manifest line: ${line}`)
        if(entries.has(match[2])) throw new Error(`Duplicate SHA-256 manifest entry: ${match[2]}`)
        entries.set(match[2], match[1])
    }
    return entries
}

function verify(options) {
    const directory = path.resolve(options.dir || path.join(root, 'dist', 'channel-output'))
    const manifestPath = path.join(directory, 'SHA256SUMS.txt')
    if(!fs.existsSync(manifestPath)) throw new Error('SHA256SUMS.txt is missing')
    const descriptor = JSON.parse(fs.readFileSync(path.join(directory, 'launcher-release.json'), 'utf8'))
    validateTag(options.tag || process.env.RELEASE_TAG, descriptor.version)
    if(descriptor.version !== packageMetadata.version) throw new Error('Release descriptor does not match package.json')
    if(latestVersion(path.join(directory, 'latest.yml')) !== descriptor.version) throw new Error('latest.yml does not match the release descriptor')
    const entries = parseChecksumManifest(fs.readFileSync(manifestPath, 'utf8'))
    const expected = expectedArtifactNames(descriptor.version)
    if(entries.size !== expected.length || expected.some(name => !entries.has(name))) throw new Error('SHA-256 manifest does not contain the exact release artifact set')
    for(const [name, expectedHash] of entries) {
        const target = path.join(directory, name)
        if(!fs.existsSync(target) || sha256(target) !== expectedHash) throw new Error(`Release artifact checksum mismatch: ${name}`)
    }
    return { directory, descriptor, artifactCount: entries.size }
}

function main() {
    const options = parseArguments(process.argv)
    const result = options.command === 'prepare'
        ? prepare(options)
        : options.command === 'verify'
            ? verify(options)
            : (() => { throw new Error('Usage: launcher-release.js prepare|verify --tag v<version> [--dir <path>]') })()
    console.log(`${options.command === 'prepare' ? 'Prepared' : 'Verified'} ${result.descriptor.tag} in ${result.directory}`)
}

if(require.main === module) {
    try { main() } catch(error) {
        console.error(error.message || error)
        process.exitCode = 1
    }
}

module.exports = {
    assertSigningPolicy,
    createSbom,
    expectedArtifactNames,
    latestVersion,
    parseArguments,
    parseChecksumManifest,
    prepare,
    releaseChannel,
    validateTag,
    verify
}
