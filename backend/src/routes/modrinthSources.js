'use strict'

const crypto = require('crypto')
const express = require('express')
const config = require('../config')
const db = require('../db')
const { asyncRoute } = require('../middleware/asyncRoute')
const { requireSession } = require('../middleware/session')
const store = require('../services/store')
const { getCommunityObjectStorage } = require('../services/communityObjectStorage')
const { createPreviewVariants, fallbackPreview } = require('../services/communityPreviews')
const { persistCompositionIndex } = require('../services/communityPackStudio')
const { compatibilityManifest } = require('../services/communityTypes')
const {
    checkSource, claimProject, listOwnedProjects, normalizeChannels, prepareCandidate, withDownloadedCandidate
} = require('../services/modrinthSources')

const router = express.Router()
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i

function enabled(req, res, next) {
    if(!config.modrinth.enabled || !config.community.enabled || config.community.types['resource-packs'] !== true) return res.status(404).json({ error: 'modrinth_integration_disabled' })
    next()
}
function id(value) {
    const normalized = String(value || '').toLowerCase()
    if(!UUID.test(normalized)) throw Object.assign(new Error('Invalid identifier.'), { code: 'invalid_id', statusCode: 400 })
    return normalized
}
function clean(value, max) { return String(value || '').trim().slice(0, max) }
function tags(value) { return [...new Set((Array.isArray(value) ? value : String(value || '').split(',')).map(item => clean(item, 24)).filter(Boolean))].slice(0, 12) }
async function publishingIdentity(userId) {
    if(config.community.writeMode === 'disabled') throw Object.assign(new Error('Community publishing is disabled.'), { code: 'community_writes_disabled', statusCode: 403 })
    if(config.community.writeMode === 'admin') {
        const grants = await store.getEntitlements(userId)
        if(!grants.some(value => ['community:admin','schematics:admin','admin'].includes(String(value).toLowerCase()))) throw Object.assign(new Error('Community publishing is limited to administrators.'), { code: 'community_writes_disabled', statusCode: 403 })
    }
    const identity = await store.getMinecraftIdentity(userId)
    if(!identity) throw Object.assign(new Error('A Minecraft profile is required.'), { code: 'minecraft_profile_required', statusCode: 403 })
    return identity
}

router.get('/community/sources/modrinth/projects', enabled, requireSession, asyncRoute(async (req, res) => {
    res.set('Cache-Control', 'private, no-store')
    res.json({ schemaVersion: 1, items: await listOwnedProjects(req.userId) })
}))

router.get('/community/sources/modrinth', enabled, requireSession, asyncRoute(async (req, res) => {
    const { rows } = await db.query(
        `select s.*,(select count(*) from community_external_candidates c where c.source_id=s.id and c.state in ('detected','prepared')) as pending_count
         from community_external_sources s where s.owner_id=$1 and s.provider='modrinth' order by s.project_title,s.id`, [req.userId])
    res.set('Cache-Control', 'private, no-store')
    res.json({ schemaVersion: 1, items: rows.map(row => ({ id: row.id, itemId: row.item_id, projectId: row.provider_project_id, slug: row.project_slug, title: row.project_title, channels: row.channels, status: row.status, lastCheckedAt: row.last_checked_at, lastError: row.last_error, pendingCount: Number(row.pending_count) })) })
}))

router.post('/community/sources/modrinth', enabled, requireSession, asyncRoute(async (req, res) => {
    await publishingIdentity(req.userId)
    const projectId = clean(req.body?.projectId || req.body?.slug, 100)
    if(!projectId) return res.status(400).json({ error: 'modrinth_project_required' })
    const row = await claimProject(req.userId, projectId, req.body?.channels)
    const result = await checkSource(req.userId, row.id)
    res.status(201).json({ schemaVersion: 1, id: row.id, projectId: row.provider_project_id, title: row.project_title, channels: row.channels, ...result })
}))

router.patch('/community/sources/modrinth/:sourceId', enabled, requireSession, asyncRoute(async (req, res) => {
    const { rows } = await db.query(
        `update community_external_sources set channels=$3,status='active',updated_at=now()
         where id=$1 and owner_id=$2 and provider='modrinth' returning *`, [id(req.params.sourceId), req.userId, normalizeChannels(req.body?.channels)])
    if(!rows.length) return res.status(404).json({ error: 'modrinth_source_not_found' })
    res.json({ schemaVersion: 1, id: rows[0].id, channels: rows[0].channels, status: rows[0].status })
}))

router.delete('/community/sources/modrinth/:sourceId', enabled, requireSession, asyncRoute(async (req, res) => {
    const result = await db.query('update community_external_sources set status=\'disabled\',updated_at=now() where id=$1 and owner_id=$2 and provider=\'modrinth\'', [id(req.params.sourceId), req.userId])
    if(!result.rowCount) return res.status(404).json({ error: 'modrinth_source_not_found' })
    res.status(204).end()
}))

router.post('/community/sources/modrinth/:sourceId/check', enabled, requireSession, asyncRoute(async (req, res) => {
    res.json({ schemaVersion: 1, ...(await checkSource(req.userId, id(req.params.sourceId))) })
}))

router.get('/community/sources/modrinth/:sourceId/candidates', enabled, requireSession, asyncRoute(async (req, res) => {
    const { rows } = await db.query(
        `select c.* from community_external_candidates c join community_external_sources s on s.id=c.source_id
         where s.id=$1 and s.owner_id=$2 order by c.detected_at desc,c.id`, [id(req.params.sourceId), req.userId])
    res.set('Cache-Control', 'private, no-store')
    res.json({ schemaVersion: 1, items: rows.map(row => ({ id: row.id, versionId: row.provider_version_id, versionNumber: row.version_number, channel: row.release_channel, fileName: row.file_name, sizeBytes: row.file_size == null ? null : Number(row.file_size), sha512: row.file_sha512, state: row.state, preparedSha256: row.prepared_sha256, detectedAt: row.detected_at, preparedAt: row.prepared_at, details: row.prepared_data || {} })) })
}))

router.post('/community/sources/modrinth/:sourceId/candidates/:candidateId/prepare', enabled, requireSession, asyncRoute(async (req, res) => {
    await publishingIdentity(req.userId)
    const result = await prepareCandidate(req.userId, id(req.params.sourceId), id(req.params.candidateId), clean(req.body?.fileSha512, 128) || null)
    res.json({ schemaVersion: 1, ...result })
}))

router.post('/community/sources/modrinth/:sourceId/candidates/:candidateId/publish', enabled, requireSession, asyncRoute(async (req, res) => {
    await publishingIdentity(req.userId)
    const sourceId = id(req.params.sourceId)
    const candidateId = id(req.params.candidateId)
    if(req.body?.rightsAttested !== true) return res.status(400).json({ error: 'rights_attestation_required' })
    if(req.body?.licenseAccepted !== true) return res.status(400).json({ error: 'license_acceptance_required' })
    const packStudioOptIn = req.body?.packStudioOptIn === true
    if(packStudioOptIn && req.body?.packStudioTermsAccepted !== true) return res.status(400).json({ error: 'pack_studio_terms_required' })
    const expectedSha256 = clean(req.body?.expectedSha256, 64).toLowerCase()
    if(!/^[a-f0-9]{64}$/.test(expectedSha256)) return res.status(400).json({ error: 'expected_candidate_hash_required' })

    const writtenKeys = []
    try {
        const published = await withDownloadedCandidate(req.userId, sourceId, candidateId, null, async ({ row, context, project, version, file, hashes, validated }) => {
            if(row.state !== 'prepared' || row.prepared_sha256 !== expectedSha256 || hashes.sha256 !== expectedSha256) {
                throw Object.assign(new Error('The Modrinth candidate changed after review. Prepare it again.'), { code: 'modrinth_candidate_changed', statusCode: 409 })
            }
            const projectLicense = String(project.license?.id || '')
            if(clean(req.body?.license, 64).toLowerCase() !== projectLicense.toLowerCase()) {
                throw Object.assign(new Error('The Community license must match the Modrinth project license.'), { code: 'modrinth_license_mismatch', statusCode: 400 })
            }
            const preview = validated.previewBuffer || await fallbackPreview('resource-packs')
            const variants = await createPreviewVariants(preview)
            const revisionId = crypto.randomUUID()
            const storage = getCommunityObjectStorage()
            for(const variant of variants) {
                variant.objectKey = `community/previews/${revisionId}/${variant.label}.${variant.extension}`
                const write = await storage.putImmutable(variant.objectKey, variant.buffer, { contentType: variant.mime, cacheControl: 'private, max-age=31536000, immutable' })
                if(!write.existing) writtenKeys.push(variant.objectKey)
            }
            const result = await db.withClient(async client => {
                await client.query('begin')
                try {
                    const lock = await client.query(
                        `select s.*,c.state,c.prepared_sha256 from community_external_sources s
                         join community_external_candidates c on c.source_id=s.id and c.id=$2
                         where s.id=$1 and s.owner_id=$3 for update`, [sourceId, candidateId, req.userId])
                    if(!lock.rows.length || lock.rows[0].state !== 'prepared' || lock.rows[0].prepared_sha256 !== expectedSha256) throw Object.assign(new Error('Candidate is no longer ready to publish.'), { code: 'modrinth_candidate_changed', statusCode: 409 })
                    let itemId = lock.rows[0].item_id
                    if(!itemId) {
                        itemId = crypto.randomUUID()
                        await client.query(
                            `insert into community_items(id,type,owner_id,title,description,tags,license,rights_attested_at,visibility,status)
                             values ($1,'resource-packs',$2,$3,$4,$5,$6,now(),'public','active')`,
                            [itemId, req.userId, clean(req.body?.title, 80) || project.title, clean(req.body?.description, 2000) || project.description || '', tags(req.body?.tags), projectLicense])
                        await client.query('update community_external_sources set item_id=$2 where id=$1', [sourceId, itemId])
                    } else {
                        await client.query(
                            `update community_items set title=coalesce(nullif($2,''),title),description=coalesce(nullif($3,''),description),
                             tags=case when cardinality($4::text[])>0 then $4 else tags end,rights_attested_at=now(),status='active',updated_at=now()
                             where id=$1 and owner_id=$5`, [itemId, clean(req.body?.title, 80), clean(req.body?.description, 2000), tags(req.body?.tags), req.userId])
                    }
                    const current = await client.query('select r.sha256,r.id from community_items i left join community_revisions r on r.id=i.current_revision_id where i.id=$1', [itemId])
                    if(current.rows[0]?.sha256 === hashes.sha256) {
                        await client.query('update community_external_candidates set state=\'published\',published_at=now() where id=$1', [candidateId])
                        await client.query('commit')
                        return { itemId, revisionId: current.rows[0].id, alreadyCurrent: true }
                    }
                    const latest = await client.query('select coalesce(max(revision_number),0)+1 as number from community_revisions where item_id=$1', [itemId])
                    await client.query(
                        `insert into community_revisions
                         (id,item_id,revision_number,sha256,size_bytes,mime_type,extension,format_id,format_version,compatibility,type_data,object_key,created_by)
                         values ($1,$2,$3,$4,$5,'application/zip','zip','minecraft_resource_pack',1,$6,$7,null,$8)`,
                        [revisionId, itemId, Number(latest.rows[0].number), hashes.sha256, hashes.sizeBytes, compatibilityManifest.compatibility, validated.typeData || {}, req.userId])
                    await client.query(
                        `insert into community_revision_sources
                         (revision_id,provider,provider_project_id,provider_version_id,provider_file_name,provider_sha512,provider_version_number,provider_project_url,provider_creator,available,last_verified_at)
                         values ($1,'modrinth',$2,$3,$4,$5,$6,$7,$8,true,now())`,
                        [revisionId, project.id, version.id, file.filename, hashes.sha512, version.version_number,
                            `https://modrinth.com/resourcepack/${encodeURIComponent(project.slug || project.id)}`,
                            { id: context.account.providerUserId, username: context.account.username }])
                    for(const variant of variants) await client.query(
                        `insert into community_revision_previews(revision_id,size_label,mime_type,object_key,width,height,size_bytes)
                         values ($1,$2,$3,$4,$5,$6,$7)`, [revisionId, variant.label, variant.mime, variant.objectKey, variant.width, variant.height, variant.buffer.length])
                    if(validated.compositionIndex) await persistCompositionIndex(client, { revisionId, itemId, ownerId: req.userId, index: validated.compositionIndex, enabled: config.community.packStudioEnabled && packStudioOptIn })
                    await client.query('update community_items set current_revision_id=$2,updated_at=now() where id=$1', [itemId, revisionId])
                    await client.query('update community_external_candidates set state=\'published\',published_at=now() where id=$1', [candidateId])
                    await client.query('update community_external_candidates set state=\'superseded\' where source_id=$1 and id<>$2 and state=\'prepared\'', [sourceId, candidateId])
                    await client.query('commit')
                    return { itemId, revisionId, alreadyCurrent: false }
                } catch(error) { await client.query('rollback'); throw error }
            })
            return { ...result, source: { provider: 'modrinth', projectId: project.id, versionId: version.id, versionNumber: version.version_number, fileName: file.filename, projectUrl: `https://modrinth.com/resourcepack/${encodeURIComponent(project.slug || project.id)}` } }
        })
        res.status(published.alreadyCurrent ? 200 : 201).json({ schemaVersion: 1, ...published })
    } catch(error) {
        if(writtenKeys.length) {
            const storage = getCommunityObjectStorage()
            await Promise.all(writtenKeys.map(key => storage.delete(key).catch(() => {})))
        }
        throw error
    }
}))

module.exports = router
