create table public.audience_segments (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 1 and 160),
  description text not null default '' check (char_length(description) <= 2000),
  gender text check (gender in ('male', 'female')),
  city text check (city is null or char_length(trim(city)) between 1 and 120),
  source text check (source is null or char_length(trim(source)) between 1 and 160),
  import_batch_id uuid references public.audience_import_batches(id) on delete restrict,
  contact_channel text check (
    contact_channel in ('email', 'phone', 'sms', 'instagram', 'linkedin', 'whatsapp', 'telegram')
  ),
  consent_requirement text not null default 'any'
    check (consent_requirement in ('any', 'opted_in', 'unknown')),
  contactability_requirement text not null default 'any'
    check (contactability_requirement in ('any', 'reachable', 'unknown')),
  prior_registration_event_id uuid references public.events(id) on delete restrict,
  prior_registration_payment_status text not null default 'any'
    check (prior_registration_payment_status in ('any', 'paid')),
  version integer not null default 1 check (version > 0),
  created_by text not null check (char_length(trim(created_by)) between 1 and 320),
  updated_by text not null check (char_length(trim(updated_by)) between 1 and 320),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    contact_channel is not null
    or (consent_requirement = 'any' and contactability_requirement = 'any')
  ),
  check (
    prior_registration_event_id is not null
    or prior_registration_payment_status = 'any'
  )
);

create unique index audience_segments_name_lower_unique_idx
  on public.audience_segments(lower(trim(name)));
create index audience_segments_import_batch_idx
  on public.audience_segments(import_batch_id)
  where import_batch_id is not null;
create index audience_segments_prior_event_idx
  on public.audience_segments(prior_registration_event_id)
  where prior_registration_event_id is not null;

create table public.event_audience_selections (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete restrict,
  segment_id uuid not null references public.audience_segments(id) on delete restrict,
  name text not null check (char_length(trim(name)) between 1 and 160),
  segment_version integer not null check (segment_version > 0),
  snapshot_gender text check (snapshot_gender in ('male', 'female')),
  snapshot_city text check (snapshot_city is null or char_length(trim(snapshot_city)) between 1 and 120),
  snapshot_source text check (snapshot_source is null or char_length(trim(snapshot_source)) between 1 and 160),
  snapshot_import_batch_id uuid references public.audience_import_batches(id) on delete restrict,
  snapshot_contact_channel text check (
    snapshot_contact_channel in ('email', 'phone', 'sms', 'instagram', 'linkedin', 'whatsapp', 'telegram')
  ),
  snapshot_consent_requirement text not null
    check (snapshot_consent_requirement in ('any', 'opted_in', 'unknown')),
  snapshot_contactability_requirement text not null
    check (snapshot_contactability_requirement in ('any', 'reachable', 'unknown')),
  snapshot_prior_registration_event_id uuid references public.events(id) on delete restrict,
  snapshot_prior_registration_payment_status text not null
    check (snapshot_prior_registration_payment_status in ('any', 'paid')),
  required_channel text not null check (
    required_channel in ('email', 'phone', 'sms', 'instagram', 'linkedin', 'whatsapp', 'telegram')
  ),
  status text not null default 'draft' check (status in ('draft', 'archived')),
  created_by text not null check (char_length(trim(created_by)) between 1 and 320),
  updated_by text not null check (char_length(trim(updated_by)) between 1 and 320),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    snapshot_contact_channel is not null
    or (
      snapshot_consent_requirement = 'any'
      and snapshot_contactability_requirement = 'any'
    )
  ),
  check (
    snapshot_prior_registration_event_id is not null
    or snapshot_prior_registration_payment_status = 'any'
  )
);

create unique index event_audience_selections_event_name_lower_unique_idx
  on public.event_audience_selections(event_id, lower(trim(name)));
create index event_audience_selections_segment_idx
  on public.event_audience_selections(segment_id, created_at desc);
create index event_audience_selections_status_idx
  on public.event_audience_selections(status, event_id);

create table public.event_audience_selection_overrides (
  id uuid primary key default gen_random_uuid(),
  selection_id uuid not null references public.event_audience_selections(id) on delete cascade,
  person_id uuid not null references public.people(id) on delete restrict,
  decision text not null check (decision in ('include', 'exclude')),
  note text not null default '' check (char_length(note) <= 1000),
  created_by text not null check (char_length(trim(created_by)) between 1 and 320),
  updated_by text not null check (char_length(trim(updated_by)) between 1 and 320),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (selection_id, person_id)
);

create index event_audience_selection_overrides_person_idx
  on public.event_audience_selection_overrides(person_id, selection_id);

alter table public.audience_segments enable row level security;
alter table public.event_audience_selections enable row level security;
alter table public.event_audience_selection_overrides enable row level security;

revoke all on table public.audience_segments from public, anon, authenticated;
revoke all on table public.event_audience_selections from public, anon, authenticated;
revoke all on table public.event_audience_selection_overrides from public, anon, authenticated;

grant select, insert, update, delete on table public.audience_segments to service_role;
grant select, insert, update, delete on table public.event_audience_selections to service_role;
grant select, insert, update, delete on table public.event_audience_selection_overrides to service_role;

create or replace function public.get_audience_segment_candidates(
  p_limit integer default 5001,
  p_prior_registration_event_id uuid default null
)
returns table (
  person_id uuid,
  full_name text,
  gender text,
  city text,
  source text,
  import_batch_id uuid,
  suppression_status text,
  identity_status text,
  contacts jsonb,
  prior_registrations jsonb
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    person.id as person_id,
    person.full_name,
    person.gender,
    person.city,
    person.source,
    person.import_batch_id,
    person.suppression_status,
    person.identity_status,
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'channel', contact.channel,
            'consent_status', contact.consent_status,
            'contactability_status', contact.contactability_status
          )
          order by contact.channel, contact.consent_status, contact.contactability_status
        )
        from (
          select distinct
            existing_contact.channel,
            existing_contact.consent_status,
            existing_contact.contactability_status
          from public.person_contacts as existing_contact
          where existing_contact.person_id = person.id
            and existing_contact.channel in ('email', 'phone', 'sms', 'instagram', 'linkedin', 'whatsapp', 'telegram')
        ) as contact
      ),
      '[]'::jsonb
    ) as contacts,
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'event_id', registration.event_id,
            'payment_status', registration.payment_status
          )
          order by registration.event_id, registration.payment_status
        )
        from (
          select distinct existing_registration.event_id, existing_registration.payment_status
          from public.registrations as existing_registration
          where existing_registration.person_id = person.id
            and p_prior_registration_event_id is not null
            and existing_registration.event_id = p_prior_registration_event_id
        ) as registration
      ),
      '[]'::jsonb
    ) as prior_registrations
  from public.people as person
  order by person.id
  limit least(greatest(coalesce(p_limit, 5001), 1), 5001);
$$;

revoke execute on function public.get_audience_segment_candidates(integer, uuid)
  from public, anon, authenticated;
grant execute on function public.get_audience_segment_candidates(integer, uuid)
  to service_role;

create or replace function public.preview_event_audience_selection(
  p_selection_id uuid,
  p_limit integer default 5001
)
returns table (
  person_id uuid,
  full_name text,
  eligible boolean,
  reason_codes text[],
  required_channel text,
  usable_contact_id uuid,
  usable_contact_value text,
  usable_contact_normalized_value text,
  usable_contact_consent_status text,
  usable_contact_contactability_status text,
  suppression_status text,
  identity_status text
)
language sql
stable
security invoker
set search_path = ''
as $$
  with selection as (
    select selected.*
    from public.event_audience_selections as selected
    where selected.id = p_selection_id
  ),
  candidate_signals as (
    select
      person.id as candidate_person_id,
      person.full_name as candidate_full_name,
      person.gender as candidate_gender,
      person.city as candidate_city,
      person.source as candidate_source,
      person.import_batch_id as candidate_import_batch_id,
      person.suppression_status as candidate_suppression_status,
      person.identity_status as candidate_identity_status,
      selected.status as selection_status,
      selected.required_channel as selected_required_channel,
      selected.snapshot_gender,
      selected.snapshot_city,
      selected.snapshot_source,
      selected.snapshot_import_batch_id,
      selected.snapshot_contact_channel,
      selected.snapshot_consent_requirement,
      selected.snapshot_contactability_requirement,
      selected.snapshot_prior_registration_event_id,
      selected.snapshot_prior_registration_payment_status,
      manual.decision as manual_decision,
      usable.id as usable_contact_id,
      usable.value as usable_contact_value,
      usable.normalized_value as usable_contact_normalized_value,
      usable.consent_status as usable_contact_consent_status,
      usable.contactability_status as usable_contact_contactability_status,
      exists (
        select 1
        from public.person_contacts as required_contact
        where required_contact.person_id = person.id
          and required_contact.channel = selected.required_channel
      ) as has_required_channel,
      exists (
        select 1
        from public.person_contacts as required_contact
        where required_contact.person_id = person.id
          and required_contact.channel = selected.required_channel
          and required_contact.consent_status = 'opted_out'
      ) as required_channel_has_opted_out,
      exists (
        select 1
        from public.person_contacts as required_contact
        where required_contact.person_id = person.id
          and required_contact.channel = selected.required_channel
          and required_contact.consent_status = 'unknown'
      ) as required_channel_has_unknown_consent,
      exists (
        select 1
        from public.person_contacts as required_contact
        where required_contact.person_id = person.id
          and required_contact.channel = selected.required_channel
          and required_contact.contactability_status = 'suppressed'
      ) as required_channel_has_suppressed_contact,
      exists (
        select 1
        from public.person_contacts as required_contact
        where required_contact.person_id = person.id
          and required_contact.channel = selected.required_channel
          and required_contact.contactability_status = 'unreachable'
      ) as required_channel_has_unreachable_contact,
      exists (
        select 1
        from public.person_contacts as segment_contact
        where segment_contact.person_id = person.id
          and segment_contact.channel = selected.snapshot_contact_channel
      ) as has_segment_channel,
      exists (
        select 1
        from public.person_contacts as segment_contact
        where segment_contact.person_id = person.id
          and segment_contact.channel = selected.snapshot_contact_channel
          and segment_contact.consent_status <> 'opted_out'
      ) as segment_channel_has_non_opted_out,
      exists (
        select 1
        from public.person_contacts as segment_contact
        where segment_contact.person_id = person.id
          and segment_contact.channel = selected.snapshot_contact_channel
          and segment_contact.consent_status = selected.snapshot_consent_requirement
      ) as segment_channel_matches_consent,
      exists (
        select 1
        from public.person_contacts as segment_contact
        where segment_contact.person_id = person.id
          and segment_contact.channel = selected.snapshot_contact_channel
          and segment_contact.consent_status <> 'opted_out'
          and segment_contact.contactability_status = selected.snapshot_contactability_requirement
      ) as segment_channel_matches_contactability,
      exists (
        select 1
        from public.person_contacts as segment_contact
        where segment_contact.person_id = person.id
          and segment_contact.channel = selected.snapshot_contact_channel
          and segment_contact.consent_status <> 'opted_out'
          and (
            selected.snapshot_consent_requirement = 'any'
            or segment_contact.consent_status = selected.snapshot_consent_requirement
          )
          and (
            selected.snapshot_contactability_requirement = 'any'
            or segment_contact.contactability_status = selected.snapshot_contactability_requirement
          )
      ) as segment_channel_matches_combined_policy,
      exists (
        select 1
        from public.person_contacts as segment_contact
        where segment_contact.person_id = person.id
          and segment_contact.channel = selected.snapshot_contact_channel
          and segment_contact.consent_status = 'opted_in'
      ) as segment_channel_has_opted_in,
      exists (
        select 1
        from public.person_contacts as segment_contact
        where segment_contact.person_id = person.id
          and segment_contact.channel = selected.snapshot_contact_channel
          and segment_contact.consent_status = 'unknown'
      ) as segment_channel_has_unknown_consent,
      exists (
        select 1
        from public.person_contacts as segment_contact
        where segment_contact.person_id = person.id
          and segment_contact.channel = selected.snapshot_contact_channel
          and segment_contact.consent_status <> 'opted_out'
          and segment_contact.contactability_status = 'reachable'
      ) as segment_channel_has_reachable,
      exists (
        select 1
        from public.person_contacts as segment_contact
        where segment_contact.person_id = person.id
          and segment_contact.channel = selected.snapshot_contact_channel
          and segment_contact.consent_status <> 'opted_out'
          and segment_contact.contactability_status = 'unknown'
      ) as segment_channel_has_unknown_contactability,
      exists (
        select 1
        from public.registrations as prior_registration
        where prior_registration.person_id = person.id
          and prior_registration.event_id = selected.snapshot_prior_registration_event_id
          and (
            selected.snapshot_prior_registration_payment_status = 'any'
            or prior_registration.payment_status = 'paid'
          )
      ) as matches_prior_registration
    from selection as selected
    cross join public.people as person
    left join public.event_audience_selection_overrides as manual
      on manual.selection_id = selected.id
      and manual.person_id = person.id
    left join lateral (
      select required_contact.*
      from public.person_contacts as required_contact
      where required_contact.person_id = person.id
        and required_contact.channel = selected.required_channel
        and required_contact.consent_status = 'opted_in'
        and required_contact.contactability_status = 'reachable'
      order by required_contact.is_primary desc, required_contact.id
      limit 1
    ) as usable on true
  ),
  classified as (
    select
      signal.*,
      case
        when signal.manual_decision = 'exclude' then 'excluded_manual'
        when signal.selection_status = 'archived' then 'excluded_selection_archived'
        when signal.candidate_suppression_status = 'suppressed' then 'excluded_suppressed'
        when signal.candidate_identity_status = 'review_required' then 'excluded_identity_review_required'
        when signal.usable_contact_id is not null then null
        when not signal.has_required_channel then 'excluded_required_channel_missing'
        when signal.required_channel_has_opted_out then 'excluded_required_channel_opted_out'
        when signal.required_channel_has_unknown_consent then 'excluded_required_channel_consent_unknown'
        when signal.required_channel_has_suppressed_contact then 'excluded_required_channel_suppressed'
        when signal.required_channel_has_unreachable_contact then 'excluded_required_channel_unreachable'
        else 'excluded_required_channel_contactability_unknown'
      end as hard_exclusion_reason,
      array_remove(
        array[
          case
            when signal.snapshot_gender is not null
              and signal.candidate_gender is distinct from signal.snapshot_gender
            then 'excluded_gender'
          end,
          case
            when signal.snapshot_city is not null
              and lower(regexp_replace(trim(signal.candidate_city), '[[:space:]]+', ' ', 'g'))
                is distinct from lower(regexp_replace(trim(signal.snapshot_city), '[[:space:]]+', ' ', 'g'))
            then 'excluded_city'
          end,
          case
            when signal.snapshot_source is not null
              and lower(regexp_replace(trim(signal.candidate_source), '[[:space:]]+', ' ', 'g'))
                is distinct from lower(regexp_replace(trim(signal.snapshot_source), '[[:space:]]+', ' ', 'g'))
            then 'excluded_source'
          end,
          case
            when signal.snapshot_import_batch_id is not null
              and signal.candidate_import_batch_id is distinct from signal.snapshot_import_batch_id
            then 'excluded_import_batch'
          end,
          case
            when signal.snapshot_contact_channel is not null
              and not signal.has_segment_channel
            then 'excluded_contact_channel'
          end,
          case
            when signal.snapshot_contact_channel is not null
              and signal.has_segment_channel
              and signal.snapshot_consent_requirement <> 'any'
              and not signal.segment_channel_matches_consent
            then 'excluded_consent'
          end,
          case
            when signal.snapshot_contact_channel is not null
              and signal.has_segment_channel
              and signal.snapshot_contactability_requirement <> 'any'
              and not signal.segment_channel_matches_contactability
            then 'excluded_contactability'
          end,
          case
            when signal.snapshot_contact_channel is not null
              and signal.has_segment_channel
              and (
                signal.snapshot_consent_requirement = 'any'
                or signal.segment_channel_matches_consent
              )
              and (
                signal.snapshot_contactability_requirement = 'any'
                or signal.segment_channel_matches_contactability
              )
              and not signal.segment_channel_matches_combined_policy
            then 'excluded_contact_policy_combination'
          end,
          case
            when signal.snapshot_prior_registration_event_id is not null
              and not signal.matches_prior_registration
            then 'excluded_prior_registration'
          end
        ]::text[],
        null
      ) as criteria_exclusion_reasons,
      signal.snapshot_contact_channel is not null
        and signal.has_segment_channel
        and not signal.segment_channel_has_non_opted_out as segment_channel_is_opted_out
    from candidate_signals as signal
  )
  select
    classified.candidate_person_id as person_id,
    classified.candidate_full_name as full_name,
    case
      when classified.hard_exclusion_reason is not null then false
      when classified.segment_channel_is_opted_out then false
      when classified.manual_decision = 'include' then true
      else cardinality(classified.criteria_exclusion_reasons) = 0
    end as eligible,
    case
      when classified.hard_exclusion_reason is not null
        then array[classified.hard_exclusion_reason]::text[]
      when classified.segment_channel_is_opted_out
        then array['excluded_contact_channel_opted_out']::text[]
      when classified.manual_decision = 'include'
        then array[
          case
            when cardinality(classified.criteria_exclusion_reasons) > 0
              then 'included_manual_override'
            else 'included_manual'
          end
        ]::text[]
      when cardinality(classified.criteria_exclusion_reasons) > 0
        then classified.criteria_exclusion_reasons
      when classified.snapshot_contact_channel is not null
        and classified.snapshot_consent_requirement = 'any'
        and not classified.segment_channel_has_opted_in
        and classified.segment_channel_has_unknown_consent
        then array['included_consent_unknown']::text[]
      when classified.snapshot_contact_channel is not null
        and classified.snapshot_contactability_requirement = 'any'
        and not classified.segment_channel_has_reachable
        and classified.segment_channel_has_unknown_contactability
        then array['included_contactability_unknown']::text[]
      else array['included_criteria_match']::text[]
    end as reason_codes,
    classified.selected_required_channel as required_channel,
    classified.usable_contact_id,
    classified.usable_contact_value,
    classified.usable_contact_normalized_value,
    classified.usable_contact_consent_status,
    classified.usable_contact_contactability_status,
    classified.candidate_suppression_status as suppression_status,
    classified.candidate_identity_status as identity_status
  from classified
  order by lower(classified.candidate_full_name), classified.candidate_person_id
  limit least(greatest(coalesce(p_limit, 5001), 1), 5001);
$$;

revoke execute on function public.preview_event_audience_selection(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.preview_event_audience_selection(uuid, integer)
  to service_role;
