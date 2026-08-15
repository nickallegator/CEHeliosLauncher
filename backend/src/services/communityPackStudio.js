'use strict'

const crypto = require('crypto')
const { COMPONENT_KINDS, resolveComposition } = require('@allegator-games/resource-pack-studio')

const COMPONENT_LIMIT = 60
const SELECTION_LIMIT = 512
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i

function cleanText(value, max = 100) {
    return String(value || '').trim().slice(0, max)
}

function encodeCursor(value) {
    return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function decodeCursor(value) {
    if(!value) return null
    try {
        const decoded = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'))
        if(!UUID.test(decoded.id)) throw new Error('invalid cursor')
        return decoded
    } catch(_error) {
        const error = new Error('Pack Studio cursor is invalid.')
        error.code = 'invalid_composer_cursor'
        error.statusCode = 400
        throw error
    }
}

async function persistCompositionIndex(client, { revisionId, itemId, ownerId, index, enabled = null }) {
    if(!index?.components || !index?.files) return
    const notices = new Set((index.notices || []).map(value => value.path.toLowerCase()))
    const componentKeys = [...new Set(index.components.map(value => String(value.key).toLowerCase()))]
    await client.query(
        `delete from community_resource_components
         where revision_id=$1 and not (component_key=any($2::text[]))`,
        [revisionId, componentKeys]
    )
    for(const file of index.files) {
        await client.query(
            `insert into community_resource_pack_files(revision_id,path,path_key,sha256,size_bytes,metadata)
             values ($1,$2,$3,$4,$5,$6)
             on conflict (revision_id,path_key) do update set sha256=excluded.sha256,size_bytes=excluded.size_bytes,metadata=excluded.metadata`,
            [revisionId, file.path, file.path.toLowerCase(), file.sha256, file.sizeBytes, notices.has(file.path.toLowerCase()) ? { notice: true } : {}]
        )
    }
    for(const component of index.components) {
        const componentId = crypto.randomUUID()
        const inserted = await client.query(
            `insert into community_resource_components
             (id,revision_id,component_key,kind,identifier,title,namespace,content_sha256,metadata,merge_fragments,search_text)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
             on conflict (revision_id,component_key) do update set
               kind=excluded.kind,identifier=excluded.identifier,title=excluded.title,namespace=excluded.namespace,
               content_sha256=excluded.content_sha256,metadata=excluded.metadata,merge_fragments=excluded.merge_fragments,
               search_text=excluded.search_text
             returning id`,
            [componentId, revisionId, component.key, component.kind, component.identifier, component.title,
                component.namespace, component.contentSha256, component.metadata || {}, component.mergeFragments || [],
                `${component.title} ${component.identifier} ${component.kind} ${component.namespace} ${(component.metadata?.pokemonForms || component.metadata?.pokemonVariants || []).flatMap(variant => [variant.label, ...(variant.aspects || []), ...(variant.shiny?.declared ? ['shiny'] : [])]).join(' ')}`]
        )
        const id = inserted.rows[0].id
        await client.query('delete from community_resource_component_files where component_id=$1', [id])
        for(const filePath of component.filePaths || []) {
            await client.query(
                `insert into community_resource_component_files(component_id,revision_id,path_key,role)
                 values ($1,$2,$3,'resource') on conflict do nothing`,
                [id, revisionId, filePath.toLowerCase()]
            )
        }
    }
    if(typeof enabled === 'boolean') await client.query(
        `insert into community_resource_pack_composition_grants
         (revision_id,item_id,enabled,terms_version,granted_by,granted_at,revoked_at,updated_at)
         values ($1,$2,$3,1,$4,case when $3 then now() else null end,null,now())
         on conflict (revision_id) do update set item_id=excluded.item_id,enabled=excluded.enabled,
           terms_version=excluded.terms_version,granted_by=excluded.granted_by,
           granted_at=case when excluded.enabled then now() else community_resource_pack_composition_grants.granted_at end,
           revoked_at=case when excluded.enabled then null else now() end,updated_at=now()`,
        [revisionId, itemId, enabled, ownerId]
    )
}

async function listComponents(db, input = {}) {
    const params = []
    const add = value => { params.push(value); return `$${params.length}` }
    const where = ['i.type=\'resource-packs\'', 'i.status=\'active\'', 'i.visibility=\'public\'', 'g.enabled=true']
    const kind = cleanText(input.kind, 32).toLowerCase()
    if(kind) {
        if(!COMPONENT_KINDS.includes(kind)) throw Object.assign(new Error('Unsupported Pack Studio component kind.'), { statusCode: 400, code: 'invalid_component_kind' })
        where.push(`c.kind=${add(kind)}`)
    }
    const query = cleanText(input.query, 100)
    if(query) where.push(`to_tsvector('simple',c.search_text) @@ plainto_tsquery('simple',${add(query)})`)
    const creator = cleanText(input.creator, 80)
    if(creator) where.push(`coalesce(u.display_name,'') ilike ${add(`%${creator}%`)}`)
    const namespace = cleanText(input.namespace, 64).toLowerCase()
    if(namespace) where.push(`c.namespace=${add(namespace)}`)
    const license = cleanText(input.license, 64)
    if(license) where.push(`i.license=${add(license)}`)
    const source = cleanText(input.source, 80)
    if(source) where.push(`i.title ilike ${add(`%${source}%`)}`)
    const tags = cleanText(input.tags, 240).split(',').map(value => value.trim()).filter(Boolean).slice(0, 12)
    if(tags.length) where.push(`i.tags @> ${add(tags)}::text[]`)
    const cursor = decodeCursor(input.cursor)
    if(cursor) where.push(`(c.title,c.id) > (${add(cursor.title)},${add(cursor.id)}::uuid)`)
    const limit = Math.min(COMPONENT_LIMIT, Math.max(1, Number(input.limit) || 30))
    params.push(limit + 1)
    const result = await db.query(
        `select c.id,c.component_key,c.kind,c.identifier,c.title,c.namespace,c.content_sha256,c.metadata,
                c.revision_id,i.id as item_id,i.title as source_title,i.description as source_description,
                i.tags,i.license,i.owner_id,u.display_name as creator_name,
                r.revision_number,r.sha256 as revision_sha256,r.size_bytes as revision_size_bytes,r.compatibility,
                coalesce((select sum(f.size_bytes) from community_resource_component_files cf
                  join community_resource_pack_files f on f.revision_id=cf.revision_id and f.path_key=cf.path_key
                  where cf.component_id=c.id),0) as component_size_bytes,
                coalesce((select count(*) from community_resource_component_files cf where cf.component_id=c.id),0) as file_count
         from community_resource_components c
         join community_revisions r on r.id=c.revision_id
         join community_items i on i.id=r.item_id
         join community_resource_pack_composition_grants g on g.revision_id=r.id
         left join users u on u.id=i.owner_id
         where ${where.join(' and ')}
         order by c.title,c.id limit $${params.length}`,
        params
    )
    const hasMore = result.rows.length > limit
    const rows = result.rows.slice(0, limit)
    return {
        schemaVersion: 1,
        items: rows.map(row => ({
            key: row.component_key,
            kind: row.kind,
            identifier: row.identifier,
            title: row.title,
            namespace: row.namespace,
            contentSha256: row.content_sha256,
            metadata: row.metadata || {},
            sizeBytes: Number(row.component_size_bytes),
            fileCount: Number(row.file_count),
            source: {
                itemId: row.item_id,
                title: row.source_title,
                description: row.source_description || '',
                creator: row.creator_name || 'Minecraft Player',
                creatorId: row.owner_id == null ? null : String(row.owner_id),
                tags: row.tags || [],
                license: row.license,
                revisionId: row.revision_id,
                revisionNumber: Number(row.revision_number),
                revisionSha256: row.revision_sha256,
                revisionSizeBytes: Number(row.revision_size_bytes),
                compatibility: row.compatibility || {}
            }
        })),
        nextCursor: hasMore && rows.length ? encodeCursor({ title: rows.at(-1).title, id: rows.at(-1).id }) : null
    }
}

async function loadSourcesForSelections(db, selections) {
    if(!Array.isArray(selections) || selections.length < 1 || selections.length > SELECTION_LIMIT) {
        throw Object.assign(new Error(`Select between 1 and ${SELECTION_LIMIT} Pack Studio components.`), { statusCode: 400, code: 'invalid_component_selection' })
    }
    const revisionIds = [...new Set(selections.map(value => String(value?.sourceRevisionId || '').toLowerCase()))]
    if(revisionIds.some(value => !UUID.test(value))) throw Object.assign(new Error('Pack Studio selection contains an invalid revision.'), { statusCode: 400, code: 'invalid_revision_id' })
    const result = await db.query(
        `select r.id as revision_id,r.sha256,r.size_bytes,r.object_key,r.compatibility,
                i.id as item_id,i.title,i.license,i.status,i.visibility,i.current_revision_id,u.display_name as creator,
                g.enabled,g.terms_version
         from community_revisions r join community_items i on i.id=r.item_id
         join community_resource_pack_composition_grants g on g.revision_id=r.id
         left join users u on u.id=i.owner_id where r.id=any($1::uuid[])`,
        [revisionIds]
    )
    if(result.rows.length !== revisionIds.length || result.rows.some(row => !row.enabled || row.status !== 'active' || row.visibility !== 'public')) {
        throw Object.assign(new Error('One or more Pack Studio sources are unavailable or no longer opted in.'), { statusCode: 409, code: 'composition_source_unavailable' })
    }
    const sources = []
    for(const row of result.rows) {
        const componentRows = await db.query(
            `select c.component_key,c.kind,c.identifier,c.title,c.namespace,c.content_sha256,c.metadata,c.merge_fragments,
                    coalesce(jsonb_agg(jsonb_build_object('path',f.path,'sha256',f.sha256,'sizeBytes',f.size_bytes)
                      order by f.path) filter (where f.path is not null),'[]'::jsonb) as files
             from community_resource_components c
             left join community_resource_component_files cf on cf.component_id=c.id
             left join community_resource_pack_files f on f.revision_id=cf.revision_id and f.path_key=cf.path_key
             where c.revision_id=$1 group by c.id order by c.component_key`,
            [row.revision_id]
        )
        const fileMap = new Map()
        const components = componentRows.rows.map(component => {
            for(const file of component.files || []) fileMap.set(file.path.toLowerCase(), file)
            return {
                key: component.component_key,
                kind: component.kind,
                identifier: component.identifier,
                title: component.title,
                namespace: component.namespace,
                contentSha256: component.content_sha256,
                metadata: component.metadata || {},
                mergeFragments: component.merge_fragments || [],
                filePaths: (component.files || []).map(file => file.path)
            }
        })
        const noticeRows = await db.query(
            `select path,sha256,size_bytes as "sizeBytes" from community_resource_pack_files
             where revision_id=$1 and metadata @> '{"notice":true}'::jsonb order by path`,
            [row.revision_id]
        )
        sources.push({
            revisionId: row.revision_id,
            itemId: row.item_id,
            title: row.title,
            creator: row.creator || 'Minecraft Player',
            license: row.license,
            sha256: row.sha256,
            sizeBytes: Number(row.size_bytes),
            objectKey: row.object_key,
            compatibility: row.compatibility || {},
            currentRevisionId: row.current_revision_id,
            files: [...fileMap.values()],
            notices: noticeRows.rows.map(value => ({ path: value.path, sha256: value.sha256, sizeBytes: Number(value.sizeBytes) })),
            components
        })
    }
    return sources
}

function componentUpdateDiff(previous, current) {
    if(!current) return { available: false, contentChanged: true, added: [], removed: previous.filePaths || [], changed: [] }
    const previousFiles = new Map((previous.files || []).map(file => [file.path.toLowerCase(), file]))
    const currentFiles = new Map((current.files || []).map(file => [file.path.toLowerCase(), file]))
    return {
        available: true,
        contentChanged: previous.contentSha256 !== current.contentSha256,
        added: [...currentFiles.keys()].filter(key => !previousFiles.has(key)).sort(),
        removed: [...previousFiles.keys()].filter(key => !currentFiles.has(key)).sort(),
        changed: [...currentFiles.keys()].filter(key => previousFiles.has(key) && previousFiles.get(key).sha256 !== currentFiles.get(key).sha256).sort()
    }
}

async function describeCompositionUpdates(db, sources, selections) {
    const updates = new Map()
    for(const source of sources) {
        if(!source.currentRevisionId || source.currentRevisionId === source.revisionId) continue
        const selectedKeys = selections.filter(value => value.sourceRevisionId === source.revisionId).map(value => value.componentKey)
        const result = await db.query(
            `select r.id,r.revision_number,r.sha256,c.component_key,c.content_sha256,
                    coalesce(jsonb_agg(jsonb_build_object('path',f.path,'sha256',f.sha256) order by f.path)
                      filter (where f.path is not null),'[]'::jsonb) as files
             from community_revisions r
             join community_resource_pack_composition_grants g on g.revision_id=r.id and g.enabled=true
             left join community_resource_components c on c.revision_id=r.id and c.component_key=any($2::text[])
             left join community_resource_component_files cf on cf.component_id=c.id
             left join community_resource_pack_files f on f.revision_id=cf.revision_id and f.path_key=cf.path_key
             where r.id=$1 group by r.id,c.id order by c.component_key`,
            [source.currentRevisionId, selectedKeys]
        )
        if(!result.rows.length) continue
        const currentByKey = new Map(result.rows.filter(row => row.component_key).map(row => [row.component_key, {
            contentSha256: row.content_sha256,
            files: row.files || []
        }]))
        updates.set(String(source.revisionId), {
            revisionId: result.rows[0].id,
            revisionNumber: Number(result.rows[0].revision_number),
            sha256: result.rows[0].sha256,
            components: selectedKeys.map(key => {
                const previous = source.components.find(value => value.key === key)
                const previousFiles = (previous?.filePaths || []).map(filePath => source.files.find(file => file.path.toLowerCase() === filePath.toLowerCase())).filter(Boolean)
                return { componentKey: key, ...componentUpdateDiff({ ...previous, files: previousFiles }, currentByKey.get(key)) }
            })
        })
    }
    return updates
}

module.exports = {
    COMPONENT_LIMIT,
    SELECTION_LIMIT,
    componentUpdateDiff,
    describeCompositionUpdates,
    listComponents,
    loadSourcesForSelections,
    persistCompositionIndex,
    resolveComposition
}
