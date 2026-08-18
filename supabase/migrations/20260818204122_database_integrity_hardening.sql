alter table public.events
  add constraint events_status_known_check
  check (status in ('draft', 'published', 'hidden')) not valid;

alter table public.events validate constraint events_status_known_check;

alter table public.ticket_types
  add constraint ticket_types_id_event_id_unique unique (id, event_id);

alter table public.registrations
  add constraint registrations_ticket_event_id_fkey
  foreign key (ticket_type_id, event_id)
  references public.ticket_types(id, event_id)
  on delete restrict
  not valid;

alter table public.registrations
  validate constraint registrations_ticket_event_id_fkey;

create unique index registrations_stripe_payment_intent_unique_idx
  on public.registrations(stripe_payment_intent_id)
  where stripe_payment_intent_id is not null;

alter table public.audience_import_batches
  add constraint audience_import_batches_row_count_limit_check
  check (row_count <= 5000) not valid;

alter table public.audience_import_batches
  validate constraint audience_import_batches_row_count_limit_check;

alter table public.events enable row level security;
alter table public.registrations enable row level security;
alter table public.people enable row level security;
alter table public.ticket_types enable row level security;
alter table public.audience_import_batches enable row level security;
alter table public.person_contacts enable row level security;
alter table public.identity_review_queue enable row level security;
alter table public.audience_import_rows enable row level security;

revoke all on table public.events from public, anon, authenticated;
revoke all on table public.registrations from public, anon, authenticated;
revoke all on table public.people from public, anon, authenticated;
revoke all on table public.ticket_types from public, anon, authenticated;
revoke all on table public.audience_import_batches from public, anon, authenticated;
revoke all on table public.person_contacts from public, anon, authenticated;
revoke all on table public.identity_review_queue from public, anon, authenticated;
revoke all on table public.audience_import_rows from public, anon, authenticated;

grant select, insert, update on table public.events to service_role;
grant select, insert, update on table public.registrations to service_role;
grant select, insert, update on table public.people to service_role;
grant select, insert, update on table public.ticket_types to service_role;
grant select, insert, update, delete on table public.audience_import_batches to service_role;
grant select, insert, update on table public.person_contacts to service_role;
grant select, insert, update on table public.identity_review_queue to service_role;
grant select, insert, update on table public.audience_import_rows to service_role;

create or replace function public.enforce_audience_import_batch_integrity()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  actual_row_count integer;
begin
  if tg_op = 'DELETE' then
    if old.status = 'committed' then
      raise exception using errcode = 'P0001', message = 'committed_import_batch_immutable';
    end if;
    return old;
  end if;

  if old.status = 'committed' and new is distinct from old then
    raise exception using errcode = 'P0001', message = 'committed_import_batch_immutable';
  end if;

  if old.status <> 'committed' and new.status = 'committed' then
    select count(*)::integer
      into actual_row_count
      from public.audience_import_rows as import_row
      where import_row.batch_id = new.id;

    if actual_row_count <> new.row_count then
      raise exception using errcode = 'P0001', message = 'import_batch_row_count_mismatch';
    end if;

    if exists (
      select 1
      from public.audience_import_rows as import_row
      left join public.identity_review_queue as review
        on review.audience_import_row_id = import_row.id
      where import_row.batch_id = new.id
        and (
          (import_row.preview_decision = 'review' and review.resolution_action is null)
          or (
            import_row.preview_decision <> 'invalid'
            and coalesce(review.resolution_action, '') <> 'exclude'
            and (
              import_row.decision <> 'committed'
              or import_row.committed_person_id is null
              or import_row.committed_at is null
              or import_row.committed_by is null
            )
          )
          or (
            (
              import_row.preview_decision = 'invalid'
              or review.resolution_action = 'exclude'
            )
            and import_row.committed_person_id is not null
          )
        )
    ) then
      raise exception using errcode = 'P0001', message = 'import_batch_rows_not_final';
    end if;
  end if;

  return new;
end;
$$;

create trigger audience_import_batches_integrity_guard
before update or delete on public.audience_import_batches
for each row execute function public.enforce_audience_import_batch_integrity();

create or replace function public.enforce_audience_import_child_integrity()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  selected_batch_id uuid;
  selected_batch_status text;
begin
  if tg_table_name = 'audience_import_rows' then
    if tg_op = 'UPDATE' and (
      new.id is distinct from old.id
      or new.batch_id is distinct from old.batch_id
      or new.row_number is distinct from old.row_number
      or new.raw_data is distinct from old.raw_data
      or new.normalized_data is distinct from old.normalized_data
      or new.preview_decision is distinct from old.preview_decision
      or new.candidate_person_ids is distinct from old.candidate_person_ids
      or new.errors is distinct from old.errors
      or new.created_at is distinct from old.created_at
    ) then
      raise exception using errcode = 'P0001', message = 'import_preview_row_immutable';
    end if;
    selected_batch_id := case when tg_op = 'DELETE' then old.batch_id else new.batch_id end;
  else
    if tg_op = 'UPDATE' and (
      new.id is distinct from old.id
      or new.import_batch_id is distinct from old.import_batch_id
      or new.audience_import_row_id is distinct from old.audience_import_row_id
      or new.incoming_row_number is distinct from old.incoming_row_number
      or new.conflict_type is distinct from old.conflict_type
      or new.candidate_person_ids is distinct from old.candidate_person_ids
      or new.incoming_payload is distinct from old.incoming_payload
      or new.created_at is distinct from old.created_at
    ) then
      raise exception using errcode = 'P0001', message = 'import_review_source_immutable';
    end if;

    if tg_op = 'UPDATE'
       and (old.status <> 'open' or old.resolution_action is not null)
       and new is distinct from old then
      raise exception using errcode = 'P0001', message = 'import_review_resolution_immutable';
    end if;
    selected_batch_id := case
      when tg_op = 'DELETE' then old.import_batch_id
      else new.import_batch_id
    end;
  end if;

  if selected_batch_id is not null then
    select batch.status
      into selected_batch_status
      from public.audience_import_batches as batch
      where batch.id = selected_batch_id;

    if selected_batch_status = 'committed' then
      raise exception using errcode = 'P0001', message = 'committed_import_history_immutable';
    end if;
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger audience_import_rows_integrity_guard
before insert or update or delete on public.audience_import_rows
for each row execute function public.enforce_audience_import_child_integrity();

create trigger identity_review_queue_integrity_guard
before insert or update or delete on public.identity_review_queue
for each row execute function public.enforce_audience_import_child_integrity();

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

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('marat_audience_import_commit', 0)
  );

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

revoke all on function public.enforce_audience_import_batch_integrity()
  from public, anon, authenticated;
revoke all on function public.enforce_audience_import_child_integrity()
  from public, anon, authenticated;
revoke all on function public.resolve_audience_import_review(uuid, text, uuid, text, text)
  from public, anon, authenticated;

grant execute on function public.resolve_audience_import_review(uuid, text, uuid, text, text)
  to service_role;
