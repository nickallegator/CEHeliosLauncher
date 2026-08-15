'use strict'

const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const express = require('express')
const {
    CommunityValidationError,
    TYPES,
    normalizeCompatibility
} = require('@allegator-games/community-core')

const config = require('../config')
const db = require('../db')
const { asyncRoute } = require('../middleware/asyncRoute')
const { requireSession } = require('../middleware/session')
const rateLimits = require('../services/communityRateLimits')
const { getCommunityObjectStorage } = require('../services/communityObjectStorage')
const {
    MAX_PREVIEW_BYTES,
    createPreviewVariants,
    fallbackPreview,
    normalizePreviewMime,
    previewExtension
} = require('../services/communityPreviews')
const { compatibilityManifest, createDefaultCommunityTypeRegistry } = require('../services/communityTypes')
const sessions = require('../services/sessions')
const store = require('../services/store')
const { createCommunityCatalog } = require('../services/communityCatalog')
const {
    describeCompositionUpdates,
    listComponents,
    loadSourcesForSelections,
    persistCompositionIndex,
    resolveComposition
} = require('../services/communityPackStudio')
const { resolveCommunityRevisionDownload } = require('../services/communityRevisionDownloads')

const router = express.Router()
const typeRegistry = createDefaultCommunityTypeRegistry()
const catalog = createCommunityCatalog({
    database: db,
    schematicSettings: config.schematics,
    communitySettings: config.community
})
const UPLOAD_TTL_MS = 15 * 60 * 1000
const PUBLIC_VISIBILITY = 'public'
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i

function audit(req, action, detail = {}) {
    const entry = { requestId: req.requestId, action, userId: req.userId || null, ...detail }
    console.info('[audit] Community event', entry)
    db.query(
        `insert into community_audit_events(request_id, actor_id, item_id, action, detail)
         values ($1,$2,$3,$4,$5)`,
        [req.requestId || null, req.userId || null, detail.itemId || null, action, detail]
    ).catch(() => {})
}

function hashToken(token) {
    return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex')
}

function cleanText(value, maxLength, fallback = '') {
    const normalized = typeof value === 'string' ? value.trim() : ''
    return (normalized || fallback).slice(0, maxLength)
}

function cleanTags(value) {
    const source = Array.isArray(value) ? value : String(value || '').split(',')
    return Array.from(new Set(source.map(tag => cleanText(tag, 24)).filter(Boolean))).slice(0, 12)
}

function cleanShowcase(value) {
    if(value == null) return null
    if(Number(value.schemaVersion) !== 1 || !Array.isArray(value.subjects)) {
        throw new CommunityValidationError('invalid_resource_pack_showcase', 'Showcase metadata must use schema version 1.')
    }
    if(value.subjects.length > 8) throw new CommunityValidationError('resource_pack_showcase_limit', 'Select at most eight showcase subjects.')
    return {
        schemaVersion: 1,
        subjects: value.subjects.map(subject => {
            const kind = cleanText(subject?.kind, 16).toLowerCase()
            if(kind === 'block') return {
                kind,
                id: cleanText(subject.id, 256).toLowerCase(),
                state: subject.state && typeof subject.state === 'object' && !Array.isArray(subject.state) ? subject.state : {}
            }
            if(kind === 'pokemon') return {
                kind,
                species: cleanText(subject.species, 256).toLowerCase(),
                form: cleanText(subject.form, 80).toLowerCase(),
                gender: cleanText(subject.gender, 16, 'MALE').toUpperCase()
            }
            throw new CommunityValidationError('invalid_showcase_subject', `Unsupported showcase subject type: ${kind || '<empty>'}.`)
        })
    }
}

function parseUuid(value, label = 'id') {
    const normalized = String(value || '').trim().toLowerCase()
    if(!UUID.test(normalized)) throw new CommunityValidationError('invalid_id', `${label} must be a UUID.`)
    return normalized
}

function getTypeHandler(rawType, { requireEnabled = true } = {}) {
    const type = cleanText(rawType, 40).toLowerCase()
    const handler = typeRegistry.get(type)
    if(!handler) throw new CommunityValidationError('unsupported_community_type', `Unsupported Community type: ${type || '<empty>'}.`)
    if(requireEnabled && (!config.community.enabled || config.community.types[type] !== true)) {
        const error = new Error(`Community type ${type} is not enabled.`)
        error.code = 'community_type_disabled'
        error.statusCode = 404
        throw error
    }
    return handler
}

function cleanMetadata(body = {}) {
    const visibility = cleanText(body.visibility, 16, PUBLIC_VISIBILITY).toLowerCase()
    if(visibility !== PUBLIC_VISIBILITY) throw new CommunityValidationError('unsupported_visibility', 'Only public Community items are supported.')
    const title = cleanText(body.title || body.name, 80)
    if(!title) throw new CommunityValidationError('missing_title', 'A title is required.')
    const license = cleanText(body.license, 64)
    if(!config.community.allowedLicenses.some(value => value.toLowerCase() === license.toLowerCase())) {
        throw new CommunityValidationError('unsupported_license', 'Select an approved Community content license.', {
            allowed: config.community.allowedLicenses
        })
    }
    if(body.rightsAttested !== true) {
        throw new CommunityValidationError('rights_attestation_required', 'You must attest that you have the right to distribute this content.')
    }
    const packStudioOptIn = body.packStudioOptIn === true
    if(packStudioOptIn && body.packStudioTermsAccepted !== true) {
        throw new CommunityValidationError('pack_studio_terms_required', 'Accept the Pack Studio composition grant before opting in.')
    }
    return {
        title,
        description: cleanText(body.description, 2000),
        tags: cleanTags(body.tags),
        license: config.community.allowedLicenses.find(value => value.toLowerCase() === license.toLowerCase()),
        rightsAttested: true,
        visibility,
        compatibility: normalizeCompatibility(body.compatibility, {
            allowedRanges: [compatibilityManifest.compatibility]
        }),
        packStudioOptIn,
        packStudioTermsAccepted: packStudioOptIn,
        ...(body.showcase == null ? {} : { showcase: cleanShowcase(body.showcase) })
    }
}

async function userIsAdmin(userId) {
    if(!userId) return false
    const entitlements = await store.getEntitlements(userId)
    return entitlements.some(value => ['schematics:admin', 'community:admin', 'admin'].includes(String(value).toLowerCase()))
}

async function requirePublishingAccess(req, res) {
    const admin = await userIsAdmin(req.userId)
    if(config.community.writeMode === 'disabled' || (config.community.writeMode === 'admin' && !admin)) {
        res.status(403).json({ error: 'community_writes_disabled' })
        return null
    }
    const identity = await store.getMinecraftIdentity(req.userId)
    if(!identity) {
        res.status(403).json({ error: 'minecraft_profile_required' })
        return null
    }
    return { admin, identity }
}

async function consumeLimit(res, options) {
    const result = await rateLimits.consume(options)
    res.set('X-RateLimit-Limit', String(result.limit))
    res.set('X-RateLimit-Remaining', String(result.remaining))
    if(result.allowed) return true
    res.set('Retry-After', String(Math.max(1, Math.ceil((result.resetAt.getTime() - Date.now()) / 1000))))
    res.status(429).json({ error: 'rate_limited' })
    return false
}

const CURRENT_ITEM_SELECT = `
    select i.*, u.display_name as creator_display_name,
           r.id as revision_id, r.revision_number, r.sha256,
           r.size_bytes as revision_size_bytes, r.mime_type, r.extension,
           r.format_id, r.format_version, r.compatibility, r.type_data, r.object_key,
           rs.provider as source_provider, rs.object_key as source_object_key,
           rs.provider_project_id, rs.provider_version_id, rs.provider_file_name, rs.provider_sha512,
           rs.provider_version_number, rs.provider_project_url, rs.provider_creator,
           rs.available as source_available, rs.last_verified_at as source_last_verified_at,
           coalesce((select jsonb_agg(jsonb_build_object(
               'type', d.dependency_type, 'itemId', d.dependency_item_id,
               'revisionId', d.dependency_revision_id, 'required', d.required,
               'installOrder', d.install_order
           ) order by d.install_order, d.dependency_type, d.dependency_item_id)
           from community_revision_dependencies d where d.revision_id = r.id), '[]'::jsonb) as dependencies
    from community_items i
    join community_revisions r on r.id = i.current_revision_id
    left join community_revision_sources rs on rs.revision_id = r.id
    left join users u on u.id = i.owner_id`

async function getItem(type, id, { includeInactive = false, client = db } = {}) {
    const clauses = ['i.type = $1', 'i.id = $2']
    if(!includeInactive) clauses.push('i.visibility = \'public\'', 'i.status = \'active\'')
    const result = await client.query(`${CURRENT_ITEM_SELECT} where ${clauses.join(' and ')}`, [type, id])
    return result.rows[0] || null
}

function itemJson(row, detail = false) {
    const compatibility = typeof row.compatibility === 'string' ? JSON.parse(row.compatibility) : row.compatibility
    const typeData = typeof row.type_data === 'string' ? JSON.parse(row.type_data) : row.type_data
    const dependencies = typeof row.dependencies === 'string' ? JSON.parse(row.dependencies) : row.dependencies
    const value = {
        schemaVersion: 1,
        id: row.id,
        type: row.type,
        key: `${row.type}:${row.id}`,
        ownerId: row.owner_id == null ? null : String(row.owner_id),
        title: row.title,
        description: row.description || '',
        creator: { id: row.owner_id == null ? null : String(row.owner_id), name: row.creator_display_name || 'Minecraft Player' },
        tags: row.tags || [],
        license: row.license,
        rightsAttestedAt: row.rights_attested_at,
        visibility: row.visibility,
        status: row.status,
        publishedAt: row.created_at,
        updatedAt: row.updated_at,
        stats: { likes: Number(row.likes || 0), views: Number(row.views || 0), downloads: Number(row.downloads || 0) },
        compatibility,
        revision: {
            id: row.revision_id,
            number: Number(row.revision_number),
            sha256: row.sha256,
            sizeBytes: Number(row.revision_size_bytes),
            mimeType: row.mime_type,
            formatId: row.format_id,
            formatVersion: Number(row.format_version)
        },
        dependencies: dependencies || [],
        typeData: typeData || {},
        thumbnailUrl: `/v1/community/items/${row.type}/${row.id}/preview?size=tiny`
    }
    if(row.source_provider === 'modrinth') {
        const creator = typeof row.provider_creator === 'string' ? JSON.parse(row.provider_creator) : row.provider_creator
        value.source = {
            provider: 'modrinth', projectId: row.provider_project_id, versionId: row.provider_version_id,
            versionNumber: row.provider_version_number, fileName: row.provider_file_name,
            projectUrl: row.provider_project_url, creator: creator || null
        }
        value.availability = { available: row.source_available !== false, lastVerifiedAt: row.source_last_verified_at || null }
    } else {
        value.source = { provider: 'r2' }
        value.availability = { available: true, lastVerifiedAt: null }
    }
    if(detail) {
        value.downloadUrl = `/v1/community/items/${row.type}/${row.id}/download`
        value.thumbnailMediumUrl = `/v1/community/items/${row.type}/${row.id}/preview?size=medium`
    }
    return value
}

async function safeRemoveTemp(directory) {
    if(!directory) return
    const resolved = path.resolve(directory)
    const tempRoot = `${path.resolve(os.tmpdir())}${path.sep}`
    if(!resolved.startsWith(tempRoot) || !path.basename(resolved).startsWith('ag-community-')) return
    await fs.promises.rm(resolved, { recursive: true, force: true }).catch(() => {})
}

async function resolveDependencies(client, dependencies, ownItemId = null) {
    const output = []
    const seen = new Set()
    for(const [index, dependency] of (dependencies || []).entries()) {
        const type = cleanText(dependency.type, 40).toLowerCase()
        if(!Object.values(TYPES).includes(type)) throw new CommunityValidationError('invalid_dependency_type', `Unsupported dependency type: ${type}.`)
        const itemId = parseUuid(dependency.itemId, 'dependency itemId')
        if(itemId === ownItemId) throw new CommunityValidationError('dependency_cycle', 'Community items cannot depend on themselves.')
        const key = `${type}:${itemId}`
        if(seen.has(key)) continue
        seen.add(key)
        const row = await getItem(type, itemId, { client })
        if(!row) throw new CommunityValidationError('missing_dependency', `Required Community dependency ${key} is unavailable.`)
        const requestedRevision = dependency.revisionId ? parseUuid(dependency.revisionId, 'dependency revisionId') : row.revision_id
        if(requestedRevision !== row.revision_id) {
            const revision = await client.query('select id from community_revisions where id = $1 and item_id = $2', [requestedRevision, itemId])
            if(revision.rows.length === 0) throw new CommunityValidationError('missing_dependency_revision', `Dependency ${key} revision is unavailable.`)
        }
        if(ownItemId) {
            const cycle = await client.query(
                `with recursive dependency_graph(item_id) as (
                    values ($1::uuid)
                    union
                    select d.dependency_item_id
                    from dependency_graph g
                    join community_items i on i.id = g.item_id
                    join community_revision_dependencies d on d.revision_id = i.current_revision_id
                 )
                 select 1 from dependency_graph where item_id = $2 limit 1`,
                [itemId, ownItemId]
            )
            if(cycle.rows.length) throw new CommunityValidationError('dependency_cycle', 'Community dependency graph contains a cycle.')
        }
        output.push({ type, itemId, revisionId: requestedRevision, required: dependency.required !== false, installOrder: index })
    }
    return output
}

async function optionalSession(req) {
    const authorization = req.headers.authorization || ''
    const [type, token] = authorization.split(' ')
    if(type?.toLowerCase() !== 'bearer' || !token) return null
    return sessions.getSession(token)
}

router.get('/community/capabilities', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=300')
    res.json({
        ...catalog.capabilities(),
        features: {
            richPreviews: config.community.richPreviewsEnabled === true,
            packStudio: config.community.packStudioEnabled === true,
            modrinth: config.modrinth.enabled === true
        },
        composer: config.community.packStudioEnabled ? {
            schemaVersion: 1,
            componentKinds: ['block','pokemon','item','sound','font','language','ui','texture','generic'],
            maxSelections: 512,
            grantTermsUrl: '/v1/community/licenses/AG-Pack-Studio-Composition-Grant-1.0'
        } : null,
        licenses: config.community.allowedLicenses.map(id => ({ id, url: `/v1/community/licenses/${encodeURIComponent(id)}` }))
    })
})

router.get('/community/catalog', asyncRoute(async (req, res) => {
    let ownerId = null
    if(String(req.query.mine || '').toLowerCase() === 'true') {
        const session = await optionalSession(req)
        if(!session) {
            res.status(401).json({ error: 'authentication_required' })
            return
        }
        ownerId = session.userId
    }
    const result = await catalog.list({
        category: req.query.category,
        query: req.query.query,
        sort: req.query.sort,
        creator: req.query.creator,
        tags: req.query.tags,
        limit: req.query.limit,
        cursor: req.query.cursor,
        ownerId
    })
    const etag = catalog.etag(result)
    res.set('ETag', etag)
    res.set('Cache-Control', ownerId == null ? 'public, max-age=60, stale-if-error=86400' : 'private, no-store')
    res.set('Vary', 'Authorization')
    if(req.headers['if-none-match'] === etag) {
        res.status(304).end()
        return
    }
    res.json(result)
}))

router.get('/community/composer/components', asyncRoute(async (req, res) => {
    if(!config.community.packStudioEnabled) {
        res.status(404).json({ error: 'pack_studio_disabled' })
        return
    }
    const result = await listComponents(db, req.query)
    res.set('Cache-Control', 'public, max-age=60, stale-if-error=86400')
    res.json(result)
}))

router.post('/community/composer/resolve', asyncRoute(async (req, res) => {
    if(!config.community.packStudioEnabled) {
        res.status(404).json({ error: 'pack_studio_disabled' })
        return
    }
    if(!await consumeLimit(res, {
        subject: `ip:${req.ip}`,
        action: 'pack-studio-resolve',
        limit: config.community.composerRateLimit,
        windowMs: 60 * 60 * 1000
    })) return
    const selections = Array.isArray(req.body?.selections) ? req.body.selections.map(value => ({
        sourceItemId: cleanText(value?.sourceItemId, 80).toLowerCase(),
        sourceRevisionId: cleanText(value?.sourceRevisionId, 80).toLowerCase(),
        componentKey: cleanText(value?.componentKey, 320).toLowerCase()
    })) : []
    const resolutions = req.body?.conflictResolutions && typeof req.body.conflictResolutions === 'object' && !Array.isArray(req.body.conflictResolutions)
        ? Object.fromEntries(Object.entries(req.body.conflictResolutions).slice(0, 1024).map(([key, value]) => [cleanText(key, 600), cleanText(value, 700)]))
        : {}
    const sources = await loadSourcesForSelections(db, selections)
    for(const selection of selections) {
        const source = sources.find(value => String(value.revisionId) === selection.sourceRevisionId)
        if(!source || String(source.itemId) !== selection.sourceItemId) {
            throw new CommunityValidationError('composition_source_mismatch', 'A Pack Studio selection does not match its source item.')
        }
    }
    const plan = resolveComposition(sources, selections, resolutions)
    const updates = await describeCompositionUpdates(db, sources, selections)
    const descriptors = await Promise.all(sources.map(async source => ({
        itemId: source.itemId,
        revisionId: source.revisionId,
        title: source.title,
        creator: source.creator,
        license: source.license,
        sha256: source.sha256,
        sizeBytes: source.sizeBytes,
        compatibility: source.compatibility,
        source: source.sourceProvider === 'modrinth' ? {
            provider: 'modrinth', projectId: source.providerProjectId,
            versionNumber: source.providerVersionNumber, projectUrl: source.providerProjectUrl
        } : { provider: 'r2' },
        updateAvailable: source.currentRevisionId != null && source.currentRevisionId !== source.revisionId,
        update: updates.get(String(source.revisionId)) || null,
        ...(await resolveCommunityRevisionDownload(source))
    })))
    res.set('Cache-Control', 'private, no-store')
    res.json({
        schemaVersion: 1,
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
        sources: descriptors,
        plan
    })
}))

router.get('/community/items/resource-packs/:id/revisions/:revisionId/composition', asyncRoute(async (req, res) => {
    if(!config.community.packStudioEnabled) {
        res.status(404).json({ error: 'pack_studio_disabled' })
        return
    }
    const itemId = parseUuid(req.params.id)
    const revisionId = parseUuid(req.params.revisionId, 'revisionId')
    const result = await db.query(
        `select g.enabled,g.terms_version,g.granted_at,g.revoked_at,
                (select count(*) from community_resource_components c where c.revision_id=r.id) as component_count
         from community_revisions r left join community_resource_pack_composition_grants g on g.revision_id=r.id
         where r.id=$1 and r.item_id=$2`,
        [revisionId, itemId]
    )
    if(!result.rows.length) {
        res.status(404).json({ error: 'community_revision_not_found' })
        return
    }
    const row = result.rows[0]
    res.set('Cache-Control', 'private, no-store')
    res.json({ schemaVersion: 1, enabled: row.enabled === true, termsVersion: Number(row.terms_version || 1), componentCount: Number(row.component_count), grantedAt: row.granted_at, revokedAt: row.revoked_at })
}))

router.put('/community/items/resource-packs/:id/revisions/:revisionId/composition', requireSession, asyncRoute(async (req, res) => {
    if(!config.community.packStudioEnabled) {
        res.status(404).json({ error: 'pack_studio_disabled' })
        return
    }
    const itemId = parseUuid(req.params.id)
    const revisionId = parseUuid(req.params.revisionId, 'revisionId')
    const row = await getItem(TYPES.RESOURCE_PACKS, itemId, { includeInactive: true })
    const admin = await userIsAdmin(req.userId)
    if(!row) {
        res.status(404).json({ error: 'community_item_not_found' })
        return
    }
    if(Number(row.owner_id) !== Number(req.userId) && !admin) {
        res.status(403).json({ error: 'not_owner' })
        return
    }
    if(req.body?.enabled === true && req.body?.termsAccepted !== true) {
        throw new CommunityValidationError('pack_studio_terms_required', 'Accept the Pack Studio composition grant before opting in.')
    }
    const revision = await db.query('select id from community_revisions where id=$1 and item_id=$2', [revisionId, itemId])
    if(!revision.rows.length) {
        res.status(404).json({ error: 'community_revision_not_found' })
        return
    }
    const indexed = await db.query('select count(*) as count from community_resource_components where revision_id=$1', [revisionId])
    if(req.body?.enabled === true && Number(indexed.rows[0].count) < 1) {
        res.status(409).json({ error: 'composition_index_missing' })
        return
    }
    const enabled = req.body?.enabled === true
    await db.query(
        `insert into community_resource_pack_composition_grants
         (revision_id,item_id,enabled,terms_version,granted_by,granted_at,revoked_at,updated_at)
         values ($1,$2,$3,1,$4,case when $3 then now() else null end,case when $3 then null else now() end,now())
         on conflict (revision_id) do update set enabled=excluded.enabled,terms_version=1,granted_by=$4,
           granted_at=case when excluded.enabled then now() else community_resource_pack_composition_grants.granted_at end,
           revoked_at=case when excluded.enabled then null else now() end,updated_at=now()`,
        [revisionId, itemId, enabled, req.userId]
    )
    audit(req, enabled ? 'pack_studio_grant_enabled' : 'pack_studio_grant_revoked', { itemId, revisionId })
    res.set('Cache-Control', 'private, no-store')
    res.json({ schemaVersion: 1, enabled, termsVersion: 1, componentCount: Number(indexed.rows[0].count) })
}))

router.get('/community/licenses/:id', (req, res) => {
    const licenseId = cleanText(req.params.id, 64)
    const compositionGrant = licenseId === 'AG-Pack-Studio-Composition-Grant-1.0'
    if(!compositionGrant && !config.community.allowedLicenses.includes(licenseId)) {
        res.status(404).json({ error: 'community_license_not_found' })
        return
    }
    if(!compositionGrant && licenseId !== 'Community-Use-1.0') {
        res.redirect(302, `https://spdx.org/licenses/${encodeURIComponent(licenseId)}.html`)
        return
    }
    const licensePath = path.resolve(__dirname, '..', '..', 'licenses', compositionGrant
        ? 'AG-Pack-Studio-Composition-Grant-1.0.txt'
        : 'Community-Use-1.0.txt')
    res.set('Content-Type', 'text/plain; charset=utf-8')
    res.set('Cache-Control', 'public, max-age=86400')
    res.sendFile(licensePath)
})

router.post('/community/uploads', requireSession, asyncRoute(async (req, res) => {
    const access = await requirePublishingAccess(req, res)
    if(!access) return
    const handler = getTypeHandler(req.body?.type)
    if(!await consumeLimit(res, {
        subject: `user:${req.userId}`,
        action: `upload:${handler.id}`,
        limit: config.community.uploadRateLimit,
        windowMs: 60 * 60 * 1000
    })) return
    const metadata = cleanMetadata(req.body)
    const targetItemId = req.body?.targetItemId ? parseUuid(req.body.targetItemId, 'targetItemId') : null
    if(targetItemId) {
        const target = await getItem(handler.id, targetItemId, { includeInactive: true })
        if(!target) {
            res.status(404).json({ error: 'community_item_not_found' })
            return
        }
        if(target.status === 'deleted') {
            res.status(409).json({ error: 'community_item_deleted' })
            return
        }
        if(Number(target.owner_id) !== Number(req.userId) && !access.admin) {
            res.status(403).json({ error: 'not_owner' })
            return
        }
    }
    const uploadId = crypto.randomUUID()
    const token = crypto.randomBytes(32).toString('base64url')
    const artifactKey = `pending/community/${uploadId}/artifact.${handler.format.extension}`
    const wantsPreview = handler.id !== TYPES.RESOURCE_PACKS || req.body.previewMime != null
    const previewMime = wantsPreview ? normalizePreviewMime(req.body.previewMime) : null
    const previewKey = previewMime ? `pending/community/${uploadId}/preview.${previewExtension(previewMime)}` : null
    const expiresAt = new Date(Date.now() + UPLOAD_TTL_MS)
    await db.query(
        `insert into community_upload_sessions
         (id, token_hash, user_id, type, target_item_id, metadata, artifact_pending_key,
          preview_pending_key, preview_mime, expires_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [uploadId, hashToken(token), req.userId, handler.id, targetItemId, metadata,
            artifactKey, previewKey, previewMime, expiresAt]
    )
    const storage = getCommunityObjectStorage()
    const artifactUploadUrl = await storage.signPut(artifactKey, { contentType: handler.format.mime, expiresIn: 900 })
    const previewUploadUrl = previewKey
        ? await storage.signPut(previewKey, { contentType: previewMime, expiresIn: 900 })
        : null
    audit(req, 'upload_session_created', { uploadId, type: handler.id, targetItemId })
    res.status(201).json({
        schemaVersion: 1,
        token,
        expiresAt: expiresAt.toISOString(),
        limits: { artifactBytes: handler.maxBytes, previewBytes: MAX_PREVIEW_BYTES },
        uploads: {
            artifact: { objectKey: artifactKey, mimeType: handler.format.mime, uploadUrl: artifactUploadUrl },
            preview: previewKey ? { objectKey: previewKey, mimeType: previewMime, uploadUrl: previewUploadUrl } : null
        }
    })
}))

router.post('/community/uploads/:token/finalize', requireSession, asyncRoute(async (req, res) => {
    const access = await requirePublishingAccess(req, res)
    if(!access) return
    const tokenHash = hashToken(req.params.token)
    const claimed = await db.query(
        `update community_upload_sessions set state = 'finalizing'
         where token_hash = $1 and user_id = $2 and state = 'pending' and expires_at > now()
         returning *`,
        [tokenHash, req.userId]
    )
    if(claimed.rows.length === 0) {
        res.status(404).json({ error: 'upload_session_invalid_or_expired' })
        return
    }
    const upload = claimed.rows[0]
    const handler = getTypeHandler(upload.type)
    let tempDirectory = null
    let storage = null
    const writtenPreviewKeys = []
    const writtenRenderAssetKeys = []
    try {
        const metadata = cleanMetadata(upload.metadata)
        storage = getCommunityObjectStorage()
        tempDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ag-community-'))
        const artifactPath = path.join(tempDirectory, `artifact.${handler.format.extension}`)
        const head = await storage.head(upload.artifact_pending_key)
        if(Number(head.ContentLength) < 1 || Number(head.ContentLength) > handler.maxBytes) {
            throw new CommunityValidationError('invalid_artifact_size', `Artifact must be between 1 and ${handler.maxBytes} bytes.`)
        }
        await storage.getToFile(upload.artifact_pending_key, artifactPath, { maxBytes: handler.maxBytes })
        const validated = await handler.validate({
            filePath: artifactPath,
            options: { showcase: metadata.showcase, indexComponents: handler.id === TYPES.RESOURCE_PACKS }
        })
        let previewBuffer = validated.previewBuffer || null
        if(upload.preview_pending_key) {
            const previewHead = await storage.head(upload.preview_pending_key)
            if(Number(previewHead.ContentLength) > MAX_PREVIEW_BYTES) {
                throw new CommunityValidationError('invalid_preview_size', `Preview may not exceed ${MAX_PREVIEW_BYTES} bytes.`)
            }
            previewBuffer = await storage.getBuffer(upload.preview_pending_key, { maxBytes: MAX_PREVIEW_BYTES })
        }
        if(!previewBuffer) previewBuffer = await fallbackPreview(handler.id)
        const variants = await createPreviewVariants(previewBuffer)
        const revisionId = crypto.randomUUID()
        const artifactKey = `community/${handler.id}/${validated.sha256.slice(0, 2)}/${validated.sha256}.${handler.format.extension}`
        if(validated.serialized != null) {
            await storage.putImmutable(artifactKey, Buffer.from(validated.serialized, 'utf8'), {
                contentType: handler.format.mime,
                cacheControl: 'private, max-age=31536000, immutable',
                metadata: { sha256: validated.sha256, format: handler.format.id, version: String(handler.format.version) }
            })
        } else {
            await storage.putImmutableFile(artifactKey, artifactPath, validated, {
                contentType: handler.format.mime,
                cacheControl: 'private, max-age=31536000, immutable',
                metadata: { format: handler.format.id, version: String(handler.format.version) }
            })
        }
        for(const variant of variants) {
            variant.objectKey = `community/previews/${revisionId}/${variant.label}.${variant.extension}`
            const write = await storage.putImmutable(variant.objectKey, variant.buffer, {
                contentType: variant.mime,
                cacheControl: 'private, max-age=31536000, immutable'
            })
            if(!write.existing) writtenPreviewKeys.push(variant.objectKey)
        }
        const renderAssets = []
        for(const asset of validated.renderAssets || []) {
            const objectKey = `community/render-assets/${revisionId}/${asset.sha256}.zip`
            const write = await storage.putImmutable(objectKey, asset.bytes, {
                contentType: asset.mimeType,
                cacheControl: 'private, max-age=31536000, immutable',
                metadata: { sha256: asset.sha256, role: asset.role }
            })
            if(!write.existing) writtenRenderAssetKeys.push(objectKey)
            renderAssets.push({ ...asset, objectKey, sizeBytes: asset.bytes.length })
        }

        const result = await db.withClient(async client => {
            await client.query('begin')
            try {
                const lock = await client.query(
                    `select * from community_upload_sessions
                     where id = $1 and user_id = $2 and state = 'finalizing' for update`,
                    [upload.id, req.userId]
                )
                if(lock.rows.length === 0) throw Object.assign(new Error('Upload session was already consumed.'), { statusCode: 409 })
                let itemId = upload.target_item_id
                let revisionNumber = 1
                let alreadyCurrent = false
                if(itemId) {
                    const item = await client.query('select * from community_items where id = $1 and type = $2 for update', [itemId, handler.id])
                    const row = item.rows[0]
                    if(!row || (Number(row.owner_id) !== Number(req.userId) && !access.admin)) {
                        throw Object.assign(new Error('Community item ownership changed during upload.'), { statusCode: 403 })
                    }
                    const current = await client.query('select sha256, revision_number from community_revisions where id = $1', [row.current_revision_id])
                    if(current.rows[0]?.sha256 === validated.sha256) {
                        alreadyCurrent = true
                        revisionNumber = Number(current.rows[0].revision_number)
                    } else {
                        const latest = await client.query('select coalesce(max(revision_number), 0) as number from community_revisions where item_id = $1', [itemId])
                        revisionNumber = Number(latest.rows[0].number) + 1
                    }
                    await client.query(
                        `update community_items set title=$2, description=$3, tags=$4, license=$5,
                         rights_attested_at=now(), updated_at=now(), status='active' where id=$1`,
                        [itemId, metadata.title, metadata.description, metadata.tags, metadata.license]
                    )
                } else {
                    itemId = crypto.randomUUID()
                    await client.query(
                        `insert into community_items
                         (id, type, owner_id, title, description, tags, license, rights_attested_at, visibility, status)
                         values ($1,$2,$3,$4,$5,$6,$7,now(),'public','active')`,
                        [itemId, handler.id, req.userId, metadata.title, metadata.description, metadata.tags, metadata.license]
                    )
                }
                if(!alreadyCurrent) {
                    const dependencies = await resolveDependencies(client, validated.dependencies, itemId)
                    await client.query(
                        `insert into community_revisions
                         (id, item_id, revision_number, sha256, size_bytes, mime_type, extension,
                          format_id, format_version, compatibility, type_data, object_key, created_by)
                         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
                        [revisionId, itemId, revisionNumber, validated.sha256, validated.sizeBytes,
                            handler.format.mime, handler.format.extension, handler.format.id, handler.format.version,
                            metadata.compatibility, validated.typeData || {}, artifactKey, req.userId]
                    )
                    await client.query(
                        `insert into community_revision_sources(revision_id,provider,object_key,last_verified_at)
                         values ($1,'r2',$2,now())`,
                        [revisionId, artifactKey]
                    )
                    for(const dependency of dependencies) {
                        await client.query(
                            `insert into community_revision_dependencies
                             (revision_id, dependency_type, dependency_item_id, dependency_revision_id, required, install_order)
                             values ($1,$2,$3,$4,$5,$6)`,
                            [revisionId, dependency.type, dependency.itemId, dependency.revisionId, dependency.required, dependency.installOrder]
                        )
                    }
                    for(const variant of variants) {
                        await client.query(
                            `insert into community_revision_previews
                             (revision_id, size_label, mime_type, object_key, width, height, size_bytes)
                             values ($1,$2,$3,$4,$5,$6,$7)`,
                            [revisionId, variant.label, variant.mime, variant.objectKey, variant.width, variant.height, variant.buffer.length]
                        )
                    }
                    for(const asset of renderAssets) {
                        await client.query(
                            `insert into community_revision_assets
                             (revision_id, role, object_key, sha256, size_bytes, mime_type, metadata)
                             values ($1,$2,$3,$4,$5,$6,$7)`,
                            [revisionId, asset.role, asset.objectKey, asset.sha256, asset.sizeBytes, asset.mimeType, asset.metadata || {}]
                        )
                    }
                    if(handler.id === TYPES.RESOURCE_PACKS && validated.compositionIndex) {
                        await persistCompositionIndex(client, {
                            revisionId,
                            itemId,
                            ownerId: req.userId,
                            index: validated.compositionIndex,
                            enabled: config.community.packStudioEnabled && metadata.packStudioOptIn === true
                        })
                    }
                    await client.query('update community_items set current_revision_id = $2, updated_at = now() where id = $1', [itemId, revisionId])
                }
                await client.query(
                    `update community_upload_sessions set state='consumed', consumed_at=now()
                     where id=$1 and state='finalizing'`,
                    [upload.id]
                )
                await client.query('commit')
                return { itemId, alreadyCurrent }
            } catch(error) {
                await client.query('rollback')
                throw error
            }
        })
        if(result.alreadyCurrent) {
            await Promise.all(writtenPreviewKeys.map(key => storage.delete(key).catch(() => {})))
            await Promise.all(writtenRenderAssetKeys.map(key => storage.delete(key).catch(() => {})))
        }
        const row = await getItem(handler.id, result.itemId, { includeInactive: true })
        audit(req, result.alreadyCurrent ? 'revision_already_current' : 'revision_published', {
            itemId: result.itemId,
            type: handler.id,
            revisionId: row.revision_id,
            sha256: row.sha256
        })
        await storage.delete(upload.artifact_pending_key).catch(() => {})
        if(upload.preview_pending_key) await storage.delete(upload.preview_pending_key).catch(() => {})
        res.status(result.alreadyCurrent ? 200 : 201).json({ ...itemJson(row, true), alreadyCurrent: result.alreadyCurrent })
    } catch(error) {
        await db.query(
            `update community_upload_sessions set state='failed'
             where id=$1 and state='finalizing'`,
            [upload.id]
        ).catch(() => {})
        await Promise.all(writtenPreviewKeys.map(key => storage?.delete(key).catch(() => {})))
        await Promise.all(writtenRenderAssetKeys.map(key => storage?.delete(key).catch(() => {})))
        throw error
    } finally {
        await safeRemoveTemp(tempDirectory)
    }
}))

router.get('/community/items/:type/:id', asyncRoute(async (req, res) => {
    const handler = getTypeHandler(req.params.type)
    const id = parseUuid(req.params.id)
    const row = await getItem(handler.id, id)
    if(!row) {
        res.status(404).json({ error: 'community_item_not_found' })
        return
    }
    res.set('Cache-Control', 'public, max-age=60, stale-if-error=86400')
    res.json(itemJson(row, true))
}))

router.get('/community/items/:type/:id/download', asyncRoute(async (req, res) => {
    const handler = getTypeHandler(req.params.type)
    const row = await getItem(handler.id, parseUuid(req.params.id))
    if(!row) {
        res.status(404).json({ error: 'community_item_not_found' })
        return
    }
    const descriptor = await resolveCommunityRevisionDownload(row)
    await db.query('update community_items set downloads = downloads + 1 where id = $1', [row.id])
    res.set('Cache-Control', 'private, no-store')
    res.json({
        schemaVersion: 1,
        type: row.type,
        itemId: row.id,
        revision: itemJson(row).revision,
        provider: descriptor.provider,
        expiresAt: descriptor.expiresAt,
        downloadUrl: descriptor.downloadUrl
    })
}))

router.get('/community/items/:type/:id/preview-assets', asyncRoute(async (req, res) => {
    if(!config.community.richPreviewsEnabled) {
        res.status(404).json({ error: 'community_rich_previews_disabled' })
        return
    }
    const handler = getTypeHandler(req.params.type)
    const row = await getItem(handler.id, parseUuid(req.params.id))
    if(!row) {
        res.status(404).json({ error: 'community_item_not_found' })
        return
    }
    const result = await db.query(
        `select role, object_key, sha256, size_bytes, mime_type, metadata
         from community_revision_assets where revision_id=$1 order by role, sha256`,
        [row.revision_id]
    )
    const storage = getCommunityObjectStorage()
    const assets = await Promise.all(result.rows.map(async asset => ({
        role: asset.role,
        sha256: asset.sha256,
        sizeBytes: Number(asset.size_bytes),
        mimeType: asset.mime_type,
        downloadUrl: await storage.signGet(asset.object_key, 900),
        metadata: typeof asset.metadata === 'string' ? JSON.parse(asset.metadata) : asset.metadata
    })))
    res.set('Cache-Control', 'private, no-store')
    res.json({ schemaVersion: 1, revisionId: row.revision_id, assets })
}))

router.get('/community/items/:type/:id/preview', asyncRoute(async (req, res) => {
    const handler = getTypeHandler(req.params.type)
    const row = await getItem(handler.id, parseUuid(req.params.id))
    if(!row) {
        res.status(404).json({ error: 'community_item_not_found' })
        return
    }
    const size = req.query.size === 'medium' ? 'medium' : 'tiny'
    const acceptsWebp = String(req.headers.accept || '').includes('image/webp')
    const preview = await db.query(
        `select object_key, mime_type from community_revision_previews
         where revision_id=$1 and size_label=$2
         order by case when mime_type=$3 then 0 else 1 end limit 1`,
        [row.revision_id, size, acceptsWebp ? 'image/webp' : 'image/png']
    )
    if(preview.rows.length === 0) {
        res.status(404).json({ error: 'community_preview_not_found' })
        return
    }
    const url = await getCommunityObjectStorage().signGet(preview.rows[0].object_key, 900)
    res.set('Cache-Control', 'private, no-store')
    res.redirect(302, url)
}))

router.patch('/community/items/:type/:id', requireSession, asyncRoute(async (req, res) => {
    const handler = getTypeHandler(req.params.type)
    const id = parseUuid(req.params.id)
    const row = await getItem(handler.id, id, { includeInactive: true })
    if(!row) {
        res.status(404).json({ error: 'community_item_not_found' })
        return
    }
    const admin = await userIsAdmin(req.userId)
    if(Number(row.owner_id) !== Number(req.userId) && !admin) {
        res.status(403).json({ error: 'not_owner' })
        return
    }
    const metadata = cleanMetadata({
        title: req.body.title ?? row.title,
        description: req.body.description ?? row.description,
        tags: req.body.tags ?? row.tags,
        license: req.body.license ?? row.license,
        visibility: 'public',
        rightsAttested: req.body.rightsAttested === true || req.body.license == null,
        compatibility: row.compatibility
    })
    await db.query(
        `update community_items set title=$2, description=$3, tags=$4, license=$5,
         rights_attested_at=case when $6 then now() else rights_attested_at end, updated_at=now()
         where id=$1`,
        [id, metadata.title, metadata.description, metadata.tags, metadata.license, req.body.rightsAttested === true]
    )
    audit(req, 'item_updated', { itemId: id, type: handler.id })
    res.json(itemJson(await getItem(handler.id, id, { includeInactive: true }), true))
}))

router.delete('/community/items/:type/:id', requireSession, asyncRoute(async (req, res) => {
    const handler = getTypeHandler(req.params.type)
    const id = parseUuid(req.params.id)
    const row = await getItem(handler.id, id, { includeInactive: true })
    if(!row) {
        res.status(404).json({ error: 'community_item_not_found' })
        return
    }
    const admin = await userIsAdmin(req.userId)
    if(Number(row.owner_id) !== Number(req.userId) && !admin) {
        res.status(403).json({ error: 'not_owner' })
        return
    }
    await db.query('update community_items set status=\'deleted\', updated_at=now() where id=$1', [id])
    audit(req, 'item_deleted', { itemId: id, type: handler.id })
    res.status(204).end()
}))

router.post('/community/items/:type/:id/like', requireSession, asyncRoute(async (req, res) => {
    const handler = getTypeHandler(req.params.type)
    const id = parseUuid(req.params.id)
    if(!await getItem(handler.id, id)) {
        res.status(404).json({ error: 'community_item_not_found' })
        return
    }
    const result = await db.withClient(async client => {
        await client.query('begin')
        try {
            const inserted = await client.query(
                'insert into community_likes(item_id,user_id) values($1,$2) on conflict do nothing returning item_id',
                [id, req.userId]
            )
            if(inserted.rows.length) await client.query('update community_items set likes=likes+1 where id=$1', [id])
            const count = await client.query('select likes from community_items where id=$1', [id])
            await client.query('commit')
            return Number(count.rows[0].likes)
        } catch(error) {
            await client.query('rollback')
            throw error
        }
    })
    res.json({ liked: true, likes: result })
}))

router.delete('/community/items/:type/:id/like', requireSession, asyncRoute(async (req, res) => {
    const handler = getTypeHandler(req.params.type)
    const id = parseUuid(req.params.id)
    if(!await getItem(handler.id, id)) {
        res.status(404).json({ error: 'community_item_not_found' })
        return
    }
    const result = await db.withClient(async client => {
        await client.query('begin')
        try {
            const deleted = await client.query('delete from community_likes where item_id=$1 and user_id=$2 returning item_id', [id, req.userId])
            if(deleted.rows.length) await client.query('update community_items set likes=greatest(likes-1,0) where id=$1', [id])
            const count = await client.query('select likes from community_items where id=$1', [id])
            await client.query('commit')
            return Number(count.rows[0].likes)
        } catch(error) {
            await client.query('rollback')
            throw error
        }
    })
    res.json({ liked: false, likes: result })
}))

router.post('/community/items/:type/:id/view', requireSession, asyncRoute(async (req, res) => {
    const handler = getTypeHandler(req.params.type)
    const id = parseUuid(req.params.id)
    if(!await getItem(handler.id, id)) {
        res.status(404).json({ error: 'community_item_not_found' })
        return
    }
    await db.withClient(async client => {
        await client.query('begin')
        try {
            const inserted = await client.query(
                `insert into community_views(item_id,user_id) values($1,$2)
                 on conflict(item_id,user_id) do update set viewed_at=now()
                 returning (xmax = 0) as inserted`,
                [id, req.userId]
            )
            if(inserted.rows[0]?.inserted) await client.query('update community_items set views=views+1 where id=$1', [id])
            await client.query('commit')
        } catch(error) {
            await client.query('rollback')
            throw error
        }
    })
    res.status(204).end()
}))

router.post('/community/items/:type/:id/report', requireSession, asyncRoute(async (req, res) => {
    const handler = getTypeHandler(req.params.type)
    const id = parseUuid(req.params.id)
    if(!await getItem(handler.id, id)) {
        res.status(404).json({ error: 'community_item_not_found' })
        return
    }
    if(!await consumeLimit(res, {
        subject: `user:${req.userId}`,
        action: 'report',
        limit: config.community.reportRateLimit,
        windowMs: 24 * 60 * 60 * 1000
    })) return
    const reason = cleanText(req.body.reason, 80)
    if(!reason) throw new CommunityValidationError('missing_report_reason', 'A report reason is required.')
    const result = await db.query(
        `insert into community_reports(item_id,reporter_id,reason,details)
         values($1,$2,$3,$4) returning id`,
        [id, req.userId, reason, cleanText(req.body.details, 1000)]
    )
    audit(req, 'item_reported', { itemId: id, type: handler.id, reportId: result.rows[0].id })
    res.status(201).json({ id: result.rows[0].id, status: 'open' })
}))

async function moderate(req, res, status) {
    if(!await userIsAdmin(req.userId)) {
        res.status(403).json({ error: 'admin_required' })
        return
    }
    const handler = getTypeHandler(req.params.type)
    const id = parseUuid(req.params.id)
    const result = await db.query(
        `update community_items set status=$3, updated_at=now()
         where id=$1 and type=$2 and status <> 'deleted' returning id`,
        [id, handler.id, status]
    )
    if(result.rows.length === 0) {
        res.status(404).json({ error: 'community_item_not_found' })
        return
    }
    audit(req, status === 'hidden' ? 'item_hidden' : 'item_restored', { itemId: id, type: handler.id })
    res.json({ id, type: handler.id, status })
}

router.post('/community/items/:type/:id/hide', requireSession, asyncRoute((req, res) => moderate(req, res, 'hidden')))
router.post('/community/items/:type/:id/restore', requireSession, asyncRoute((req, res) => moderate(req, res, 'active')))

router.get('/community/admin/reports', requireSession, asyncRoute(async (req, res) => {
    if(!await userIsAdmin(req.userId)) {
        res.status(403).json({ error: 'admin_required' })
        return
    }
    const result = await db.query(
        `select r.*, i.type, i.title from community_reports r
         join community_items i on i.id=r.item_id
         where ($1::text is null or r.status=$1)
         order by r.created_at desc limit 200`,
        [req.query.status ? cleanText(req.query.status, 16) : null]
    )
    res.json({ schemaVersion: 1, reports: result.rows })
}))

router.post('/community/admin/reports/:reportId/resolve', requireSession, asyncRoute(async (req, res) => {
    if(!await userIsAdmin(req.userId)) {
        res.status(403).json({ error: 'admin_required' })
        return
    }
    const reportId = parseUuid(req.params.reportId, 'reportId')
    const status = req.body.status === 'dismissed' ? 'dismissed' : 'resolved'
    const result = await db.query(
        `update community_reports set status=$2,resolved_by=$3,resolution_note=$4,resolved_at=now()
         where id=$1 and status='open' returning *`,
        [reportId, status, req.userId, cleanText(req.body.note, 1000)]
    )
    if(result.rows.length === 0) {
        res.status(404).json({ error: 'community_report_not_found' })
        return
    }
    audit(req, 'report_resolved', { itemId: result.rows[0].item_id, reportId, status })
    res.json(result.rows[0])
}))

router.get('/community/admin/audit', requireSession, asyncRoute(async (req, res) => {
    if(!await userIsAdmin(req.userId)) {
        res.status(403).json({ error: 'admin_required' })
        return
    }
    const result = await db.query('select * from community_audit_events order by created_at desc limit 500')
    res.json({ schemaVersion: 1, events: result.rows })
}))

module.exports = router
module.exports.optionalSession = optionalSession
module.exports._test = {
    cleanMetadata,
    cleanShowcase,
    getTypeHandler,
    hashToken,
    itemJson,
    parseUuid,
    resolveDependencies,
    safeRemoveTemp
}
