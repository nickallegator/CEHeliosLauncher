begin;

alter table community_external_sources
    add column if not exists provider_project_status text;

-- Every Modrinth source tracked before this migration passed the old
-- approved-only gate, so this backfill is exact rather than inferred.
update community_external_sources
set provider_project_status = 'approved'
where provider = 'modrinth' and provider_project_status is null;

alter table community_revision_sources
    add column if not exists provider_project_status text;

-- The same approved-only invariant applied to all previously published
-- Modrinth revisions. R2 revisions intentionally retain null here.
update community_revision_sources
set provider_project_status = 'approved'
where provider = 'modrinth' and provider_project_status is null;

do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'community_external_sources_project_status_check') then
        alter table community_external_sources
            add constraint community_external_sources_project_status_check
            check (provider <> 'modrinth' or provider_project_status in ('approved', 'unlisted'));
    end if;
    if not exists (select 1 from pg_constraint where conname = 'community_revision_sources_project_status_check') then
        alter table community_revision_sources
            add constraint community_revision_sources_project_status_check
            check (provider <> 'modrinth' or provider_project_status in ('approved', 'unlisted'));
    end if;
end $$;

commit;
