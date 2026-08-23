alter table public.people
  drop constraint people_identity_status_check;

alter table public.people
  add constraint people_identity_status_check
  check (identity_status in ('resolved', 'review_required', 'merged', 'rejected')),
  add column merged_into_person_id uuid references public.people(id) on delete restrict;

alter table public.people
  add constraint people_merge_state_check
  check (
    (identity_status = 'merged' and merged_into_person_id is not null)
    or (identity_status <> 'merged' and merged_into_person_id is null)
  ),
  add constraint people_no_self_merge_check
  check (merged_into_person_id is null or merged_into_person_id <> id);

create function public.enforce_people_merge_target_invariant()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  target_status text;
begin
  if new.identity_status <> 'merged' then
    return new;
  end if;

  if new.merged_into_person_id is null or new.merged_into_person_id = new.id then
    return new;
  end if;

  select person.identity_status
  into target_status
  from public.people as person
  where person.id = new.merged_into_person_id
  for update;

  if not found then
    raise exception 'Merge target % does not exist.', new.merged_into_person_id;
  end if;

  if target_status = 'merged' then
    raise exception 'Cannot merge person % into %, because the target is already merged.', new.id, new.merged_into_person_id;
  end if;

  perform 1
  from public.people as person
  where person.merged_into_person_id = new.id
    and person.id <> new.id
  for update;

  if found then
    raise exception 'Cannot mark person % as merged, because another person already merges into it.', new.id;
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_people_merge_target_invariant() from public, anon, authenticated;

create trigger people_merge_target_invariant
before insert or update of identity_status, merged_into_person_id
on public.people
for each row
execute function public.enforce_people_merge_target_invariant();

alter table public.identity_review_queue
  add column reviewed_by text,
  add column resolved_person_id uuid references public.people(id) on delete restrict;

alter table public.audience_import_batches
  add column file_sha256 text,
  add constraint audience_import_batches_file_sha256_check
  check (file_sha256 is null or file_sha256 ~ '^[0-9a-f]{64}$');

create unique index audience_import_batches_committed_file_sha256_unique_idx
  on public.audience_import_batches(file_sha256)
  where status = 'committed' and file_sha256 is not null;

do $$
declare
  conflicts jsonb;
begin
  select jsonb_agg(to_jsonb(conflict_row) order by conflict_row.channel, conflict_row.normalized_value)
  into conflicts
  from (
    select
      channel,
      normalized_value,
      array_agg(distinct person_id order by person_id) as person_ids
    from public.person_contacts
    where channel in ('email', 'phone')
    group by channel, normalized_value
    having count(distinct person_id) > 1
  ) as conflict_row;

  if conflicts is not null then
    raise exception using
      message = 'Trusted audience identifiers have conflicting owners.',
      detail = conflicts::text,
      hint = 'Resolve every listed email/phone conflict manually, then apply this migration again.';
  end if;
end;
$$;

create unique index person_contacts_trusted_identifier_owner_unique_idx
  on public.person_contacts(channel, normalized_value)
  where channel in ('email', 'phone');

create function public.commit_audience_import(p_batch_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  batch_row public.audience_import_batches%rowtype;
  import_row public.audience_import_rows%rowtype;
  contact_row record;
  candidate_ids uuid[];
  committed_person_id_value uuid;
  canonical_batch_id uuid;
  created_people integer := 0;
  reused_people integer := 0;
  review_rows integer := 0;
begin
  select *
  into batch_row
  from public.audience_import_batches
  where id = p_batch_id
  for update;

  if not found then
    raise exception 'Audience import batch % does not exist.', p_batch_id;
  end if;

  if batch_row.status = 'committed' then
    return jsonb_build_object(
      'batchId', batch_row.id,
      'alreadyCommitted', true,
      'createdPeople', 0,
      'reusedPeople', 0,
      'reviewRows', 0
    );
  end if;

  if batch_row.status <> 'preview' then
    raise exception 'Audience import batch % is not a preview.', p_batch_id;
  end if;

  if batch_row.file_sha256 is null then
    raise exception 'Audience import batch % has no file fingerprint.', p_batch_id;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(batch_row.file_sha256, 0));

  select id
  into canonical_batch_id
  from public.audience_import_batches
  where file_sha256 = batch_row.file_sha256
    and status = 'committed'
    and id <> batch_row.id
  order by committed_at asc, id asc
  limit 1;

  if canonical_batch_id is not null then
    return jsonb_build_object(
      'batchId', canonical_batch_id,
      'alreadyCommitted', true,
      'createdPeople', 0,
      'reusedPeople', 0,
      'reviewRows', 0
    );
  end if;

  create temporary table import_planned_identifiers (
    row_id uuid not null,
    row_number integer not null,
    channel text not null,
    normalized_value text not null
  ) on commit drop;

  insert into pg_temp.import_planned_identifiers (row_id, row_number, channel, normalized_value)
  select
    row_data.id,
    row_data.row_number,
    contact.value ->> 'channel',
    contact.value ->> 'normalizedValue'
  from public.audience_import_rows as row_data
  cross join lateral jsonb_array_elements(coalesce(row_data.normalized_data -> 'contacts', '[]'::jsonb)) as contact(value)
  where row_data.batch_id = batch_row.id
    and row_data.decision in ('new_person', 'reuse_person')
    and contact.value ->> 'channel' in ('email', 'phone')
    and nullif(contact.value ->> 'normalizedValue', '') is not null;

  if exists (
    select 1
    from pg_temp.import_planned_identifiers
    group by channel, normalized_value
    having count(distinct row_id) > 1
  ) then
    raise exception 'Audience import batch % assigns one trusted identifier to multiple planned rows.', p_batch_id;
  end if;

  for import_row in
    select *
    from public.audience_import_rows
    where batch_id = batch_row.id
    order by row_number asc
    for update
  loop
    if import_row.decision = 'review' then
      insert into public.identity_review_queue (
        import_batch_id,
        incoming_row_number,
        conflict_type,
        candidate_person_ids,
        incoming_payload,
        status
      )
      values (
        batch_row.id,
        import_row.row_number,
        'manual_review',
        import_row.candidate_person_ids,
        import_row.normalized_data,
        'open'
      );
      review_rows := review_rows + 1;
      continue;
    end if;

    if import_row.decision = 'invalid' then
      continue;
    end if;

    if import_row.decision not in ('new_person', 'reuse_person') then
      continue;
    end if;

    select array_agg(distinct owner.person_id order by owner.person_id)
    into candidate_ids
    from (
      select contact.person_id
      from pg_temp.import_planned_identifiers as planned
      join public.person_contacts as contact
        on contact.channel = planned.channel
       and contact.normalized_value = planned.normalized_value
      where planned.row_id = import_row.id

      union

      select person.id
      from pg_temp.import_planned_identifiers as planned
      join public.people as person
        on planned.channel = 'email'
       and person.email is not null
       and lower(trim(person.email)) = planned.normalized_value
      where planned.row_id = import_row.id

      union

      select person.id
      from pg_temp.import_planned_identifiers as planned
      join public.people as person
        on planned.channel = 'phone'
       and person.phone is not null
       and regexp_replace(person.phone, '[^0-9]', '', 'g') = planned.normalized_value
      where planned.row_id = import_row.id
    ) as owner;

    if coalesce(array_length(candidate_ids, 1), 0) > 1 then
      raise exception 'Audience import row % resolves to multiple trusted identifier owners: %.',
        import_row.row_number,
        candidate_ids;
    end if;

    committed_person_id_value := candidate_ids[1];

    if import_row.decision = 'reuse_person' and committed_person_id_value is null then
      raise exception 'Audience import row % no longer resolves to the previewed person.', import_row.row_number;
    end if;

    if committed_person_id_value is null then
      insert into public.people (
        full_name,
        email,
        phone,
        gender,
        city,
        occupation,
        education,
        profile_url,
        source,
        source_reference,
        import_batch_id
      )
      values (
        import_row.normalized_data ->> 'fullName',
        nullif(import_row.normalized_data ->> 'email', ''),
        nullif(import_row.normalized_data ->> 'phone', ''),
        nullif(import_row.normalized_data ->> 'gender', ''),
        nullif(import_row.normalized_data ->> 'city', ''),
        nullif(import_row.normalized_data ->> 'occupation', ''),
        nullif(import_row.normalized_data ->> 'education', ''),
        nullif(import_row.normalized_data ->> 'profileUrl', ''),
        coalesce(nullif(import_row.normalized_data ->> 'source', ''), batch_row.source_label),
        coalesce(nullif(import_row.normalized_data ->> 'sourceReference', ''), batch_row.source_reference),
        batch_row.id
      )
      returning id into committed_person_id_value;

      created_people := created_people + 1;
    else
      reused_people := reused_people + 1;
    end if;

    for contact_row in
      select
        contact.value ->> 'channel' as channel,
        contact.value ->> 'value' as value,
        contact.value ->> 'normalizedValue' as normalized_value
      from jsonb_array_elements(coalesce(import_row.normalized_data -> 'contacts', '[]'::jsonb)) as contact(value)
    loop
      if contact_row.channel not in ('email', 'phone', 'instagram', 'linkedin', 'telegram')
        or nullif(contact_row.value, '') is null
        or nullif(contact_row.normalized_value, '') is null then
        raise exception 'Audience import row % contains an invalid contact.', import_row.row_number;
      end if;

      if contact_row.channel in ('email', 'phone') and exists (
        select 1
        from public.person_contacts as contact
        where contact.channel = contact_row.channel
          and contact.normalized_value = contact_row.normalized_value
          and contact.person_id <> committed_person_id_value
      ) then
        raise exception 'Audience import row % would reassign trusted identifier %:%.',
          import_row.row_number,
          contact_row.channel,
          contact_row.normalized_value;
      end if;

      insert into public.person_contacts (
        person_id,
        channel,
        value,
        normalized_value,
        is_primary,
        consent_status,
        contactability_status,
        source
      )
      values (
        committed_person_id_value,
        contact_row.channel,
        contact_row.value,
        contact_row.normalized_value,
        contact_row.channel in ('email', 'phone'),
        'unknown',
        'unknown',
        coalesce(nullif(import_row.normalized_data ->> 'source', ''), batch_row.source_label)
      )
      on conflict do nothing;

      if contact_row.channel in ('email', 'phone') and not exists (
        select 1
        from public.person_contacts as contact
        where contact.person_id = committed_person_id_value
          and contact.channel = contact_row.channel
          and contact.normalized_value = contact_row.normalized_value
      ) then
        raise exception 'Audience import row % could not claim trusted identifier %:%.',
          import_row.row_number,
          contact_row.channel,
          contact_row.normalized_value;
      end if;
    end loop;

    update public.audience_import_rows
    set decision = 'committed',
        committed_person_id = committed_person_id_value
    where id = import_row.id;
  end loop;

  update public.audience_import_batches
  set status = 'committed',
      committed_at = now()
  where id = batch_row.id;

  return jsonb_build_object(
    'batchId', batch_row.id,
    'alreadyCommitted', false,
    'createdPeople', created_people,
    'reusedPeople', reused_people,
    'reviewRows', review_rows
  );
end;
$$;

revoke all on function public.commit_audience_import(uuid) from public, anon, authenticated;
grant execute on function public.commit_audience_import(uuid) to service_role;

alter table public.people enable row level security;
alter table public.person_contacts enable row level security;
alter table public.audience_import_batches enable row level security;
alter table public.audience_import_rows enable row level security;
alter table public.identity_review_queue enable row level security;
