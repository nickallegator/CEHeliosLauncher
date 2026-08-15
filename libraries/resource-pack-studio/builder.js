'use strict'

const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const zlib = require('zlib')
const yauzl = require('yauzl')
const yazl = require('yazl')

const { MAX_ENTRIES, MAX_ENTRY_BYTES, MAX_EXPANDED_BYTES, normalizeEntryPath, sha256, stableJson } = require('./index')

const MAX_COMPRESSED_BYTES = 100 * 1024 * 1024
const FIXED_DATE = new Date('2000-01-01T00:00:00.000Z')
const COMPOSITION_GRANT = `AG Pack Studio Composition Grant 1.0

The publisher granted recipients permission to copy unchanged resources from the opted-in revision and perform the mechanical JSON aggregation needed for Pack Studio Resource Packs. Creator attribution, original licenses, and third-party notices must be retained. Copyright and all rights not expressly granted remain with their owners.

THE MATERIAL IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
`

function crc32(buffer) {
    let crc = 0xffffffff
    for(const byte of buffer) {
        crc ^= byte
        for(let index = 0; index < 8; index++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
    }
    return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
    const name = Buffer.from(type, 'ascii')
    const output = Buffer.alloc(12 + data.length)
    output.writeUInt32BE(data.length, 0)
    name.copy(output, 4)
    data.copy(output, 8)
    output.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length)
    return output
}

function projectIcon(project) {
    const width = 64
    const height = 64
    const digest = crypto.createHash('sha256').update(JSON.stringify(stableJson(project))).digest()
    const raw = Buffer.alloc((width * 4 + 1) * height)
    for(let y = 0; y < height; y++) {
        const row = y * (width * 4 + 1)
        raw[row] = 0
        for(let x = 0; x < width; x++) {
            const tile = ((x >> 3) + (y >> 3) * 8) % digest.length
            const base = row + 1 + x * 4
            raw[base] = 38 + digest[tile] % 76
            raw[base + 1] = 72 + digest[(tile + 7) % digest.length] % 112
            raw[base + 2] = 62 + digest[(tile + 13) % digest.length] % 102
            raw[base + 3] = 255
        }
    }
    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
    ihdr[8] = 8; ihdr[9] = 6
    return Buffer.concat([
        Buffer.from([137,80,78,71,13,10,26,10]),
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
        pngChunk('IEND', Buffer.alloc(0))
    ])
}

function openZip(filePath) {
    return new Promise((resolve, reject) => yauzl.open(filePath, {
        lazyEntries: true,
        autoClose: false,
        decodeStrings: true,
        validateEntrySizes: true
    }, (error, zip) => error ? reject(error) : resolve(zip)))
}

function zipEntryIsDirectory(entry) {
    const name = String(entry?.fileName || '').replaceAll('\\', '/')
    const attributes = Number(entry?.externalFileAttributes || 0) >>> 0
    const unixType = (attributes >>> 16) & 0xf000
    const dosDirectory = (attributes & 0x10) !== 0
    return name.endsWith('/') || unixType === 0x4000 || dosDirectory
}

async function extractRevision(source, sourceFile, requests, directory, signal) {
    const zip = await openZip(sourceFile)
    const wanted = new Map(requests.map(request => [request.sourcePath.toLowerCase(), request]))
    try {
        await new Promise((resolve, reject) => {
            zip.on('error', reject)
            zip.on('end', resolve)
            zip.on('entry', entry => {
                try {
                    if(signal?.aborted) throw Object.assign(new Error('Pack Studio build was cancelled.'), { code: 'aborted' })
                    // Directory records are normal in Resource Pack ZIPs and
                    // carry no data into a composed output. Validating them as
                    // file paths would reject their required trailing slash.
                    if(zipEntryIsDirectory(entry)) { zip.readEntry(); return }
                    const entryPath = normalizeEntryPath(entry.fileName)
                    const request = wanted.get(entryPath.toLowerCase())
                    if(!request) { zip.readEntry(); return }
                    if(entry.uncompressedSize > MAX_ENTRY_BYTES) throw new Error(`${entryPath} exceeds the output entry limit.`)
                    zip.openReadStream(entry, (error, stream) => {
                        if(error) { reject(error); return }
                        const destination = path.join(directory, sha256(Buffer.from(`${source.revisionId}:${request.targetPath}`)))
                        const hash = crypto.createHash('sha256')
                        const output = fs.createWriteStream(destination, { flags: 'wx' })
                        let total = 0
                        stream.on('data', chunk => { total += chunk.length; hash.update(chunk) })
                        stream.on('error', reject)
                        output.on('error', reject)
                        output.on('finish', () => {
                            if(hash.digest('hex') !== request.sha256) { reject(new Error(`Checksum mismatch for ${entryPath}.`)); return }
                            request.extractedPath = destination
                            request.sizeBytes = total
                            wanted.delete(entryPath.toLowerCase())
                            zip.readEntry()
                        })
                        stream.pipe(output)
                    })
                } catch(error) { reject(error) }
            })
            zip.readEntry()
        })
    } finally { zip.close() }
    if(wanted.size) throw new Error(`Source revision ${source.revisionId} is missing ${[...wanted.keys()][0]}.`)
}

function credits(project, sources) {
    const lines = [`# ${project.name}`, '', 'Generated by AG Launcher Pack Studio.', '', '## Sources', '']
    for(const source of [...sources].sort((a, b) => a.title.localeCompare(b.title))) {
        lines.push(`- ${source.title} by ${source.creator} — ${source.license} — revision ${source.revisionId}`)
    }
    lines.push('', 'Each included resource remains subject to its source license and the AG Pack Studio Composition Grant 1.0.', '')
    return Buffer.from(lines.join('\n'), 'utf8')
}

function licenseNotice(source) {
    return Buffer.from([
        `Source: ${source.title}`,
        `Creator: ${source.creator}`,
        `Community item: ${source.itemId}`,
        `Revision: ${source.revisionId}`,
        `License: ${source.license}`,
        '',
        'This source was included under its original license and the AG Pack Studio Composition Grant 1.0.',
        ''
    ].join('\n'), 'utf8')
}

async function buildPack({ project, resolution, sourceFiles, outputPath, signal, onProgress = () => {} }) {
    if(resolution?.plan?.conflicts?.length) throw Object.assign(new Error('Resolve every Pack Studio conflict before building.'), { code: 'unresolved_conflicts' })
    const sources = resolution?.sources || []
    const sourceMap = new Map(sources.map(source => [String(source.revisionId), source]))
    const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ag-pack-studio-build-'))
    const temporaryOutput = `${path.resolve(outputPath)}.${process.pid}.${crypto.randomUUID()}.tmp`
    try {
        const files = resolution.plan.outputFiles.map(value => ({ ...value }))
        const grouped = new Map()
        for(const file of files) {
            const entries = grouped.get(String(file.sourceRevisionId)) || []
            entries.push(file); grouped.set(String(file.sourceRevisionId), entries)
        }
        let extracted = 0
        for(const [revisionId, requests] of grouped) {
            const source = sourceMap.get(revisionId)
            const sourceFile = sourceFiles[revisionId]
            if(!source || !sourceFile) throw new Error(`Pack Studio source ${revisionId} is not cached.`)
            await extractRevision(source, sourceFile, requests, tempRoot, signal)
            extracted += requests.length
            onProgress({ stage: 'extracting', completed: extracted, total: files.length })
        }

        const manifest = {
            schemaVersion: 1,
            projectId: project.id,
            projectName: project.name,
            selections: project.selections,
            conflictResolutions: project.conflictResolutions || {},
            sources: sources.map(({ downloadUrl: _downloadUrl, ...source }) => source)
        }
        const generated = [
            { path: 'pack.mcmeta', bytes: Buffer.from(`${JSON.stringify({ pack: { pack_format: 34, description: `AG Pack Studio: ${project.name}` } }, null, 2)}\n`) },
            { path: 'pack.png', bytes: projectIcon(project) },
            { path: 'CREDITS.md', bytes: credits(project, sources) },
            { path: 'ag-pack-studio.json', bytes: Buffer.from(`${JSON.stringify(stableJson(manifest), null, 2)}\n`) },
            { path: 'ag-licenses/AG-Pack-Studio-Composition-Grant-1.0.txt', bytes: Buffer.from(COMPOSITION_GRANT, 'utf8') },
            ...sources.map(source => ({ path: `ag-licenses/${source.itemId}/${source.revisionId}/${source.license}.txt`, bytes: licenseNotice(source) })),
            ...(resolution.plan.synthesized || []).map(value => ({ path: value.targetPath, bytes: Buffer.from(`${JSON.stringify(stableJson(value.value), null, 2)}\n`) }))
        ]
        const entries = [
            ...files.map(file => ({ path: file.targetPath, filePath: file.extractedPath, sizeBytes: file.sizeBytes })),
            ...generated.map(value => ({ ...value, sizeBytes: value.bytes.length }))
        ].sort((a, b) => a.path.localeCompare(b.path))
        if(entries.length > MAX_ENTRIES) throw new Error('Generated Resource Pack exceeds the entry limit.')
        const expandedBytes = entries.reduce((sum, entry) => sum + entry.sizeBytes, 0)
        if(expandedBytes > MAX_EXPANDED_BYTES) throw new Error('Generated Resource Pack exceeds the expanded size limit.')
        fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true })
        const archive = new yazl.ZipFile()
        const output = fs.createWriteStream(temporaryOutput, { flags: 'wx' })
        const completion = new Promise((resolve, reject) => {
            output.on('finish', resolve); output.on('error', reject); archive.outputStream.on('error', reject)
        })
        archive.outputStream.pipe(output)
        for(const entry of entries) {
            const safePath = normalizeEntryPath(entry.path)
            const options = { mtime: FIXED_DATE, mode: 0o100644, compress: true }
            if(entry.filePath) archive.addFile(entry.filePath, safePath, options)
            else archive.addBuffer(entry.bytes, safePath, options)
        }
        archive.end({ forceZip64Format: false })
        await completion
        const stat = fs.statSync(temporaryOutput)
        if(stat.size > MAX_COMPRESSED_BYTES) throw new Error('Generated Resource Pack exceeds the compressed size limit.')
        const digest = await new Promise((resolve, reject) => {
            const hash = crypto.createHash('sha256'); const stream = fs.createReadStream(temporaryOutput)
            stream.on('data', chunk => hash.update(chunk)); stream.on('error', reject); stream.on('end', () => resolve(hash.digest('hex')))
        })
        const destination = path.resolve(outputPath)
        const backup = `${destination}.${process.pid}.${crypto.randomUUID()}.bak`
        const hadDestination = fs.existsSync(destination)
        if(hadDestination) fs.renameSync(destination, backup)
        try {
            fs.renameSync(temporaryOutput, destination)
            if(hadDestination) fs.rmSync(backup, { force: true })
        } catch(error) {
            if(fs.existsSync(destination)) fs.rmSync(destination, { force: true })
            if(hadDestination && fs.existsSync(backup)) fs.renameSync(backup, destination)
            throw error
        }
        onProgress({ stage: 'complete', completed: entries.length, total: entries.length })
        return { outputPath: path.resolve(outputPath), sha256: digest, sizeBytes: stat.size, expandedBytes, entryCount: entries.length }
    } finally {
        fs.rmSync(temporaryOutput, { force: true })
        await fs.promises.rm(tempRoot, { recursive: true, force: true })
    }
}

module.exports = { COMPOSITION_GRANT, MAX_COMPRESSED_BYTES, buildPack, credits, licenseNotice, projectIcon, zipEntryIsDirectory }
