const fs = require('fs/promises')
const path = require('path')

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

async function ensureDir(filePath){
    const dir = path.dirname(filePath)
    await fs.mkdir(dir, { recursive: true })
}

async function run(){
    const input = getArgValue('--input')
    const output = getArgValue('--output')
    const mime = getArgValue('--mime', 'image/png')
    if(!input || !output){
        console.error('Usage: node index.js --input <file> --output <file> --width <n> --height <n> --mime image/png --label tiny')
        process.exit(1)
    }
    try {
        await fs.readFile(input, 'utf8')
    } catch (err) {
        console.warn(`[renderer] unable to read input ${input}: ${err.message}`)
    }
    const normalizedMime = String(mime).split(';')[0].trim().toLowerCase()
    const buffer = PLACEHOLDERS[normalizedMime] || PLACEHOLDERS['image/png']
    await ensureDir(output)
    await fs.writeFile(output, buffer)
}

run().catch((err) => {
    console.error('[renderer] failed', err)
    process.exit(1)
})
