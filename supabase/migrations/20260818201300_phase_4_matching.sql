create table public.matching_participant_tokens (
  id uuid primary key default gen_random_uuid(),
  registration_id uuid not null,
  event_id uuid not null,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'active' check (status in ('active', 'revoked')),
  issued_by text not null check (char_length(trim(issued_by)) > 0),
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_by text,
  revocation_reason text,
  foreign key (registration_id, event_id)
    references public.registrations(id, event_id)
    on delete cascade,
  check (expires_at > issued_at),
  check (
    (status = 'active' and revoked_at is null and revoked_by is null and revocation_reason is null)
    or
    (
      status = 'revoked'
      and revoked_at is not null
      and revoked_by is not null
      and char_length(trim(revoked_by)) > 0
      and revocation_reason is not null
      and char_length(trim(revocation_reason)) > 0
    )
  )
);

create unique index matching_participant_tokens_one_active_idx
  on public.matching_participant_tokens(registration_id)
  where status = 'active';

create index matching_participant_tokens_event_issued_idx
  on public.matching_participant_tokens(event_id, issued_at desc);

create table public.matching_participant_profiles (
  id uuid primary key default gen_random_uuid(),
  public_id uuid not null unique default gen_random_uuid(),
  registration_id uuid not null unique,
  event_id uuid not null,
  display_name text not null check (
    char_length(trim(display_name)) between 1 and 80
  ),
  bio text check (bio is null or char_length(bio) <= 500),
  status text not null default 'active' check (status in ('active', 'inactive')),
  activated_at timestamptz not null default now(),
  deactivated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (registration_id, event_id)
    references public.registrations(id, event_id)
    on delete cascade,
  unique (id, event_id),
  unique (public_id, event_id),
  check (
    (status = 'active' and deactivated_at is null)
    or (status = 'inactive' and deactivated_at is not null)
  )
);

create index matching_participant_profiles_event_status_idx
  on public.matching_participant_profiles(event_id, status, display_name, public_id);

create table public.matching_likes (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  liker_profile_id uuid not null,
  liked_profile_id uuid not null,
  created_at timestamptz not null default now(),
  foreign key (liker_profile_id, event_id)
    references public.matching_participant_profiles(id, event_id)
    on delete cascade,
  foreign key (liked_profile_id, event_id)
    references public.matching_participant_profiles(id, event_id)
    on delete cascade,
  unique (event_id, liker_profile_id, liked_profile_id),
  check (liker_profile_id <> liked_profile_id)
);

create index matching_likes_reverse_lookup_idx
  on public.matching_likes(event_id, liked_profile_id, liker_profile_id);

create table public.matching_matches (
  id uuid primary key default gen_random_uuid(),
  public_id uuid not null unique default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  profile_one_id uuid not null,
  profile_two_id uuid not null,
  notification_status text not null default 'pending'
    check (notification_status in ('pending', 'enqueued', 'suppressed')),
  created_at timestamptz not null default now(),
  foreign key (profile_one_id, event_id)
    references public.matching_participant_profiles(id, event_id)
    on delete cascade,
  foreign key (profile_two_id, event_id)
    references public.matching_participant_profiles(id, event_id)
    on delete cascade,
  unique (event_id, profile_one_id, profile_two_id),
  check (profile_one_id < profile_two_id)
);

create index matching_matches_profile_two_idx
  on public.matching_matches(event_id, profile_two_id, created_at desc);

alter table public.matching_participant_tokens enable row level security;
alter table public.matching_participant_profiles enable row level security;
alter table public.matching_likes enable row level security;
alter table public.matching_matches enable row level security;

revoke all on table public.matching_participant_tokens from public, anon, authenticated;
revoke all on table public.matching_participant_profiles from public, anon, authenticated;
revoke all on table public.matching_likes from public, anon, authenticated;
revoke all on table public.matching_matches from public, anon, authenticated;

grant select, insert, update on table public.matching_participant_tokens to service_role;
grant select, insert, update on table public.matching_participant_profiles to service_role;
grant select, insert on table public.matching_likes to service_role;
grant select, insert on table public.matching_matches to service_role;

create or replace function public.enforce_active_matching_token_eligibility()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.status <> 'active' then
    return new;
  end if;

  if not exists (
    select 1
      from public.registrations as registration
      where registration.id = new.registration_id
        and registration.event_id = new.event_id
        and registration.payment_status = 'paid'
        and exists (
          select 1
            from public.registration_check_ins as check_in
            where check_in.registration_id = registration.id
              and check_in.event_id = registration.event_id
              and check_in.status = 'checked_in'
        )
  ) then
    raise exception using errcode = 'P0001', message = 'matching_registration_not_eligible';
  end if;

  return new;
end;
$$;

create trigger matching_participant_tokens_eligibility_trigger
before insert or update of registration_id, event_id, status
on public.matching_participant_tokens
for each row execute function public.enforce_active_matching_token_eligibility();

create or replace function public.enforce_matching_match_mutual_likes()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not exists (
    select 1
      from public.matching_likes as first_like
      where first_like.event_id = new.event_id
        and first_like.liker_profile_id = new.profile_one_id
        and first_like.liked_profile_id = new.profile_two_id
  ) or not exists (
    select 1
      from public.matching_likes as second_like
      where second_like.event_id = new.event_id
        and second_like.liker_profile_id = new.profile_two_id
        and second_like.liked_profile_id = new.profile_one_id
  ) then
    raise exception using errcode = 'P0001', message = 'matching_match_requires_mutual_likes';
  end if;

  return new;
end;
$$;

create trigger matching_matches_mutual_likes_trigger
before insert or update of event_id, profile_one_id, profile_two_id
on public.matching_matches
for each row execute function public.enforce_matching_match_mutual_likes();

create or replace function public.issue_matching_participant_token(
  p_event_id uuid,
  p_registration_id uuid,
  p_token_hash text,
  p_issued_by text,
  p_expires_at timestamptz default null
)
returns table(token_id uuid, event_id uuid, token_status text)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  selected_registration public.registrations%rowtype;
  created_token public.matching_participant_tokens%rowtype;
  token_expires_at timestamptz;
begin
  if p_event_id is null or p_registration_id is null then
    raise exception using errcode = 'P0001', message = 'missing_matching_registration';
  end if;

  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'P0001', message = 'invalid_matching_token_hash';
  end if;

  if p_issued_by is null or char_length(trim(p_issued_by)) = 0 then
    raise exception using errcode = 'P0001', message = 'missing_matching_token_issuer';
  end if;

  if p_expires_at is not null and p_expires_at <= now() then
    raise exception using errcode = 'P0001', message = 'invalid_matching_token_expiry';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('marat_matching_registration:' || p_registration_id::text, 0)
  );

  select registration.*
    into selected_registration
    from public.registrations as registration
    where registration.id = p_registration_id
    for update;

  if not found or selected_registration.event_id <> p_event_id then
    raise exception using errcode = 'P0001', message = 'matching_registration_not_found';
  end if;

  if selected_registration.payment_status <> 'paid' then
    raise exception using errcode = 'P0001', message = 'matching_registration_not_paid';
  end if;

  if not exists (
    select 1
      from public.registration_check_ins as check_in
      where check_in.registration_id = selected_registration.id
        and check_in.event_id = selected_registration.event_id
        and check_in.status = 'checked_in'
  ) then
    raise exception using errcode = 'P0001', message = 'matching_registration_not_checked_in';
  end if;

  select coalesce(p_expires_at, event.starts_at + interval '2 days')
    into token_expires_at
    from public.events as event
    where event.id = selected_registration.event_id;

  if token_expires_at is null or token_expires_at <= now() then
    raise exception using errcode = 'P0001', message = 'matching_access_window_expired';
  end if;

  update public.matching_participant_tokens as token
    set
      status = 'revoked',
      revoked_at = now(),
      revoked_by = trim(p_issued_by),
      revocation_reason = 'reissued'
    where token.registration_id = selected_registration.id
      and token.status = 'active';

  insert into public.matching_participant_tokens (
    registration_id,
    event_id,
    token_hash,
    issued_by,
    expires_at
  ) values (
    selected_registration.id,
    selected_registration.event_id,
    p_token_hash,
    trim(p_issued_by),
    token_expires_at
  )
  returning * into created_token;

  return query
    select created_token.id, created_token.event_id, created_token.status;
end;
$$;

create or replace function public.revoke_matching_participant_token(
  p_event_id uuid,
  p_token_id uuid,
  p_revoked_by text,
  p_reason text
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  selected_token public.matching_participant_tokens%rowtype;
begin
  if p_event_id is null or p_token_id is null then
    raise exception using errcode = 'P0001', message = 'missing_matching_token_id';
  end if;

  if p_revoked_by is null or char_length(trim(p_revoked_by)) = 0 then
    raise exception using errcode = 'P0001', message = 'missing_matching_token_revoker';
  end if;

  if p_reason is null or char_length(trim(p_reason)) = 0 then
    raise exception using errcode = 'P0001', message = 'missing_matching_revocation_reason';
  end if;

  select token.*
    into selected_token
    from public.matching_participant_tokens as token
    where token.id = p_token_id;

  if not found or selected_token.event_id <> p_event_id then
    return false;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('marat_matching_registration:' || selected_token.registration_id::text, 0)
  );

  select token.*
    into selected_token
    from public.matching_participant_tokens as token
    where token.id = p_token_id
      and token.event_id = p_event_id
    for update;

  if not found then
    return false;
  end if;

  if selected_token.status = 'revoked' then
    return true;
  end if;

  update public.matching_participant_tokens as token
    set
      status = 'revoked',
      revoked_at = now(),
      revoked_by = trim(p_revoked_by),
      revocation_reason = trim(p_reason)
    where token.id = selected_token.id;

  update public.matching_participant_profiles as profile
    set
      status = 'inactive',
      deactivated_at = now(),
      updated_at = now()
    where profile.registration_id = selected_token.registration_id
      and profile.event_id = selected_token.event_id
      and profile.status = 'active';

  return true;
end;
$$;

create or replace function public.activate_matching_participant(
  p_token_hash text,
  p_display_name text,
  p_bio text default null
)
returns table(profile_public_id uuid, event_id uuid, activated_at timestamptz)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  selected_token public.matching_participant_tokens%rowtype;
  selected_registration public.registrations%rowtype;
  created_profile public.matching_participant_profiles%rowtype;
  normalized_bio text;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'P0001', message = 'invalid_matching_token';
  end if;

  if p_display_name is null or char_length(trim(p_display_name)) not between 1 and 80 then
    raise exception using errcode = 'P0001', message = 'invalid_matching_display_name';
  end if;

  normalized_bio := nullif(trim(p_bio), '');
  if normalized_bio is not null and char_length(normalized_bio) > 500 then
    raise exception using errcode = 'P0001', message = 'invalid_matching_bio';
  end if;

  select token.*
    into selected_token
    from public.matching_participant_tokens as token
    where token.token_hash = p_token_hash;

  if not found then
    raise exception using errcode = 'P0001', message = 'invalid_matching_token';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('marat_matching_registration:' || selected_token.registration_id::text, 0)
  );

  select token.*
    into selected_token
    from public.matching_participant_tokens as token
    where token.token_hash = p_token_hash
    for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'invalid_matching_token';
  end if;

  if selected_token.status <> 'active' then
    raise exception using errcode = 'P0001', message = 'matching_token_revoked';
  end if;

  if selected_token.expires_at <= now() then
    raise exception using errcode = 'P0001', message = 'matching_token_expired';
  end if;

  select registration.*
    into selected_registration
    from public.registrations as registration
    where registration.id = selected_token.registration_id
      and registration.event_id = selected_token.event_id
    for update;

  if not found or selected_registration.payment_status <> 'paid' then
    raise exception using errcode = 'P0001', message = 'matching_registration_not_paid';
  end if;

  if not exists (
    select 1
      from public.registration_check_ins as check_in
      where check_in.registration_id = selected_registration.id
        and check_in.event_id = selected_registration.event_id
        and check_in.status = 'checked_in'
  ) then
    raise exception using errcode = 'P0001', message = 'matching_registration_not_checked_in';
  end if;

  insert into public.matching_participant_profiles (
    registration_id,
    event_id,
    display_name,
    bio,
    status,
    activated_at,
    deactivated_at
  ) values (
    selected_registration.id,
    selected_registration.event_id,
    trim(p_display_name),
    normalized_bio,
    'active',
    now(),
    null
  )
  on conflict (registration_id) do update
    set
      display_name = excluded.display_name,
      bio = excluded.bio,
      status = 'active',
      activated_at = case
        when matching_participant_profiles.status = 'active'
          then matching_participant_profiles.activated_at
        else now()
      end,
      deactivated_at = null,
      updated_at = now()
    where matching_participant_profiles.event_id = excluded.event_id
  returning * into created_profile;

  if created_profile.id is null then
    raise exception using errcode = 'P0001', message = 'matching_profile_event_mismatch';
  end if;

  return query
    select created_profile.public_id, created_profile.event_id, created_profile.activated_at;
end;
$$;

create or replace function public.record_matching_like(
  p_token_hash text,
  p_liked_public_id uuid
)
returns table(outcome text, match_public_id uuid)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  selected_token public.matching_participant_tokens%rowtype;
  selected_registration public.registrations%rowtype;
  source_profile public.matching_participant_profiles%rowtype;
  target_profile public.matching_participant_profiles%rowtype;
  created_match public.matching_matches%rowtype;
  profile_one uuid;
  profile_two uuid;
  registration_one uuid;
  registration_two uuid;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'P0001', message = 'invalid_matching_token';
  end if;

  if p_liked_public_id is null then
    raise exception using errcode = 'P0001', message = 'missing_matching_target';
  end if;

  select token.*
    into selected_token
    from public.matching_participant_tokens as token
    where token.token_hash = p_token_hash;

  if not found then
    raise exception using errcode = 'P0001', message = 'invalid_matching_token';
  end if;

  select profile.*
    into source_profile
    from public.matching_participant_profiles as profile
    where profile.registration_id = selected_token.registration_id;

  if not found then
    raise exception using errcode = 'P0001', message = 'matching_profile_not_active';
  end if;

  select profile.*
    into target_profile
    from public.matching_participant_profiles as profile
    where profile.public_id = p_liked_public_id;

  if not found then
    raise exception using errcode = 'P0001', message = 'matching_target_not_available';
  end if;

  if source_profile.id = target_profile.id then
    raise exception using errcode = 'P0001', message = 'matching_self_like';
  end if;

  if source_profile.event_id <> target_profile.event_id then
    raise exception using errcode = 'P0001', message = 'matching_cross_event_like';
  end if;

  if source_profile.registration_id < target_profile.registration_id then
    registration_one := source_profile.registration_id;
    registration_two := target_profile.registration_id;
  else
    registration_one := target_profile.registration_id;
    registration_two := source_profile.registration_id;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('marat_matching_registration:' || registration_one::text, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('marat_matching_registration:' || registration_two::text, 0)
  );

  if source_profile.id < target_profile.id then
    profile_one := source_profile.id;
    profile_two := target_profile.id;
  else
    profile_one := target_profile.id;
    profile_two := source_profile.id;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'marat_matching_pair:' || profile_one::text || ':' || profile_two::text,
      0
    )
  );

  select token.*
    into selected_token
    from public.matching_participant_tokens as token
    where token.token_hash = p_token_hash
    for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'invalid_matching_token';
  end if;

  if selected_token.status <> 'active' then
    raise exception using errcode = 'P0001', message = 'matching_token_revoked';
  end if;

  if selected_token.expires_at <= now() then
    raise exception using errcode = 'P0001', message = 'matching_token_expired';
  end if;

  perform 1
    from public.matching_participant_profiles as profile
    where profile.id in (profile_one, profile_two)
    order by profile.id
    for update;

  select profile.*
    into source_profile
    from public.matching_participant_profiles as profile
    where profile.registration_id = selected_token.registration_id;

  select profile.*
    into target_profile
    from public.matching_participant_profiles as profile
    where profile.public_id = p_liked_public_id;

  if source_profile.status <> 'active' then
    raise exception using errcode = 'P0001', message = 'matching_profile_not_active';
  end if;

  if target_profile.status <> 'active' then
    raise exception using errcode = 'P0001', message = 'matching_target_not_available';
  end if;

  select registration.*
    into selected_registration
    from public.registrations as registration
    where registration.id = selected_token.registration_id
      and registration.event_id = selected_token.event_id
    for update;

  if not found or selected_registration.payment_status <> 'paid' then
    raise exception using errcode = 'P0001', message = 'matching_registration_not_paid';
  end if;

  if not exists (
    select 1
      from public.registration_check_ins as check_in
      where check_in.registration_id = selected_registration.id
        and check_in.event_id = selected_registration.event_id
        and check_in.status = 'checked_in'
  ) then
    raise exception using errcode = 'P0001', message = 'matching_registration_not_checked_in';
  end if;

  if not exists (
    select 1
      from public.registrations as target_registration
      where target_registration.id = target_profile.registration_id
        and target_registration.event_id = target_profile.event_id
        and target_registration.payment_status = 'paid'
        and exists (
          select 1
            from public.registration_check_ins as target_check_in
            where target_check_in.registration_id = target_registration.id
              and target_check_in.event_id = target_registration.event_id
              and target_check_in.status = 'checked_in'
        )
        and exists (
          select 1
            from public.matching_participant_tokens as target_token
            where target_token.registration_id = target_registration.id
              and target_token.event_id = target_registration.event_id
              and target_token.status = 'active'
              and target_token.expires_at > now()
        )
  ) then
    raise exception using errcode = 'P0001', message = 'matching_target_not_available';
  end if;

  insert into public.matching_likes (
    event_id,
    liker_profile_id,
    liked_profile_id
  ) values (
    source_profile.event_id,
    source_profile.id,
    target_profile.id
  )
  on conflict (event_id, liker_profile_id, liked_profile_id) do nothing;

  if not exists (
    select 1
      from public.matching_likes as reverse_like
      where reverse_like.event_id = source_profile.event_id
        and reverse_like.liker_profile_id = target_profile.id
        and reverse_like.liked_profile_id = source_profile.id
  ) then
    return query select 'liked'::text, null::uuid;
    return;
  end if;

  insert into public.matching_matches (
    event_id,
    profile_one_id,
    profile_two_id
  ) values (
    source_profile.event_id,
    profile_one,
    profile_two
  )
  on conflict (event_id, profile_one_id, profile_two_id) do nothing;

  select match.*
    into created_match
    from public.matching_matches as match
    where match.event_id = source_profile.event_id
      and match.profile_one_id = profile_one
      and match.profile_two_id = profile_two;

  return query select 'matched'::text, created_match.public_id;
end;
$$;

create or replace function public.get_matching_participant_state(
  p_token_hash text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  selected_token public.matching_participant_tokens%rowtype;
  selected_registration public.registrations%rowtype;
  selected_profile public.matching_participant_profiles%rowtype;
  event_json jsonb;
  candidates_json jsonb;
  matches_json jsonb;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'P0001', message = 'invalid_matching_token';
  end if;

  select token.*
    into selected_token
    from public.matching_participant_tokens as token
    where token.token_hash = p_token_hash;

  if not found then
    raise exception using errcode = 'P0001', message = 'invalid_matching_token';
  end if;

  if selected_token.status <> 'active' then
    raise exception using errcode = 'P0001', message = 'matching_token_revoked';
  end if;

  if selected_token.expires_at <= now() then
    raise exception using errcode = 'P0001', message = 'matching_token_expired';
  end if;

  select registration.*
    into selected_registration
    from public.registrations as registration
    where registration.id = selected_token.registration_id
      and registration.event_id = selected_token.event_id;

  if not found or selected_registration.payment_status <> 'paid' then
    raise exception using errcode = 'P0001', message = 'matching_registration_not_paid';
  end if;

  if not exists (
    select 1
      from public.registration_check_ins as check_in
      where check_in.registration_id = selected_registration.id
        and check_in.event_id = selected_registration.event_id
        and check_in.status = 'checked_in'
  ) then
    raise exception using errcode = 'P0001', message = 'matching_registration_not_checked_in';
  end if;

  select jsonb_build_object(
      'id', event.id,
      'title', event.title,
      'startsAt', event.starts_at
    )
    into event_json
    from public.events as event
    where event.id = selected_registration.event_id;

  select profile.*
    into selected_profile
    from public.matching_participant_profiles as profile
    where profile.registration_id = selected_registration.id
      and profile.event_id = selected_registration.event_id
      and profile.status = 'active';

  if not found then
    return jsonb_build_object(
      'event', event_json,
      'profile', null,
      'candidates', '[]'::jsonb,
      'matches', '[]'::jsonb
    );
  end if;

  select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'publicId', candidate_profile.public_id,
          'displayName', candidate_profile.display_name,
          'bio', candidate_profile.bio,
          'likedByMe', exists (
            select 1
              from public.matching_likes as own_like
              where own_like.event_id = selected_profile.event_id
                and own_like.liker_profile_id = selected_profile.id
                and own_like.liked_profile_id = candidate_profile.id
          )
        )
        order by candidate_profile.display_name, candidate_profile.public_id
      ),
      '[]'::jsonb
    )
    into candidates_json
    from public.matching_participant_profiles as candidate_profile
    join public.registrations as candidate_registration
      on candidate_registration.id = candidate_profile.registration_id
     and candidate_registration.event_id = candidate_profile.event_id
    where candidate_profile.event_id = selected_profile.event_id
      and candidate_profile.id <> selected_profile.id
      and candidate_profile.status = 'active'
      and candidate_registration.payment_status = 'paid'
      and exists (
        select 1
          from public.registration_check_ins as candidate_check_in
          where candidate_check_in.registration_id = candidate_registration.id
            and candidate_check_in.event_id = candidate_registration.event_id
            and candidate_check_in.status = 'checked_in'
      )
      and exists (
        select 1
          from public.matching_participant_tokens as candidate_token
          where candidate_token.registration_id = candidate_registration.id
            and candidate_token.event_id = candidate_registration.event_id
            and candidate_token.status = 'active'
            and candidate_token.expires_at > now()
      );

  select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'publicId', match.public_id,
          'participantPublicId', other_profile.public_id,
          'displayName', other_profile.display_name,
          'bio', other_profile.bio,
          'matchedAt', match.created_at
        )
        order by match.created_at, match.public_id
      ),
      '[]'::jsonb
    )
    into matches_json
    from public.matching_matches as match
    join public.matching_participant_profiles as other_profile
      on other_profile.id = case
        when match.profile_one_id = selected_profile.id then match.profile_two_id
        else match.profile_one_id
      end
     and other_profile.event_id = match.event_id
    join public.registrations as other_registration
      on other_registration.id = other_profile.registration_id
     and other_registration.event_id = other_profile.event_id
    where match.event_id = selected_profile.event_id
      and (match.profile_one_id = selected_profile.id or match.profile_two_id = selected_profile.id)
      and other_profile.status = 'active'
      and other_registration.payment_status = 'paid'
      and exists (
        select 1
          from public.registration_check_ins as other_check_in
          where other_check_in.registration_id = other_registration.id
            and other_check_in.event_id = other_registration.event_id
            and other_check_in.status = 'checked_in'
      )
      and exists (
        select 1
          from public.matching_participant_tokens as other_token
          where other_token.registration_id = other_registration.id
            and other_token.event_id = other_registration.event_id
            and other_token.status = 'active'
            and other_token.expires_at > now()
      );

  return jsonb_build_object(
    'event', event_json,
    'profile', jsonb_build_object(
      'publicId', selected_profile.public_id,
      'displayName', selected_profile.display_name,
      'bio', selected_profile.bio,
      'activatedAt', selected_profile.activated_at
    ),
    'candidates', candidates_json,
    'matches', matches_json
  );
end;
$$;

revoke all on function public.enforce_active_matching_token_eligibility()
  from public, anon, authenticated;
revoke all on function public.enforce_matching_match_mutual_likes()
  from public, anon, authenticated;
revoke all on function public.issue_matching_participant_token(uuid, uuid, text, text, timestamptz)
  from public, anon, authenticated;
revoke all on function public.revoke_matching_participant_token(uuid, uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.activate_matching_participant(text, text, text)
  from public, anon, authenticated;
revoke all on function public.record_matching_like(text, uuid)
  from public, anon, authenticated;
revoke all on function public.get_matching_participant_state(text)
  from public, anon, authenticated;

grant execute on function public.issue_matching_participant_token(uuid, uuid, text, text, timestamptz)
  to service_role;
grant execute on function public.revoke_matching_participant_token(uuid, uuid, text, text)
  to service_role;
grant execute on function public.activate_matching_participant(text, text, text)
  to service_role;
grant execute on function public.record_matching_like(text, uuid)
  to service_role;
grant execute on function public.get_matching_participant_state(text)
  to service_role;
