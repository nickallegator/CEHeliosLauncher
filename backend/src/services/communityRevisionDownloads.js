'use strict'

const db = require('../db')
const { getCommunityObjectStorage } = require('./communityObjectStorage')
const { getExternalProviderRegistry } = require('./externalProviders')

async function resolveCommunityRevisionDownload(row) {
    const provider = row.sourceProvider || row.source_provider || (row.objectKey || row.object_key ? 'r2' : null)
    if(provider === 'r2') {
        const objectKey = row.sourceObjectKey || row.source_object_key || row.objectKey || row.object_key
        return { provider: 'r2', downloadUrl: await getCommunityObjectStorage().signGet(objectKey, 900), expiresAt: new Date(Date.now() + 900_000).toISOString() }
    }
    if(provider !== 'modrinth') throw Object.assign(new Error('Community revision source is unavailable.'), { code: 'community_source_unavailable', statusCode: 410 })
    try {
        const modrinth = getExternalProviderRegistry().get('modrinth')
        if(!modrinth) throw new Error('disabled')
        const resolved = await modrinth.resolveFile({
            versionId: row.providerVersionId || row.provider_version_id,
            fileName: row.providerFileName || row.provider_file_name,
            sha512: row.providerSha512 || row.provider_sha512
        })
        const revisionId = row.revisionId || row.revision_id
        if(revisionId) await db.query('update community_revision_sources set available=true,last_verified_at=now(),unavailable_reason=null where revision_id=$1', [revisionId]).catch(() => {})
        return { provider: 'modrinth', downloadUrl: resolved.url, expiresAt: null }
    } catch(error) {
        const revisionId = row.revisionId || row.revision_id
        const definitive = ['modrinth_source_unavailable','modrinth_archive_drift'].includes(error.code)
            || [404, 410].includes(error.upstreamStatus)
        if(definitive && revisionId) await db.query('update community_revision_sources set available=false,last_verified_at=now(),unavailable_reason=$2 where revision_id=$1', [revisionId, String(error.code || 'upstream_unavailable').slice(0, 120)]).catch(() => {})
        if(definitive) throw Object.assign(new Error('The exact Modrinth source file is unavailable.'), { code: 'community_source_unavailable', statusCode: 410 })
        throw Object.assign(new Error('Modrinth is temporarily unavailable. A validated local copy can still be used offline.'), { code: 'community_source_temporarily_unavailable', statusCode: 503 })
    }
}

async function downloadCommunityRevisionToFile(row, destination) {
    const provider = row.sourceProvider || row.source_provider || (row.objectKey || row.object_key ? 'r2' : null)
    if(provider === 'r2') {
        const objectKey = row.sourceObjectKey || row.source_object_key || row.objectKey || row.object_key
        await getCommunityObjectStorage().getToFile(objectKey, destination, { maxBytes: Number(row.sizeBytes || row.size_bytes) })
        return
    }
    if(provider !== 'modrinth') throw Object.assign(new Error('Community revision source is unavailable.'), { code: 'community_source_unavailable', statusCode: 410 })
    const modrinth = getExternalProviderRegistry().get('modrinth')
    if(!modrinth) throw Object.assign(new Error('Modrinth integration is disabled.'), { code: 'modrinth_integration_disabled', statusCode: 503 })
    const resolved = await modrinth.resolveFile({ versionId: row.providerVersionId || row.provider_version_id, fileName: row.providerFileName || row.provider_file_name, sha512: row.providerSha512 || row.provider_sha512 })
    const result = await modrinth.downloadToFile(resolved.file, destination)
    if(result.sha256 !== String(row.sha256).toLowerCase() || result.sizeBytes !== Number(row.sizeBytes || row.size_bytes)) {
        throw Object.assign(new Error('Modrinth revision no longer matches its AG checksum record.'), { code: 'modrinth_archive_drift', statusCode: 409 })
    }
}

module.exports = { downloadCommunityRevisionToFile, resolveCommunityRevisionDownload }
