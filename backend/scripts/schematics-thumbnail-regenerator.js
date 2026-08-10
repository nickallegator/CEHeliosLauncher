const crypto = require('crypto')
const fs = require('fs/promises')
const path = require('path')
const os = require('os')
const { spawn } = require('child_process')

const DEFAULT_SIZES = {
    tiny: 128,
    small: 128,
    medium: 512,
    thumb: 256
}

const PLACEHOLDERS = {
    'image/png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=', 'base64'),
    'image/jpeg': Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAALCAABAAEBAREA/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAGf/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9k=', 'base64'),
    'image/webp': Buffer.from('UklGRiIAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAQAcJaQAA3AA/vuUAAA=', 'base64')
}

function getArgValue(flag, fallback = null){
    const idx = process.argv.indexOf(flag)
    if(idx === -1 || idx + 1 >= process.argv.length){
        return fallback
    }
    return process.argv[idx + 1]
}

function parseList(value){
    if(!value){
        return []
    }
    return String(value).split(',').map(item => item.trim()).filter(Boolean)
}

function parseBool(value, fallback = false){
    if(value == null){
        return fallback
    }
    if(typeof value === 'boolean'){
        return value
    }
    const normalized = String(value).trim().toLowerCase()
    if(['1', 'true', 'yes', 'y'].includes(normalized)){
        return true
    }
    if(['0', 'false', 'no', 'n'].includes(normalized)){
        return false
    }
    return fallback
}

function parseNumber(value, fallback){
    const n = Number.parseInt(value, 10)
    return Number.isFinite(n) ? n : fallback
}

function normalizeMime(value){
    if(!value){
        return null
    }
    return String(value).split(';')[0].trim().toLowerCase() || null
}

function buildSizeMap(rawSizes){
    const map = { ...DEFAULT_SIZES }
    for(const entry of rawSizes){
        const [label, size] = entry.split('=')
        if(!label || !size){
            continue
        }
        const sizeNum = Number(size)
        if(Number.isFinite(sizeNum) && sizeNum > 0){
            map[label.trim().toLowerCase()] = sizeNum
        }
    }
    return map
}

async function sleep(ms){
    return new Promise((resolve) => setTimeout(resolve, ms))
}

async function callRenderer(rendererPath, inputPath, outputPath, options){
    if(!rendererPath){
        return false
    }
    const args = [
        rendererPath,
        '--input', inputPath,
        '--output', outputPath,
        '--width', String(options.width),
        '--height', String(options.height),
        '--mime', options.mime,
        '--label', options.label
    ]
    return new Promise((resolve) => {
        const child = spawn('node', args, { stdio: 'inherit' })
        child.on('exit', (code) => resolve(code === 0))
        child.on('error', () => resolve(false))
    })
}

async function fetchJson(url, options){
    const res = await fetch(url, options)
    if(!res.ok){
        const text = await res.text().catch(() => '')
        throw new Error(`Request failed ${res.status}: ${text}`)
    }
    return res.json()
}

async function getSchematicPayload(baseUrl, token, id){
    const res = await fetch(`${baseUrl}/v1/schematics/${encodeURIComponent(id)}`, {
        headers: {
            'Accept': 'application/json',
            Authorization: `Bearer ${token}`
        }
    })
    if(!res.ok){
        throw new Error(`Failed to fetch schematic ${id} (${res.status})`)
    }
    const json = await res.json()
    if(json?.schematic){
        return json.schematic
    }
    if(json?.schematicUrl){
        const signed = await fetch(json.schematicUrl)
        if(!signed.ok){
            throw new Error(`Failed to fetch schematic blob ${id} (${signed.status})`)
        }
        return signed.json()
    }
    throw new Error(`No schematic payload for ${id}`)
}

async function uploadThumbnail(uploadUrl, mime, buffer){
    const res = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
            'Content-Type': mime
        },
        body: buffer
    })
    if(!res.ok){
        throw new Error(`Upload failed (${res.status})`)
    }
}

async function commitThumbnail(baseUrl, token, id, payload){
    const res = await fetch(`${baseUrl}/v1/schematics/${encodeURIComponent(id)}/thumbnail/commit`, {
        method: 'POST',
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(payload)
    })
    if(!res.ok){
        const text = await res.text().catch(() => '')
        throw new Error(`Commit failed (${res.status}): ${text}`)
    }
}

async function run(){
    const baseUrl = (getArgValue('--base-url', process.env.SCHEMATICS_API_BASE || '') || '').replace(/\/+$/, '')
    const token = getArgValue('--token', process.env.SCHEMATICS_ADMIN_TOKEN || '')
    const rendererPath = getArgValue('--renderer', process.env.SCHEMATICS_THUMBNAIL_RENDERER || '')
    const labels = parseList(getArgValue('--labels', process.env.SCHEMATICS_THUMBNAIL_LABELS || 'tiny,medium'))
    const mimes = parseList(getArgValue('--mimes', process.env.SCHEMATICS_THUMBNAIL_MIMES || 'image/webp,image/png'))
    const ids = parseList(getArgValue('--ids', process.env.SCHEMATICS_THUMBNAIL_IDS || ''))
    const limit = parseNumber(getArgValue('--limit', process.env.SCHEMATICS_THUMBNAIL_LIMIT || '25'), 25)
    const offset = parseNumber(getArgValue('--offset', process.env.SCHEMATICS_THUMBNAIL_OFFSET || '0'), 0)
    const includeExisting = parseBool(getArgValue('--include-existing', process.env.SCHEMATICS_THUMBNAIL_INCLUDE_EXISTING), false)
    const verifyObjects = parseBool(getArgValue('--verify-objects', process.env.SCHEMATICS_THUMBNAIL_VERIFY_OBJECTS), true)
    const repair = parseBool(getArgValue('--repair', process.env.SCHEMATICS_THUMBNAIL_REPAIR), true)
    const rawSizes = parseList(getArgValue('--sizes', process.env.SCHEMATICS_THUMBNAIL_SIZES || ''))
    const sizeMap = buildSizeMap(rawSizes)

    if(!baseUrl){
        console.error('Missing --base-url (or SCHEMATICS_API_BASE).')
        process.exit(1)
    }
    if(!token){
        console.error('Missing --token (or SCHEMATICS_ADMIN_TOKEN).')
        process.exit(1)
    }

    const requestBody = {
        ids: ids.length > 0 ? ids : undefined,
        limit,
        offset,
        labels,
        mimes,
        includeExisting,
        verifyObjects,
        repair
    }

    console.log(`[regen] requesting batch (ids=${ids.length}, limit=${limit}, offset=${offset})`)
    const batch = await fetchJson(`${baseUrl}/v1/schematics/thumbnails/regenerate`, {
        method: 'POST',
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(requestBody)
    })

    const items = Array.isArray(batch?.items) ? batch.items : []
    if(items.length === 0){
        console.log('[regen] nothing to regenerate.')
        return
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cehelios-thumbs-'))
    const summary = {
        regenerated: 0,
        skipped: 0,
        failed: 0
    }

    try {
        for(const entry of items){
            const id = entry.id
            const missing = Array.isArray(entry.missing) ? entry.missing : []
            if(missing.length === 0){
                continue
            }
            let schematic
            try {
                schematic = await getSchematicPayload(baseUrl, token, id)
            } catch (err) {
                console.warn(`[regen] unable to fetch schematic ${id}: ${err.message}`)
                summary.failed += missing.length
                continue
            }

            const inputPath = path.join(tempDir, `${id}.json`)
            await fs.writeFile(inputPath, JSON.stringify(schematic), 'utf8')

            for(const thumb of missing){
                const label = String(thumb.label || 'medium').toLowerCase()
                const mime = normalizeMime(thumb.mime) || 'image/png'
                const size = sizeMap[label] || 256
                const outputPath = path.join(tempDir, `${id}-${label}-${crypto.randomUUID()}`)

                let buffer = null
                let rendered = false
                if(rendererPath){
                    const ok = await callRenderer(rendererPath, inputPath, outputPath, {
                        label,
                        mime,
                        width: size,
                        height: size
                    })
                    if(ok){
                        try {
                            buffer = await fs.readFile(outputPath)
                            rendered = true
                        } catch (err) {
                            buffer = null
                        }
                    }
                }

                if(!buffer){
                    const placeholder = PLACEHOLDERS[mime] || PLACEHOLDERS['image/png']
                    buffer = placeholder
                }

                try {
                    if(thumb.uploadUrl){
                        await uploadThumbnail(thumb.uploadUrl, mime, buffer)
                        await commitThumbnail(baseUrl, token, id, {
                            label,
                            mime,
                            objectKey: thumb.objectKey,
                            width: size,
                            height: size,
                            sizeBytes: buffer.length
                        })
                    } else {
                        await commitThumbnail(baseUrl, token, id, {
                            label,
                            mime,
                            data: buffer.toString('base64'),
                            width: size,
                            height: size,
                            sizeBytes: buffer.length
                        })
                    }
                    summary.regenerated += 1
                    console.log(`[regen] ${id} ${label} ${mime} ${rendered ? 'rendered' : 'placeholder'}`)
                } catch (err) {
                    summary.failed += 1
                    console.warn(`[regen] failed ${id} ${label}: ${err.message}`)
                    await sleep(50)
                }
            }
        }
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true })
    }

    console.log(`[regen] done. regenerated=${summary.regenerated} failed=${summary.failed} skipped=${summary.skipped}`)
    if(summary.failed > 0){
        process.exitCode = 2
    }
}

run().catch((err) => {
    console.error('[regen] fatal', err)
    process.exit(1)
})
