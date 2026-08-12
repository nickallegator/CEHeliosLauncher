'use strict'

const sharp = require('sharp')
const { CommunityValidationError } = require('@allegator-games/community-core')

const MAX_PREVIEW_BYTES = 5 * 1024 * 1024
const ALLOWED_PREVIEW_MIMES = new Set(['image/png', 'image/webp', 'image/jpeg'])

function normalizePreviewMime(value) {
    const mime = String(value || 'image/png').split(';')[0].trim().toLowerCase()
    if(!ALLOWED_PREVIEW_MIMES.has(mime)) {
        throw new CommunityValidationError('invalid_preview_mime', 'Preview must be PNG, WebP, or JPEG.')
    }
    return mime
}

function previewExtension(mime) {
    if(mime === 'image/webp') return 'webp'
    if(mime === 'image/jpeg') return 'jpg'
    return 'png'
}

async function fallbackPreview(type) {
    const labels = {
        automation: 'AUTOMATION',
        'battle-trainers': 'TRAINER',
        'builder-presets': 'PRESET',
        'resource-packs': 'RESOURCE PACK'
    }
    return sharp({
        create: { width: 512, height: 512, channels: 4, background: '#172321ff' }
    }).composite([{
        input: Buffer.from(`<svg width="512" height="512" xmlns="http://www.w3.org/2000/svg"><rect x="24" y="24" width="464" height="464" rx="24" fill="#243c37" stroke="#d5793f" stroke-width="8"/><text x="256" y="272" text-anchor="middle" fill="#d8f3e9" font-family="sans-serif" font-size="40" font-weight="700">${labels[type] || 'COMMUNITY'}</text></svg>`)
    }]).png().toBuffer()
}

async function createPreviewVariants(buffer) {
    if(!Buffer.isBuffer(buffer) || buffer.length < 1 || buffer.length > MAX_PREVIEW_BYTES) {
        throw new CommunityValidationError('invalid_preview_size', `Preview must be between 1 and ${MAX_PREVIEW_BYTES} bytes.`)
    }
    let metadata
    try {
        metadata = await sharp(buffer, { failOn: 'warning', limitInputPixels: 32_000_000 }).metadata()
    } catch(_error) {
        throw new CommunityValidationError('invalid_preview', 'Preview is not a valid PNG, WebP, or JPEG image.')
    }
    if(!['png', 'webp', 'jpeg'].includes(metadata.format) || !metadata.width || !metadata.height) {
        throw new CommunityValidationError('invalid_preview', 'Preview is not a valid PNG, WebP, or JPEG image.')
    }
    const variants = []
    for(const [label, size] of [['tiny', 128], ['medium', 512]]) {
        const base = sharp(buffer, { failOn: 'warning', limitInputPixels: 32_000_000 })
            .rotate()
            .resize(size, size, { fit: 'inside', withoutEnlargement: true })
        const [webp, png] = await Promise.all([
            base.clone().webp({ quality: 82 }).toBuffer({ resolveWithObject: true }),
            base.clone().png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true })
        ])
        variants.push({ label, mime: 'image/webp', extension: 'webp', buffer: webp.data, width: webp.info.width, height: webp.info.height })
        variants.push({ label, mime: 'image/png', extension: 'png', buffer: png.data, width: png.info.width, height: png.info.height })
    }
    return variants
}

module.exports = {
    ALLOWED_PREVIEW_MIMES,
    MAX_PREVIEW_BYTES,
    createPreviewVariants,
    fallbackPreview,
    normalizePreviewMime,
    previewExtension
}
