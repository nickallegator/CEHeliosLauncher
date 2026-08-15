begin;

alter table community_revisions alter column object_key drop not null;

create table if not exists external_accounts (
    user_id bigint not null references users(id) on delete cascade,
    provider text not null,
    provider_user_id text not null,
    username text,
    display_name text,
    avatar_url text,
    token_ciphertext text not null,
    token_iv text not null,
    token_tag text not null,
    token_key_id text not null,
    scopes text[] not null default '{}',
    token_expires_at timestamptz,
    connected_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (user_id, provider),
    unique (provider, provider_user_id),
    check (provider in ('modrinth'))
);

create table if not exists external_oauth_attempts (
    id uuid primary key,
    provider text not null,
    user_id bigint not null references users(id) on delete cascade,
    state_hash char(64) not null unique,
    status text not null default 'pending',
    error_code text,
    expires_at timestamptz not null,
    completed_at timestamptz,
    created_at timestamptz not null default now(),
    check (provider in ('modrinth')),
    check (status in ('pending','complete','failed'))
);

create index if not exists external_oauth_attempts_user_idx
    on external_oauth_attempts(user_id, provider, created_at desc);

create table if not exists community_external_sources (
    id uuid primary key,
    provider text not null,
    owner_id bigint not null references users(id) on delete cascade,
    item_id uuid references community_items(id) on delete set null,
    provider_project_id text not null,
    project_slug text,
    project_title text not null,
    team_id text not null,
    channels text[] not null default '{release}',
    status text not null default 'active',
    last_checked_at timestamptz,
    last_error text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (provider, provider_project_id),
    check (provider in ('modrinth')),
    check (status in ('active','disabled','ownership_lost','unavailable')),
    check (channels <@ array['release','beta','alpha']::text[])
);

create table if not exists community_external_candidates (
    id uuid primary key,
    source_id uuid not null references community_external_sources(id) on delete cascade,
    provider_version_id text not null,
    version_number text not null,
    release_channel text not null,
    file_name text,
    file_size bigint,
    file_sha512 char(128),
    state text not null default 'detected',
    prepared_sha256 char(64),
    prepared_data jsonb,
    detected_at timestamptz not null default now(),
    prepared_at timestamptz,
    published_at timestamptz,
    rejected_at timestamptz,
    unique (source_id, provider_version_id),
    check (release_channel in ('release','beta','alpha')),
    check (state in ('detected','prepared','published','rejected','superseded'))
);

create index if not exists community_external_candidates_source_idx
    on community_external_candidates(source_id, detected_at desc);

create table if not exists community_revision_sources (
    revision_id uuid primary key references community_revisions(id) on delete cascade,
    provider text not null,
    object_key text,
    provider_project_id text,
    provider_version_id text,
    provider_file_name text,
    provider_sha512 char(128),
    provider_version_number text,
    provider_project_url text,
    provider_creator jsonb,
    available boolean not null default true,
    last_verified_at timestamptz,
    unavailable_reason text,
    created_at timestamptz not null default now(),
    check (provider in ('r2','modrinth')),
    check ((provider = 'r2' and object_key is not null) or
           (provider = 'modrinth' and provider_project_id is not null and provider_version_id is not null and provider_sha512 is not null))
);

insert into community_revision_sources(revision_id, provider, object_key, last_verified_at)
select id, 'r2', object_key, created_at
from community_revisions
where object_key is not null
on conflict (revision_id) do nothing;

commit;
