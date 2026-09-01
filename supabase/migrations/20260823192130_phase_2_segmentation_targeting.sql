create table public.audience_segments (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 1 and 160),
  description text check (description is null or char_length(description) <= 1000),
  filter_version integer not null default 1 check (filter_version = 1),
  filter_definition jsonb not null check (jsonb_typeof(filter_definition) = 'object'),
  created_by text not null check (char_length(trim(created_by)) > 0),
  updated_by text not null check (char_length(trim(updated_by)) > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index audience_segments_name_lower_unique_idx
  on public.audience_segments(lower(trim(name)));

create table public.invitation_campaigns (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete restrict,
  segment_id uuid not null references public.audience_segments(id) on delete restrict,
  name text not null check (char_length(trim(name)) between 1 and 160),
  target_channel text not null check (
    target_channel in ('email', 'phone', 'sms', 'instagram', 'linkedin', 'whatsapp', 'telegram', 'other')
  ),
  segment_name_snapshot text not null check (char_length(trim(segment_name_snapshot)) > 0),
  filter_version integer not null check (filter_version = 1),
  filter_snapshot jsonb not null check (jsonb_typeof(filter_snapshot) = 'object'),
  created_by text not null check (char_length(trim(created_by)) > 0),
  created_at timestamptz not null default now(),
  unique (id, event_id)
);

create unique index invitation_campaigns_event_name_lower_unique_idx
  on public.invitation_campaigns(event_id, lower(trim(name)));
create index invitation_campaigns_segment_id_idx
  on public.invitation_campaigns(segment_id);
create index invitation_campaigns_event_created_idx
  on public.invitation_campaigns(event_id, created_at desc);

create table public.invitation_campaign_results (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null,
  event_id uuid not null,
  person_id uuid not null references public.people(id) on delete restrict,
  person_contact_id uuid references public.person_contacts(id) on delete restrict,
  person_source_snapshot text,
  person_source_reference_snapshot text,
  eligibility_status text not null check (eligibility_status in ('eligible', 'excluded')),
  exclusion_reasons text[] not null default '{}',
  attribution_token uuid,
  evaluated_at timestamptz not null default now(),
  foreign key (campaign_id, event_id)
    references public.invitation_campaigns(id, event_id)
    on delete restrict,
  unique (campaign_id, person_id),
  check (
    (
      eligibility_status = 'eligible'
      and person_contact_id is not null
      and cardinality(exclusion_reasons) = 0
      and attribution_token is not null
    )
    or (
      eligibility_status = 'excluded'
      and person_contact_id is null
      and cardinality(exclusion_reasons) > 0
      and attribution_token is null
    )
  )
);

create unique index invitation_campaign_results_event_person_eligible_unique_idx
  on public.invitation_campaign_results(event_id, person_id)
  where eligibility_status = 'eligible';
create unique index invitation_campaign_results_attribution_token_unique_idx
  on public.invitation_campaign_results(attribution_token)
  where attribution_token is not null;
create index invitation_campaign_results_campaign_status_idx
  on public.invitation_campaign_results(campaign_id, eligibility_status, person_id);

alter table public.registrations
  add column invitation_campaign_id uuid,
  add constraint registrations_invitation_campaign_event_fk
    foreign key (invitation_campaign_id, event_id)
    references public.invitation_campaigns(id, event_id)
    on delete restrict;

create index registrations_invitation_campaign_id_idx
  on public.registrations(invitation_campaign_id)
  where invitation_campaign_id is not null;

alter table public.audience_segments enable row level security;
alter table public.invitation_campaigns enable row level security;
alter table public.invitation_campaign_results enable row level security;

revoke all on table public.audience_segments from anon, authenticated;
revoke all on table public.invitation_campaigns from anon, authenticated;
revoke all on table public.invitation_campaign_results from anon, authenticated;
grant select, insert, update, delete on table public.audience_segments to service_role;
grant select, insert, update, delete on table public.invitation_campaigns to service_role;
grant select, insert, update, delete on table public.invitation_campaign_results to service_role;

create function public.assert_valid_audience_segment_filter(p_filter jsonb)
returns void
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  filter_key text;
  filter_value text;
begin
  if p_filter is null
     or jsonb_typeof(p_filter) <> 'object'
     or p_filter ->> 'version' <> '1'
     or pg_catalog.pg_column_size(p_filter) > 32768 then
    raise exception using errcode = 'P0001', message = 'invalid_segment_filter';
  end if;

  if exists (
    select 1
    from jsonb_object_keys(p_filter) as key(value)
    where key.value not in (
      'version',
      'genders',
      'cities',
      'occupations',
      'educations',
      'sources',
      'sourceReferences',
      'importBatchIds'
    )
  ) then
    raise exception using errcode = 'P0001', message = 'unsupported_segment_filter';
  end if;

  foreach filter_key in array array[
    'genders',
    'cities',
    'occupations',
    'educations',
    'sources',
    'sourceReferences',
    'importBatchIds'
  ]
  loop
    if p_filter ? filter_key then
      if jsonb_typeof(p_filter -> filter_key) <> 'array'
         or jsonb_array_length(p_filter -> filter_key) > 100 then
        raise exception using errcode = 'P0001', message = 'invalid_segment_filter_array';
      end if;

      if exists (
        select 1
        from jsonb_array_elements(p_filter -> filter_key) as item(value)
        where jsonb_typeof(item.value) <> 'string'
           or char_length(trim(item.value #>> '{}')) = 0
           or char_length(item.value #>> '{}') > 500
      ) then
        raise exception using errcode = 'P0001', message = 'invalid_segment_filter_value';
      end if;
    end if;
  end loop;

  if exists (
    select 1
    from jsonb_array_elements_text(coalesce(p_filter -> 'genders', '[]'::jsonb)) as gender(value)
    where gender.value not in ('male', 'female')
  ) then
    raise exception using errcode = 'P0001', message = 'invalid_segment_gender';
  end if;

  for filter_value in
    select value
    from jsonb_array_elements_text(coalesce(p_filter -> 'importBatchIds', '[]'::jsonb)) as batch(value)
  loop
    if filter_value !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      raise exception using errcode = 'P0001', message = 'invalid_segment_import_batch_id';
    end if;
  end loop;
end;
$$;

create function public.evaluate_invitation_campaign_candidates(
  p_event_id uuid,
  p_target_channel text,
  p_filter jsonb
)
returns table (
  person_id uuid,
  full_name text,
  city text,
  source text,
  source_reference text,
  eligibility_status text,
  person_contact_id uuid,
  contact_value text,
  exclusion_reasons text[]
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  perform public.assert_valid_audience_segment_filter(p_filter);

  if p_target_channel is null or p_target_channel not in (
    'email', 'phone', 'sms', 'instagram', 'linkedin', 'whatsapp', 'telegram', 'other'
  ) then
    raise exception using errcode = 'P0001', message = 'invalid_target_channel';
  end if;

  return query
  with manual_candidates as (
    select person.*
    from public.people as person
    where (
      jsonb_array_length(coalesce(p_filter -> 'genders', '[]'::jsonb)) = 0
      or exists (
        select 1
        from jsonb_array_elements_text(p_filter -> 'genders') as filter_value(value)
        where person.gender = filter_value.value
      )
    )
    and (
      jsonb_array_length(coalesce(p_filter -> 'cities', '[]'::jsonb)) = 0
      or exists (
        select 1
        from jsonb_array_elements_text(p_filter -> 'cities') as filter_value(value)
        where lower(trim(person.city)) = lower(trim(filter_value.value))
      )
    )
    and (
      jsonb_array_length(coalesce(p_filter -> 'occupations', '[]'::jsonb)) = 0
      or exists (
        select 1
        from jsonb_array_elements_text(p_filter -> 'occupations') as filter_value(value)
        where lower(trim(person.occupation)) = lower(trim(filter_value.value))
      )
    )
    and (
      jsonb_array_length(coalesce(p_filter -> 'educations', '[]'::jsonb)) = 0
      or exists (
        select 1
        from jsonb_array_elements_text(p_filter -> 'educations') as filter_value(value)
        where lower(trim(person.education)) = lower(trim(filter_value.value))
      )
    )
    and (
      jsonb_array_length(coalesce(p_filter -> 'sources', '[]'::jsonb)) = 0
      or exists (
        select 1
        from jsonb_array_elements_text(p_filter -> 'sources') as filter_value(value)
        where lower(trim(person.source)) = lower(trim(filter_value.value))
      )
    )
    and (
      jsonb_array_length(coalesce(p_filter -> 'sourceReferences', '[]'::jsonb)) = 0
      or exists (
        select 1
        from jsonb_array_elements_text(p_filter -> 'sourceReferences') as filter_value(value)
        where lower(trim(person.source_reference)) = lower(trim(filter_value.value))
      )
    )
    and (
      jsonb_array_length(coalesce(p_filter -> 'importBatchIds', '[]'::jsonb)) = 0
      or exists (
        select 1
        from jsonb_array_elements_text(p_filter -> 'importBatchIds') as filter_value(value)
        where person.import_batch_id::text = lower(filter_value.value)
      )
    )
  ), evaluated as (
    select
      person.id as person_id,
      person.full_name,
      person.city,
      person.source,
      person.source_reference,
      eligible_contact.id as eligible_contact_id,
      eligible_contact.value as eligible_contact_value,
      array_remove(array[
        case when person.suppression_status = 'suppressed' then 'person_suppressed' end,
        case when person.identity_status = 'review_required' then 'identity_review_required' end,
        case
          when not exists (
            select 1
            from public.person_contacts as contact
            where contact.person_id = person.id
              and contact.channel = p_target_channel
          ) then 'missing_channel'
        end,
        case
          when exists (
            select 1
            from public.person_contacts as contact
            where contact.person_id = person.id
              and contact.channel = p_target_channel
          )
          and not exists (
            select 1
            from public.person_contacts as contact
            where contact.person_id = person.id
              and contact.channel = p_target_channel
              and contact.consent_status = 'opted_in'
          ) then 'channel_not_opted_in'
        end,
        case
          when exists (
            select 1
            from public.person_contacts as contact
            where contact.person_id = person.id
              and contact.channel = p_target_channel
              and contact.consent_status = 'opted_in'
          )
          and not exists (
            select 1
            from public.person_contacts as contact
            where contact.person_id = person.id
              and contact.channel = p_target_channel
              and contact.consent_status = 'opted_in'
              and contact.contactability_status = 'reachable'
          ) then 'channel_not_reachable'
        end,
        case
          when exists (
            select 1
            from public.invitation_campaign_results as prior_result
            where prior_result.event_id = p_event_id
              and prior_result.person_id = person.id
              and prior_result.eligibility_status = 'eligible'
          ) then 'already_invited'
        end,
        case
          when exists (
            select 1
            from public.registrations as registration
            where registration.event_id = p_event_id
              and registration.person_id = person.id
          ) then 'already_registered'
        end
      ], null)::text[] as exclusion_reasons
    from manual_candidates as person
    left join lateral (
      select contact.id, contact.value
      from public.person_contacts as contact
      where contact.person_id = person.id
        and contact.channel = p_target_channel
        and contact.consent_status = 'opted_in'
        and contact.contactability_status = 'reachable'
      order by contact.is_primary desc, contact.updated_at desc, contact.created_at desc, contact.id
      limit 1
    ) as eligible_contact on true
  )
  select
    evaluated.person_id,
    evaluated.full_name,
    evaluated.city,
    evaluated.source,
    evaluated.source_reference,
    case when cardinality(evaluated.exclusion_reasons) = 0 then 'eligible' else 'excluded' end,
    case when cardinality(evaluated.exclusion_reasons) = 0 then evaluated.eligible_contact_id end,
    case when cardinality(evaluated.exclusion_reasons) = 0 then evaluated.eligible_contact_value end,
    evaluated.exclusion_reasons
  from evaluated
  order by evaluated.full_name, evaluated.person_id;
end;
$$;

create function public.preview_invitation_campaign(
  p_event_id uuid,
  p_target_channel text,
  p_filter jsonb
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  preview jsonb;
begin
  if not exists (select 1 from public.events where id = p_event_id) then
    raise exception using errcode = 'P0001', message = 'event_not_found';
  end if;

  select jsonb_build_object(
    'candidate_count', count(*),
    'eligible_count', count(*) filter (where candidate.eligibility_status = 'eligible'),
    'excluded_count', count(*) filter (where candidate.eligibility_status = 'excluded'),
    'rows', coalesce(
      jsonb_agg(to_jsonb(candidate) order by candidate.full_name, candidate.person_id),
      '[]'::jsonb
    )
  )
  into preview
  from public.evaluate_invitation_campaign_candidates(p_event_id, p_target_channel, p_filter) as candidate;

  return preview;
end;
$$;

create function public.commit_invitation_campaign(
  p_event_id uuid,
  p_segment_id uuid,
  p_segment_name text,
  p_segment_description text,
  p_campaign_name text,
  p_target_channel text,
  p_filter jsonb,
  p_committed_by text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  selected_segment public.audience_segments%rowtype;
  created_campaign public.invitation_campaigns%rowtype;
  candidate_count integer;
  eligible_count integer;
  excluded_count integer;
begin
  if p_segment_name is null or char_length(trim(p_segment_name)) not between 1 and 160 then
    raise exception using errcode = 'P0001', message = 'invalid_segment_name';
  end if;
  if p_segment_description is not null and char_length(p_segment_description) > 1000 then
    raise exception using errcode = 'P0001', message = 'invalid_segment_description';
  end if;
  if p_campaign_name is null or char_length(trim(p_campaign_name)) not between 1 and 160 then
    raise exception using errcode = 'P0001', message = 'invalid_campaign_name';
  end if;
  if p_committed_by is null or char_length(trim(p_committed_by)) = 0 then
    raise exception using errcode = 'P0001', message = 'missing_committer_identity';
  end if;

  perform public.assert_valid_audience_segment_filter(p_filter);
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('marat_invitation_event:' || p_event_id::text, 0)
  );

  if not exists (select 1 from public.events where id = p_event_id) then
    raise exception using errcode = 'P0001', message = 'event_not_found';
  end if;

  if p_segment_id is null then
    insert into public.audience_segments (
      name,
      description,
      filter_version,
      filter_definition,
      created_by,
      updated_by
    )
    values (
      trim(p_segment_name),
      nullif(trim(p_segment_description), ''),
      1,
      p_filter,
      trim(p_committed_by),
      trim(p_committed_by)
    )
    returning * into selected_segment;
  else
    select segment.*
    into selected_segment
    from public.audience_segments as segment
    where segment.id = p_segment_id
    for update;

    if not found then
      raise exception using errcode = 'P0001', message = 'segment_not_found';
    end if;

    update public.audience_segments
    set name = trim(p_segment_name),
        description = nullif(trim(p_segment_description), ''),
        filter_version = 1,
        filter_definition = p_filter,
        updated_by = trim(p_committed_by),
        updated_at = now()
    where id = selected_segment.id
    returning * into selected_segment;
  end if;

  insert into public.invitation_campaigns (
    event_id,
    segment_id,
    name,
    target_channel,
    segment_name_snapshot,
    filter_version,
    filter_snapshot,
    created_by
  )
  values (
    p_event_id,
    selected_segment.id,
    trim(p_campaign_name),
    p_target_channel,
    selected_segment.name,
    selected_segment.filter_version,
    selected_segment.filter_definition,
    trim(p_committed_by)
  )
  returning * into created_campaign;

  insert into public.invitation_campaign_results (
    campaign_id,
    event_id,
    person_id,
    person_contact_id,
    person_source_snapshot,
    person_source_reference_snapshot,
    eligibility_status,
    exclusion_reasons,
    attribution_token
  )
  select
    created_campaign.id,
    created_campaign.event_id,
    candidate.person_id,
    candidate.person_contact_id,
    candidate.source,
    candidate.source_reference,
    candidate.eligibility_status,
    candidate.exclusion_reasons,
    case when candidate.eligibility_status = 'eligible' then gen_random_uuid() end
  from public.evaluate_invitation_campaign_candidates(
    p_event_id,
    p_target_channel,
    selected_segment.filter_definition
  ) as candidate;

  select
    count(*),
    count(*) filter (where result.eligibility_status = 'eligible'),
    count(*) filter (where result.eligibility_status = 'excluded')
  into candidate_count, eligible_count, excluded_count
  from public.invitation_campaign_results as result
  where result.campaign_id = created_campaign.id;

  if eligible_count = 0 then
    raise exception using errcode = 'P0001', message = 'campaign_has_no_eligible_targets';
  end if;

  return jsonb_build_object(
    'campaign_id', created_campaign.id,
    'segment_id', selected_segment.id,
    'candidate_count', candidate_count,
    'eligible_count', eligible_count,
    'excluded_count', excluded_count
  );
end;
$$;

create function public.attribute_registration_invitation_campaign()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  matched_campaign_id uuid;
begin
  if new.person_id is null then
    if new.invitation_campaign_id is not null then
      raise exception using errcode = 'P0001', message = 'campaign_attribution_requires_person';
    end if;
    return new;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('marat_invitation_event:' || new.event_id::text, 0)
  );

  if new.invitation_campaign_id is not null then
    if not exists (
      select 1
      from public.invitation_campaign_results as result
      where result.campaign_id = new.invitation_campaign_id
        and result.event_id = new.event_id
        and result.person_id = new.person_id
        and result.eligibility_status = 'eligible'
    ) then
      raise exception using errcode = 'P0001', message = 'invalid_campaign_attribution';
    end if;
    return new;
  end if;

  select result.campaign_id
  into matched_campaign_id
  from public.invitation_campaign_results as result
  where result.event_id = new.event_id
    and result.person_id = new.person_id
    and result.eligibility_status = 'eligible';

  new.invitation_campaign_id := matched_campaign_id;
  return new;
end;
$$;

create trigger registrations_attribute_invitation_campaign
before insert or update of person_id, event_id, invitation_campaign_id
on public.registrations
for each row
execute function public.attribute_registration_invitation_campaign();

revoke execute on function public.assert_valid_audience_segment_filter(jsonb) from public, anon, authenticated;
revoke execute on function public.evaluate_invitation_campaign_candidates(uuid, text, jsonb) from public, anon, authenticated;
revoke execute on function public.preview_invitation_campaign(uuid, text, jsonb) from public, anon, authenticated;
revoke execute on function public.commit_invitation_campaign(uuid, uuid, text, text, text, text, jsonb, text)
  from public, anon, authenticated;
revoke execute on function public.attribute_registration_invitation_campaign() from public, anon, authenticated;

grant execute on function public.assert_valid_audience_segment_filter(jsonb) to service_role;
grant execute on function public.evaluate_invitation_campaign_candidates(uuid, text, jsonb) to service_role;
grant execute on function public.preview_invitation_campaign(uuid, text, jsonb) to service_role;
grant execute on function public.commit_invitation_campaign(uuid, uuid, text, text, text, text, jsonb, text)
  to service_role;
