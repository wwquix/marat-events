alter table public.audience_import_rows
  add column preview_decision text,
  add column committed_at timestamptz,
  add column committed_by text;

update public.audience_import_rows
set preview_decision = decision
where preview_decision is null;

alter table public.audience_import_rows
  alter column preview_decision set not null,
  add constraint audience_import_rows_preview_decision_check
    check (preview_decision in ('new_person', 'reuse_person', 'review', 'invalid', 'committed'));

alter table public.audience_import_batches
  add column committed_by text;

alter table public.identity_review_queue
  add column audience_import_row_id uuid references public.audience_import_rows(id) on delete cascade,
  add column resolution_action text,
  add column resolved_person_id uuid references public.people(id) on delete restrict,
  add column resolved_by text,
  add column resolution_note text,
  add constraint identity_review_queue_resolution_action_check
    check (resolution_action is null or resolution_action in ('reuse_person', 'new_person', 'exclude')),
  add constraint identity_review_queue_resolution_person_check
    check (
      resolution_action is null
      or (resolution_action = 'reuse_person' and resolved_person_id is not null)
      or (resolution_action in ('new_person', 'exclude') and resolved_person_id is null)
    );

with ranked_matches as (
  select
    queue.id as queue_id,
    import_row.id as import_row_id,
    row_number() over (
      partition by import_row.id
      order by queue.created_at, queue.id
    ) as match_number
  from public.identity_review_queue as queue
  join public.audience_import_rows as import_row
    on import_row.batch_id = queue.import_batch_id
   and import_row.row_number = queue.incoming_row_number
  where queue.audience_import_row_id is null
)
update public.identity_review_queue as queue
set audience_import_row_id = ranked_matches.import_row_id
from ranked_matches
where queue.id = ranked_matches.queue_id
  and ranked_matches.match_number = 1;

create unique index identity_review_queue_import_row_unique_idx
  on public.identity_review_queue(audience_import_row_id)
  where audience_import_row_id is not null;

insert into public.identity_review_queue (
  import_batch_id,
  audience_import_row_id,
  incoming_row_number,
  conflict_type,
  candidate_person_ids,
  incoming_payload,
  status
)
select
  import_row.batch_id,
  import_row.id,
  import_row.row_number,
  case
    when import_row.errors && array['conflicting_identifiers']::text[] then 'ambiguous_identity'
    when import_row.errors && array['duplicate_identifier_in_file']::text[] then 'ambiguous_identity'
    else 'manual_review'
  end,
  import_row.candidate_person_ids,
  import_row.normalized_data,
  'open'
from public.audience_import_rows as import_row
where import_row.preview_decision = 'review'
on conflict (audience_import_row_id) where audience_import_row_id is not null do nothing;

create or replace function public.resolve_audience_import_review(
  p_row_id uuid,
  p_action text,
  p_person_id uuid,
  p_resolved_by text,
  p_note text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  selected_row public.audience_import_rows%rowtype;
  selected_batch public.audience_import_batches%rowtype;
  selected_review public.identity_review_queue%rowtype;
begin
  if p_action is null or p_action not in ('reuse_person', 'new_person', 'exclude') then
    raise exception using errcode = 'P0001', message = 'invalid_resolution_action';
  end if;

  if p_resolved_by is null or char_length(trim(p_resolved_by)) = 0 then
    raise exception using errcode = 'P0001', message = 'missing_resolver_identity';
  end if;

  if p_note is not null and char_length(p_note) > 500 then
    raise exception using errcode = 'P0001', message = 'resolution_note_too_long';
  end if;

  select import_row.*
  into selected_row
  from public.audience_import_rows as import_row
  where import_row.id = p_row_id
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'import_row_not_found';
  end if;

  select batch.*
  into selected_batch
  from public.audience_import_batches as batch
  where batch.id = selected_row.batch_id
  for update;

  if selected_batch.status <> 'preview' or selected_row.preview_decision <> 'review' then
    raise exception using errcode = 'P0001', message = 'review_not_resolvable';
  end if;

  select review.*
  into selected_review
  from public.identity_review_queue as review
  where review.audience_import_row_id = selected_row.id
  for update;

  if found and selected_review.resolution_action is not null then
    raise exception using errcode = 'P0001', message = 'review_already_resolved';
  end if;

  if p_action = 'reuse_person' then
    if p_person_id is null or not (p_person_id = any(selected_row.candidate_person_ids)) then
      raise exception using errcode = 'P0001', message = 'invalid_reuse_candidate';
    end if;

    if not exists (select 1 from public.people where id = p_person_id) then
      raise exception using errcode = 'P0001', message = 'reuse_candidate_not_found';
    end if;
  elsif p_person_id is not null then
    raise exception using errcode = 'P0001', message = 'unexpected_resolved_person';
  end if;

  if p_action = 'new_person' then
    if jsonb_typeof(selected_row.normalized_data -> 'contacts') <> 'array'
       or jsonb_array_length(selected_row.normalized_data -> 'contacts') = 0 then
      raise exception using errcode = 'P0001', message = 'new_person_requires_identifier';
    end if;

    if exists (
      with incoming_contacts as (
        select
          contact ->> 'channel' as channel,
          contact ->> 'normalizedValue' as normalized_value
        from jsonb_array_elements(selected_row.normalized_data -> 'contacts') as contact
      ), current_identities as (
        select contact.channel, contact.normalized_value
        from public.person_contacts as contact
        where contact.channel in ('email', 'phone', 'instagram', 'linkedin')
        union all
        select 'email', lower(trim(person.email))
        from public.people as person
        where person.email is not null
        union all
        select 'phone', regexp_replace(person.phone, '[^0-9]', '', 'g')
        from public.people as person
        where person.phone is not null and char_length(trim(person.phone)) > 0
      )
      select 1
      from incoming_contacts
      join current_identities using (channel, normalized_value)
    ) then
      raise exception using errcode = 'P0001', message = 'new_person_identifier_exists';
    end if;

    if exists (
      with incoming_contacts as (
        select
          contact ->> 'channel' as channel,
          contact ->> 'normalizedValue' as normalized_value
        from jsonb_array_elements(selected_row.normalized_data -> 'contacts') as contact
      )
      select 1
      from public.audience_import_rows as other_row
      left join public.identity_review_queue as other_review
        on other_review.audience_import_row_id = other_row.id
      cross join lateral jsonb_array_elements(
        case
          when jsonb_typeof(other_row.normalized_data -> 'contacts') = 'array'
            then other_row.normalized_data -> 'contacts'
          else '[]'::jsonb
        end
      ) as other_contact
      join incoming_contacts
        on incoming_contacts.channel = other_contact ->> 'channel'
       and incoming_contacts.normalized_value = other_contact ->> 'normalizedValue'
      where other_row.batch_id = selected_row.batch_id
        and other_row.id <> selected_row.id
        and other_row.preview_decision <> 'invalid'
        and coalesce(other_review.resolution_action, '') <> 'exclude'
    ) then
      raise exception using errcode = 'P0001', message = 'identifier_used_by_active_batch_row';
    end if;
  end if;

  insert into public.identity_review_queue (
    import_batch_id,
    audience_import_row_id,
    incoming_row_number,
    conflict_type,
    candidate_person_ids,
    incoming_payload,
    status,
    resolution,
    resolution_action,
    resolved_person_id,
    resolved_by,
    resolution_note,
    resolved_at
  )
  values (
    selected_row.batch_id,
    selected_row.id,
    selected_row.row_number,
    'manual_review',
    selected_row.candidate_person_ids,
    selected_row.normalized_data,
    'resolved',
    p_action,
    p_action,
    p_person_id,
    trim(p_resolved_by),
    nullif(trim(p_note), ''),
    now()
  )
  on conflict (audience_import_row_id) where audience_import_row_id is not null
  do update set
    status = 'resolved',
    resolution = excluded.resolution,
    resolution_action = excluded.resolution_action,
    resolved_person_id = excluded.resolved_person_id,
    resolved_by = excluded.resolved_by,
    resolution_note = excluded.resolution_note,
    resolved_at = excluded.resolved_at
  where public.identity_review_queue.resolution_action is null;

  if not found then
    raise exception using errcode = 'P0001', message = 'review_already_resolved';
  end if;

  return jsonb_build_object(
    'row_id', selected_row.id,
    'action', p_action,
    'resolved_person_id', p_person_id
  );
end;
$$;

create or replace function public.commit_audience_import(
  p_batch_id uuid,
  p_committed_by text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  selected_batch public.audience_import_batches%rowtype;
  current_row record;
  incoming_contact record;
  matched_person_ids uuid[];
  v_committed_person_id uuid;
  committed_rows integer := 0;
  created_people integer := 0;
  reused_people integer := 0;
  skipped_invalid integer := 0;
  skipped_excluded integer := 0;
begin
  if p_committed_by is null or char_length(trim(p_committed_by)) = 0 then
    raise exception using errcode = 'P0001', message = 'missing_committer_identity';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('marat_audience_import_commit', 0));

  select batch.*
  into selected_batch
  from public.audience_import_batches as batch
  where batch.id = p_batch_id
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'import_batch_not_found';
  end if;

  if selected_batch.status = 'committed' then
    select count(*) filter (where import_row.decision = 'committed'),
           count(*) filter (where import_row.preview_decision = 'invalid'),
           count(*) filter (where review.resolution_action = 'exclude')
    into committed_rows, skipped_invalid, skipped_excluded
    from public.audience_import_rows as import_row
    left join public.identity_review_queue as review
      on review.audience_import_row_id = import_row.id
    where import_row.batch_id = p_batch_id;

    return jsonb_build_object(
      'status', 'already_committed',
      'committed_rows', committed_rows,
      'skipped_invalid', skipped_invalid,
      'skipped_excluded', skipped_excluded
    );
  end if;

  if selected_batch.status <> 'preview' then
    raise exception using errcode = 'P0001', message = 'import_batch_not_preview';
  end if;

  if exists (
    select 1
    from public.audience_import_rows as import_row
    left join public.identity_review_queue as review
      on review.audience_import_row_id = import_row.id
    where import_row.batch_id = p_batch_id
      and import_row.preview_decision = 'review'
      and review.resolution_action is null
  ) then
    raise exception using errcode = 'P0001', message = 'unresolved_reviews';
  end if;

  for current_row in
    select
      row_data.*,
      case
        when row_data.preview_decision = 'new_person' then 'new_person'
        when row_data.preview_decision = 'reuse_person' then 'reuse_person'
        when row_data.preview_decision = 'review' then review.resolution_action
        else null
      end as effective_action,
      case
        when row_data.preview_decision = 'reuse_person' then row_data.candidate_person_ids[1]
        when row_data.preview_decision = 'review' and review.resolution_action = 'reuse_person'
          then review.resolved_person_id
        else null
      end as target_person_id
    from public.audience_import_rows as row_data
    left join public.identity_review_queue as review
      on review.audience_import_row_id = row_data.id
    where row_data.batch_id = p_batch_id
    order by row_data.row_number
  loop
    if current_row.preview_decision = 'invalid' then
      skipped_invalid := skipped_invalid + 1;
      continue;
    end if;

    if current_row.effective_action = 'exclude' then
      skipped_excluded := skipped_excluded + 1;
      continue;
    end if;

    if current_row.effective_action is null
       or current_row.effective_action not in ('new_person', 'reuse_person') then
      raise exception using errcode = 'P0001', message = 'ineligible_import_row';
    end if;

    if jsonb_typeof(current_row.normalized_data -> 'contacts') <> 'array'
       or jsonb_array_length(current_row.normalized_data -> 'contacts') = 0 then
      raise exception using errcode = 'P0001', message = 'eligible_row_requires_identifier';
    end if;

    if current_row.effective_action = 'reuse_person' then
      if current_row.target_person_id is null
         or not exists (select 1 from public.people where id = current_row.target_person_id) then
        raise exception using errcode = 'P0001', message = 'reuse_target_not_found';
      end if;

      if current_row.preview_decision = 'reuse_person'
         and cardinality(current_row.candidate_person_ids) <> 1 then
        raise exception using errcode = 'P0001', message = 'ambiguous_reuse_target';
      end if;
    end if;

    for incoming_contact in
      select
        contact ->> 'channel' as channel,
        contact ->> 'value' as value,
        contact ->> 'normalizedValue' as normalized_value
      from jsonb_array_elements(current_row.normalized_data -> 'contacts') as contact
    loop
      if incoming_contact.channel not in ('email', 'phone', 'instagram', 'linkedin')
         or incoming_contact.normalized_value is null
         or char_length(incoming_contact.normalized_value) = 0 then
        raise exception using errcode = 'P0001', message = 'invalid_normalized_contact';
      end if;

      select coalesce(array_agg(distinct identity.person_id), '{}'::uuid[])
      into matched_person_ids
      from (
        select contact.person_id
        from public.person_contacts as contact
        where contact.channel = incoming_contact.channel
          and contact.normalized_value = incoming_contact.normalized_value
        union
        select person.id
        from public.people as person
        where incoming_contact.channel = 'email'
          and person.email is not null
          and lower(trim(person.email)) = incoming_contact.normalized_value
        union
        select person.id
        from public.people as person
        where incoming_contact.channel = 'phone'
          and person.phone is not null
          and regexp_replace(person.phone, '[^0-9]', '', 'g') = incoming_contact.normalized_value
      ) as identity;

      if current_row.effective_action = 'new_person' and cardinality(matched_person_ids) > 0 then
        raise exception using errcode = 'P0001', message = 'stale_new_person_conflict';
      end if;

      if current_row.effective_action = 'reuse_person'
         and exists (
           select 1
           from unnest(matched_person_ids) as matched(person_id)
           where matched.person_id <> current_row.target_person_id
         ) then
        raise exception using errcode = 'P0001', message = 'stale_reuse_conflict';
      end if;
    end loop;
  end loop;

  if exists (
    with effective_rows as (
      select
        import_row.id,
        import_row.normalized_data,
        case
          when import_row.preview_decision = 'new_person' then 'new_person'
          when import_row.preview_decision = 'reuse_person' then 'reuse_person'
          when import_row.preview_decision = 'review' then review.resolution_action
          else null
        end as effective_action,
        case
          when import_row.preview_decision = 'reuse_person' then import_row.candidate_person_ids[1]
          when import_row.preview_decision = 'review' and review.resolution_action = 'reuse_person'
            then review.resolved_person_id
          else null
        end as target_person_id
      from public.audience_import_rows as import_row
      left join public.identity_review_queue as review
        on review.audience_import_row_id = import_row.id
      where import_row.batch_id = p_batch_id
        and import_row.preview_decision <> 'invalid'
        and coalesce(review.resolution_action, '') <> 'exclude'
    ), planned_identifier_owners as (
      select
        contact ->> 'channel' as channel,
        contact ->> 'normalizedValue' as normalized_value,
        case
          when effective_rows.effective_action = 'reuse_person'
            then 'person:' || effective_rows.target_person_id::text
          else 'new:' || effective_rows.id::text
        end as planned_owner
      from effective_rows
      cross join lateral jsonb_array_elements(effective_rows.normalized_data -> 'contacts') as contact
      where effective_rows.effective_action in ('new_person', 'reuse_person')
    )
    select 1
    from planned_identifier_owners
    group by channel, normalized_value
    having count(distinct planned_owner) > 1
  ) then
    raise exception using errcode = 'P0001', message = 'conflicting_planned_identifier_ownership';
  end if;

  for current_row in
    select
      row_data.*,
      case
        when row_data.preview_decision = 'new_person' then 'new_person'
        when row_data.preview_decision = 'reuse_person' then 'reuse_person'
        when row_data.preview_decision = 'review' then review.resolution_action
        else null
      end as effective_action,
      case
        when row_data.preview_decision = 'reuse_person' then row_data.candidate_person_ids[1]
        when row_data.preview_decision = 'review' and review.resolution_action = 'reuse_person'
          then review.resolved_person_id
        else null
      end as target_person_id
    from public.audience_import_rows as row_data
    left join public.identity_review_queue as review
      on review.audience_import_row_id = row_data.id
    where row_data.batch_id = p_batch_id
      and row_data.preview_decision <> 'invalid'
      and coalesce(review.resolution_action, '') <> 'exclude'
    order by row_data.row_number
  loop
    if current_row.effective_action = 'new_person' then
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
        import_batch_id,
        suppression_status,
        identity_status
      )
      values (
        current_row.normalized_data ->> 'fullName',
        nullif(current_row.normalized_data ->> 'email', ''),
        nullif(current_row.normalized_data ->> 'phone', ''),
        nullif(current_row.normalized_data ->> 'gender', ''),
        nullif(current_row.normalized_data ->> 'city', ''),
        nullif(current_row.normalized_data ->> 'occupation', ''),
        nullif(current_row.normalized_data ->> 'education', ''),
        nullif(current_row.normalized_data ->> 'profileUrl', ''),
        coalesce(nullif(current_row.normalized_data ->> 'source', ''), selected_batch.source_label),
        coalesce(nullif(current_row.normalized_data ->> 'sourceReference', ''), selected_batch.source_reference),
        selected_batch.id,
        'active',
        'resolved'
      )
      returning id into v_committed_person_id;

      created_people := created_people + 1;
    else
      v_committed_person_id := current_row.target_person_id;
      reused_people := reused_people + 1;
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
    select
      v_committed_person_id,
      contact ->> 'channel',
      contact ->> 'value',
      contact ->> 'normalizedValue',
      false,
      'unknown',
      'unknown',
      coalesce(nullif(current_row.normalized_data ->> 'source', ''), selected_batch.source_label)
    from jsonb_array_elements(current_row.normalized_data -> 'contacts') as contact
    on conflict (person_id, channel, normalized_value) do nothing;

    update public.audience_import_rows
    set decision = 'committed',
        committed_person_id = v_committed_person_id,
        committed_at = now(),
        committed_by = trim(p_committed_by)
    where id = current_row.id;

    committed_rows := committed_rows + 1;
  end loop;

  update public.audience_import_batches
  set status = 'committed',
      committed_at = now(),
      committed_by = trim(p_committed_by)
  where id = selected_batch.id
    and status = 'preview';

  if not found then
    raise exception using errcode = 'P0001', message = 'import_batch_commit_race';
  end if;

  return jsonb_build_object(
    'status', 'committed',
    'committed_rows', committed_rows,
    'created_people', created_people,
    'reused_people', reused_people,
    'skipped_invalid', skipped_invalid,
    'skipped_excluded', skipped_excluded
  );
end;
$$;

revoke execute on function public.resolve_audience_import_review(uuid, text, uuid, text, text) from public;
revoke execute on function public.resolve_audience_import_review(uuid, text, uuid, text, text) from anon;
revoke execute on function public.resolve_audience_import_review(uuid, text, uuid, text, text) from authenticated;
grant execute on function public.resolve_audience_import_review(uuid, text, uuid, text, text) to service_role;

revoke execute on function public.commit_audience_import(uuid, text) from public;
revoke execute on function public.commit_audience_import(uuid, text) from anon;
revoke execute on function public.commit_audience_import(uuid, text) from authenticated;
grant execute on function public.commit_audience_import(uuid, text) to service_role;
