create table public.message_templates (
  id uuid primary key default gen_random_uuid(),
  template_key text not null unique
    check (template_key ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' and char_length(template_key) <= 120),
  name text not null check (char_length(trim(name)) between 1 and 160),
  channel text not null check (channel in ('email', 'sms', 'whatsapp', 'telegram', 'instagram')),
  status text not null default 'active' check (status in ('active', 'archived')),
  created_by text not null check (char_length(trim(created_by)) between 1 and 320),
  updated_by text not null check (char_length(trim(updated_by)) between 1 and 320),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, channel)
);

create table public.message_template_versions (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  template_id uuid not null,
  channel text not null,
  version integer not null check (version > 0),
  subject_template text check (subject_template is null or char_length(subject_template) <= 500),
  body_template text not null check (char_length(body_template) between 1 and 10000),
  variables text[] not null default '{}'::text[] check (cardinality(variables) <= 32),
  created_by text not null check (char_length(trim(created_by)) between 1 and 320),
  created_at timestamptz not null default now(),
  foreign key (template_id, channel)
    references public.message_templates(id, channel) on delete restrict,
  unique (template_id, version),
  unique (id, channel),
  check (
    (channel = 'email' and subject_template is not null and char_length(trim(subject_template)) > 0)
    or (channel <> 'email' and subject_template is null)
  )
);

create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  event_id uuid not null references public.events(id) on delete restrict,
  audience_selection_id uuid not null references public.event_audience_selections(id) on delete restrict,
  template_version_id uuid not null,
  name text not null check (char_length(trim(name)) between 1 and 160),
  channel text not null check (channel in ('email', 'sms', 'whatsapp', 'telegram', 'instagram')),
  delivery_mode text not null check (delivery_mode in ('disabled', 'dry_run')),
  status text not null default 'previewed'
    check (status in ('previewed', 'queued', 'processing', 'dry_run_completed', 'completed', 'cancelled', 'failed')),
  sending_time_zone text not null default 'America/New_York'
    check (sending_time_zone = 'America/New_York'),
  sending_window_start time not null default '09:00',
  sending_window_end time not null default '17:00',
  allowed_weekdays smallint[] not null default array[1, 2, 3, 4, 5]::smallint[]
    check (
      cardinality(allowed_weekdays) between 1 and 7
      and allowed_weekdays <@ array[0, 1, 2, 3, 4, 5, 6]::smallint[]
    ),
  scheduled_at timestamptz not null default now(),
  selection_updated_at_snapshot timestamptz not null,
  recipient_count integer not null default 0 check (recipient_count >= 0 and recipient_count <= 5000),
  created_by text not null check (char_length(trim(created_by)) between 1 and 320),
  updated_by text not null check (char_length(trim(updated_by)) between 1 and 320),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  queued_at timestamptz,
  completed_at timestamptz,
  foreign key (template_version_id, channel)
    references public.message_template_versions(id, channel) on delete restrict,
  unique (id, template_version_id),
  check (
    (status in ('dry_run_completed', 'completed', 'cancelled', 'failed') and completed_at is not null)
    or (status not in ('dry_run_completed', 'completed', 'cancelled', 'failed') and completed_at is null)
  ),
  check (status = 'previewed' or queued_at is not null)
);

alter table public.person_contacts
  add constraint person_contacts_id_person_id_unique unique (id, person_id);

create table public.campaign_recipients (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null,
  template_version_id uuid not null,
  ordinal integer not null check (ordinal > 0 and ordinal <= 5000),
  person_id uuid not null references public.people(id) on delete restrict,
  contact_id uuid not null,
  channel text not null check (channel in ('email', 'sms', 'whatsapp', 'telegram', 'instagram')),
  destination_snapshot text not null check (char_length(trim(destination_snapshot)) between 1 and 500),
  normalized_destination_snapshot text not null
    check (char_length(trim(normalized_destination_snapshot)) between 1 and 500),
  consent_status_snapshot text not null check (consent_status_snapshot in ('unknown', 'opted_in', 'opted_out')),
  contactability_status_snapshot text not null
    check (contactability_status_snapshot in ('unknown', 'reachable', 'unreachable', 'suppressed')),
  suppression_status_snapshot text not null check (suppression_status_snapshot in ('active', 'suppressed')),
  identity_status_snapshot text not null check (identity_status_snapshot in ('resolved', 'review_required')),
  selection_reason_codes text[] not null default '{}'::text[],
  eligibility text not null check (eligibility in ('eligible', 'blocked')),
  policy_reason text not null check (
    policy_reason in (
      'allowed',
      'person_suppressed',
      'contact_opted_out',
      'unknown_consent',
      'unusable_channel',
      'missing_destination',
      'unknown_contactability',
      'contact_unreachable',
      'contact_suppressed',
      'stale_destination',
      'duplicate_destination_ownership'
    )
  ),
  template_variables_snapshot jsonb not null default '{}'::jsonb
    check (jsonb_typeof(template_variables_snapshot) = 'object'),
  rendered_subject_snapshot text,
  rendered_body_snapshot text not null check (char_length(rendered_body_snapshot) between 1 and 10000),
  idempotency_key text not null unique check (char_length(idempotency_key) between 1 and 500),
  available_at timestamptz not null,
  created_at timestamptz not null default now(),
  foreign key (campaign_id, template_version_id)
    references public.campaigns(id, template_version_id) on delete restrict,
  foreign key (contact_id, person_id)
    references public.person_contacts(id, person_id) on delete restrict,
  unique (campaign_id, ordinal),
  unique (campaign_id, person_id),
  check (
    (eligibility = 'eligible' and policy_reason = 'allowed')
    or (eligibility = 'blocked' and policy_reason <> 'allowed')
  )
);

create table public.outbox_messages (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns(id) on delete restrict,
  campaign_recipient_id uuid not null unique references public.campaign_recipients(id) on delete restrict,
  person_id uuid not null references public.people(id) on delete restrict,
  contact_id uuid not null references public.person_contacts(id) on delete restrict,
  idempotency_key text not null unique check (char_length(idempotency_key) between 1 and 500),
  channel text not null check (channel in ('email', 'sms', 'whatsapp', 'telegram', 'instagram')),
  destination_snapshot text not null check (char_length(trim(destination_snapshot)) between 1 and 500),
  normalized_destination_snapshot text not null
    check (char_length(trim(normalized_destination_snapshot)) between 1 and 500),
  subject_snapshot text,
  body_snapshot text not null check (char_length(body_snapshot) between 1 and 10000),
  delivery_mode text not null check (delivery_mode in ('disabled', 'dry_run')),
  status text not null default 'pending'
    check (status in ('pending', 'claimed', 'retry_scheduled', 'blocked', 'dry_run_completed', 'disabled', 'failed', 'cancelled')),
  available_at timestamptz not null,
  attempt_count integer not null default 0 check (attempt_count >= 0 and attempt_count <= 20),
  lease_owner text,
  leased_at timestamptz,
  last_result_code text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (status = 'claimed' and lease_owner is not null and leased_at is not null)
    or (status <> 'claimed' and lease_owner is null and leased_at is null)
  ),
  check (
    (status in ('blocked', 'dry_run_completed', 'disabled', 'failed', 'cancelled') and completed_at is not null)
    or (status not in ('blocked', 'dry_run_completed', 'disabled', 'failed', 'cancelled') and completed_at is null)
  )
);

create table public.delivery_attempts (
  id uuid primary key default gen_random_uuid(),
  outbox_message_id uuid not null references public.outbox_messages(id) on delete restrict,
  attempt_number integer not null check (attempt_number > 0 and attempt_number <= 20),
  adapter text not null check (adapter in ('disabled', 'dry_run')),
  outcome text not null check (outcome in ('retry_scheduled', 'blocked', 'dry_run_completed', 'disabled', 'failed')),
  result_code text not null check (char_length(trim(result_code)) between 1 and 120),
  error_classification text check (error_classification in ('retryable', 'permanent')),
  provider_called boolean not null default false check (provider_called = false),
  provider_message_id text check (provider_message_id is null or char_length(trim(provider_message_id)) between 1 and 500),
  available_at timestamptz,
  operator_identity text not null check (char_length(trim(operator_identity)) between 1 and 320),
  started_at timestamptz not null,
  completed_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (outbox_message_id, attempt_number),
  check (not provider_called and provider_message_id is null),
  check ((outcome = 'retry_scheduled' and available_at is not null) or outcome <> 'retry_scheduled'),
  check (completed_at >= started_at)
);

create table public.outbound_audit_entries (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique check (char_length(idempotency_key) between 1 and 500),
  action text not null check (action ~ '^[a-z0-9_]+$' and char_length(action) <= 120),
  operator_identity text not null check (char_length(trim(operator_identity)) between 1 and 320),
  template_id uuid references public.message_templates(id) on delete restrict,
  template_version_id uuid references public.message_template_versions(id) on delete restrict,
  campaign_id uuid references public.campaigns(id) on delete restrict,
  campaign_recipient_id uuid references public.campaign_recipients(id) on delete restrict,
  outbox_message_id uuid references public.outbox_messages(id) on delete restrict,
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  created_at timestamptz not null default now(),
  check (
    template_id is not null
    or template_version_id is not null
    or campaign_id is not null
    or campaign_recipient_id is not null
    or outbox_message_id is not null
  )
);

create index message_template_versions_template_idx
  on public.message_template_versions(template_id, version desc);
create index campaigns_event_created_idx
  on public.campaigns(event_id, created_at desc);
create index campaigns_selection_created_idx
  on public.campaigns(audience_selection_id, created_at desc);
create index campaigns_status_scheduled_idx
  on public.campaigns(status, scheduled_at, id);
create index campaign_recipients_campaign_eligibility_idx
  on public.campaign_recipients(campaign_id, eligibility, ordinal);
create index campaign_recipients_person_idx
  on public.campaign_recipients(person_id, campaign_id);
create index campaign_recipients_contact_idx
  on public.campaign_recipients(contact_id, campaign_id);
create index outbox_messages_campaign_status_idx
  on public.outbox_messages(campaign_id, status, available_at, id);
create index outbox_messages_due_idx
  on public.outbox_messages(available_at, id)
  where status in ('pending', 'retry_scheduled');
create index outbox_messages_person_idx
  on public.outbox_messages(person_id, created_at desc);
create index outbox_messages_contact_idx
  on public.outbox_messages(contact_id, created_at desc);
create index delivery_attempts_message_created_idx
  on public.delivery_attempts(outbox_message_id, attempt_number desc);
create index outbound_audit_campaign_created_idx
  on public.outbound_audit_entries(campaign_id, created_at desc)
  where campaign_id is not null;
create index outbound_audit_outbox_created_idx
  on public.outbound_audit_entries(outbox_message_id, created_at desc)
  where outbox_message_id is not null;

alter table public.message_templates enable row level security;
alter table public.message_template_versions enable row level security;
alter table public.campaigns enable row level security;
alter table public.campaign_recipients enable row level security;
alter table public.outbox_messages enable row level security;
alter table public.delivery_attempts enable row level security;
alter table public.outbound_audit_entries enable row level security;

alter table public.message_templates force row level security;
alter table public.message_template_versions force row level security;
alter table public.campaigns force row level security;
alter table public.campaign_recipients force row level security;
alter table public.outbox_messages force row level security;
alter table public.delivery_attempts force row level security;
alter table public.outbound_audit_entries force row level security;

revoke all on table public.message_templates from public, anon, authenticated;
revoke all on table public.message_template_versions from public, anon, authenticated;
revoke all on table public.campaigns from public, anon, authenticated;
revoke all on table public.campaign_recipients from public, anon, authenticated;
revoke all on table public.outbox_messages from public, anon, authenticated;
revoke all on table public.delivery_attempts from public, anon, authenticated;
revoke all on table public.outbound_audit_entries from public, anon, authenticated;

grant select, insert, update, delete on table public.message_templates to service_role;
grant select, insert, update, delete on table public.message_template_versions to service_role;
grant select, insert, update, delete on table public.campaigns to service_role;
grant select, insert, update, delete on table public.campaign_recipients to service_role;
grant select, insert, update, delete on table public.outbox_messages to service_role;
grant select, insert, update, delete on table public.delivery_attempts to service_role;
grant select, insert, update, delete on table public.outbound_audit_entries to service_role;

create or replace function public.reject_outbound_immutable_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception using errcode = 'P0001', message = 'immutable_outbound_record';
end;
$$;

create trigger message_template_versions_immutable
before update or delete on public.message_template_versions
for each row execute function public.reject_outbound_immutable_mutation();

create trigger campaign_recipients_immutable
before update or delete on public.campaign_recipients
for each row execute function public.reject_outbound_immutable_mutation();

create trigger delivery_attempts_immutable
before update or delete on public.delivery_attempts
for each row execute function public.reject_outbound_immutable_mutation();

create trigger outbound_audit_entries_immutable
before update or delete on public.outbound_audit_entries
for each row execute function public.reject_outbound_immutable_mutation();

create or replace function public.render_message_template_text(
  p_template text,
  p_values jsonb,
  p_allowed_variables text[]
)
returns text
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  rendered text := p_template;
  placeholder text[];
  remainder text;
begin
  if p_template is null then
    return null;
  end if;

  if p_values is null or jsonb_typeof(p_values) <> 'object' then
    raise exception using errcode = 'P0001', message = 'template_values_must_be_object';
  end if;

  for placeholder in
    select pg_catalog.regexp_matches(
      p_template,
      '({{\s*([a-z][a-z0-9_]*)\s*}})',
      'g'
    )
  loop
    if not (placeholder[2] = any(coalesce(p_allowed_variables, '{}'::text[]))) then
      raise exception using errcode = 'P0001', message = 'template_variable_not_declared';
    end if;

    if not (p_values ? placeholder[2]) or jsonb_typeof(p_values -> placeholder[2]) <> 'string' then
      raise exception using errcode = 'P0001', message = 'template_variable_missing';
    end if;

    rendered := pg_catalog.replace(rendered, placeholder[1], p_values ->> placeholder[2]);
  end loop;

  remainder := pg_catalog.regexp_replace(
    p_template,
    '{{\s*[a-z][a-z0-9_]*\s*}}',
    '',
    'g'
  );
  if pg_catalog.strpos(remainder, '{{') > 0 or pg_catalog.strpos(remainder, '}}') > 0 then
    raise exception using errcode = 'P0001', message = 'malformed_template_placeholder';
  end if;

  return rendered;
end;
$$;

create or replace function public.create_message_template_version(
  p_request_id uuid,
  p_template_key text,
  p_name text,
  p_channel text,
  p_subject_template text,
  p_body_template text,
  p_variables text[],
  p_created_by text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  selected_template public.message_templates%rowtype;
  existing_version public.message_template_versions%rowtype;
  created_version public.message_template_versions%rowtype;
  next_version integer;
  dummy_values jsonb;
  normalized_variables text[];
begin
  if p_request_id is null then
    raise exception using errcode = 'P0001', message = 'missing_template_request_id';
  end if;
  if p_template_key is null
     or p_template_key !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
     or char_length(p_template_key) > 120 then
    raise exception using errcode = 'P0001', message = 'invalid_template_key';
  end if;
  if p_name is null or char_length(trim(p_name)) not between 1 and 160 then
    raise exception using errcode = 'P0001', message = 'invalid_template_name';
  end if;
  if p_channel is null or p_channel not in ('email', 'sms', 'whatsapp', 'telegram', 'instagram') then
    raise exception using errcode = 'P0001', message = 'invalid_template_channel';
  end if;
  if p_body_template is null or char_length(p_body_template) not between 1 and 10000 then
    raise exception using errcode = 'P0001', message = 'invalid_template_body';
  end if;
  if (p_channel = 'email' and (p_subject_template is null or char_length(trim(p_subject_template)) = 0))
     or (p_channel <> 'email' and p_subject_template is not null) then
    raise exception using errcode = 'P0001', message = 'invalid_template_subject';
  end if;
  if p_subject_template is not null and char_length(p_subject_template) > 500 then
    raise exception using errcode = 'P0001', message = 'template_subject_too_long';
  end if;
  if p_created_by is null or char_length(trim(p_created_by)) not between 1 and 320 then
    raise exception using errcode = 'P0001', message = 'missing_template_operator';
  end if;
  if cardinality(coalesce(p_variables, '{}'::text[])) > 32
     or exists (
       select 1
       from unnest(coalesce(p_variables, '{}'::text[])) as variable(name)
       where variable.name !~ '^[a-z][a-z0-9_]{0,63}$'
          or variable.name not in ('full_name', 'event_title', 'event_date', 'event_time', 'venue')
     )
     or cardinality(coalesce(p_variables, '{}'::text[])) <> (
       select count(distinct variable.name)
       from unnest(coalesce(p_variables, '{}'::text[])) as variable(name)
     ) then
    raise exception using errcode = 'P0001', message = 'invalid_template_variables';
  end if;

  select coalesce(array_agg(variable.name order by variable.name), '{}'::text[])
  into normalized_variables
  from unnest(coalesce(p_variables, '{}'::text[])) as variable(name);

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('marat_template_request:' || p_request_id::text, 0)
  );

  select existing.*
  into existing_version
  from public.message_template_versions as existing
  where existing.request_id = p_request_id;

  if found then
    if not exists (
      select 1
      from public.message_templates as template
      where template.id = existing_version.template_id
        and template.template_key = p_template_key
        and template.channel = p_channel
        and existing_version.subject_template is not distinct from p_subject_template
        and existing_version.body_template = p_body_template
        and existing_version.variables = normalized_variables
    ) then
      raise exception using errcode = 'P0001', message = 'template_request_id_reused';
    end if;

    return jsonb_build_object(
      'status', 'already_created',
      'template_id', existing_version.template_id,
      'template_version_id', existing_version.id,
      'version', existing_version.version
    );
  end if;

  select coalesce(jsonb_object_agg(variable.name, variable.name), '{}'::jsonb)
  into dummy_values
  from unnest(normalized_variables) as variable(name);

  perform public.render_message_template_text(p_subject_template, dummy_values, normalized_variables);
  perform public.render_message_template_text(p_body_template, dummy_values, normalized_variables);

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('marat_template:' || p_template_key, 0)
  );

  select template.*
  into selected_template
  from public.message_templates as template
  where template.template_key = p_template_key
  for update;

  if not found then
    insert into public.message_templates (
      template_key,
      name,
      channel,
      status,
      created_by,
      updated_by
    )
    values (
      p_template_key,
      trim(p_name),
      p_channel,
      'active',
      trim(p_created_by),
      trim(p_created_by)
    )
    returning * into selected_template;
  elsif selected_template.channel <> p_channel or selected_template.status <> 'active' then
    raise exception using errcode = 'P0001', message = 'template_not_active_for_channel';
  else
    update public.message_templates
    set name = trim(p_name),
        updated_by = trim(p_created_by),
        updated_at = now()
    where id = selected_template.id
    returning * into selected_template;
  end if;

  select coalesce(max(version), 0) + 1
  into next_version
  from public.message_template_versions
  where template_id = selected_template.id;

  insert into public.message_template_versions (
    request_id,
    template_id,
    channel,
    version,
    subject_template,
    body_template,
    variables,
    created_by
  )
  values (
    p_request_id,
    selected_template.id,
    selected_template.channel,
    next_version,
    p_subject_template,
    p_body_template,
    normalized_variables,
    trim(p_created_by)
  )
  returning * into created_version;

  insert into public.outbound_audit_entries (
    idempotency_key,
    action,
    operator_identity,
    template_id,
    template_version_id,
    details
  )
  values (
    'template-version-created:' || p_request_id::text,
    'template_version_created',
    trim(p_created_by),
    selected_template.id,
    created_version.id,
    jsonb_build_object(
      'channel', selected_template.channel,
      'template_key', selected_template.template_key,
      'version', created_version.version
    )
  );

  return jsonb_build_object(
    'status', 'created',
    'template_id', selected_template.id,
    'template_version_id', created_version.id,
    'version', created_version.version
  );
end;
$$;

create or replace function public.create_campaign_preview(
  p_request_id uuid,
  p_selection_id uuid,
  p_template_version_id uuid,
  p_name text,
  p_delivery_mode text,
  p_scheduled_at timestamptz,
  p_sending_window_start time,
  p_sending_window_end time,
  p_allowed_weekdays smallint[],
  p_created_by text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  selected_selection public.event_audience_selections%rowtype;
  selected_template_version public.message_template_versions%rowtype;
  selected_template public.message_templates%rowtype;
  selected_event public.events%rowtype;
  existing_campaign public.campaigns%rowtype;
  created_campaign public.campaigns%rowtype;
  evaluated_people jsonb;
  evaluated_count integer;
  expected_recipient_count integer;
  inserted_recipient_count integer;
begin
  if p_request_id is null then
    raise exception using errcode = 'P0001', message = 'missing_campaign_request_id';
  end if;
  if p_selection_id is null or p_template_version_id is null then
    raise exception using errcode = 'P0001', message = 'missing_campaign_reference';
  end if;
  if p_name is null or char_length(trim(p_name)) not between 1 and 160 then
    raise exception using errcode = 'P0001', message = 'invalid_campaign_name';
  end if;
  if p_delivery_mode is null or p_delivery_mode not in ('disabled', 'dry_run') then
    raise exception using errcode = 'P0001', message = 'unsupported_campaign_delivery_mode';
  end if;
  if p_sending_window_start is null or p_sending_window_end is null then
    raise exception using errcode = 'P0001', message = 'missing_campaign_sending_window';
  end if;
  if cardinality(coalesce(p_allowed_weekdays, '{}'::smallint[])) not between 1 and 7
     or not (p_allowed_weekdays <@ array[0, 1, 2, 3, 4, 5, 6]::smallint[])
     or cardinality(p_allowed_weekdays) <> (
       select count(distinct day)
       from unnest(p_allowed_weekdays) as allowed(day)
     ) then
    raise exception using errcode = 'P0001', message = 'invalid_campaign_weekdays';
  end if;
  if p_created_by is null or char_length(trim(p_created_by)) not between 1 and 320 then
    raise exception using errcode = 'P0001', message = 'missing_campaign_operator';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('marat_campaign_preview:' || p_request_id::text, 0)
  );

  select campaign.*
  into existing_campaign
  from public.campaigns as campaign
  where campaign.request_id = p_request_id;

  if found then
    if existing_campaign.audience_selection_id <> p_selection_id
       or existing_campaign.template_version_id <> p_template_version_id
       or existing_campaign.name <> trim(p_name)
       or existing_campaign.delivery_mode <> p_delivery_mode
       or existing_campaign.sending_window_start <> p_sending_window_start
       or existing_campaign.sending_window_end <> p_sending_window_end
       or existing_campaign.allowed_weekdays <> p_allowed_weekdays then
      raise exception using errcode = 'P0001', message = 'campaign_request_id_reused';
    end if;

    return jsonb_build_object(
      'status', 'already_created',
      'campaign_id', existing_campaign.id,
      'recipient_count', existing_campaign.recipient_count
    );
  end if;

  select selection.*
  into selected_selection
  from public.event_audience_selections as selection
  where selection.id = p_selection_id
  for update;

  if not found or selected_selection.status <> 'draft' then
    raise exception using errcode = 'P0001', message = 'campaign_selection_unavailable';
  end if;

  select version.*
  into selected_template_version
  from public.message_template_versions as version
  where version.id = p_template_version_id;

  if not found then
    raise exception using errcode = 'P0001', message = 'campaign_template_version_not_found';
  end if;

  select template.*
  into selected_template
  from public.message_templates as template
  where template.id = selected_template_version.template_id;

  if not found or selected_template.status <> 'active' then
    raise exception using errcode = 'P0001', message = 'campaign_template_unavailable';
  end if;
  if selected_template.channel <> selected_selection.required_channel then
    raise exception using errcode = 'P0001', message = 'campaign_channel_selection_mismatch';
  end if;

  select event.*
  into selected_event
  from public.events as event
  where event.id = selected_selection.event_id;

  if not found then
    raise exception using errcode = 'P0001', message = 'campaign_event_not_found';
  end if;

  select coalesce(
    jsonb_agg(to_jsonb(preview_row) order by lower(preview_row.full_name), preview_row.person_id),
    '[]'::jsonb
  )
  into evaluated_people
  from public.preview_event_audience_selection(selected_selection.id, 5001) as preview_row;

  evaluated_count := jsonb_array_length(evaluated_people);
  if evaluated_count > 5000 then
    raise exception using errcode = 'P0001', message = 'campaign_audience_limit_exceeded';
  end if;

  select count(*)
  into expected_recipient_count
  from jsonb_to_recordset(evaluated_people) as evaluated(
    person_id uuid,
    eligible boolean,
    required_channel text,
    usable_contact_id uuid,
    usable_contact_value text,
    usable_contact_normalized_value text,
    usable_contact_consent_status text,
    usable_contact_contactability_status text,
    suppression_status text,
    identity_status text
  )
  where evaluated.eligible;

  if expected_recipient_count = 0 then
    raise exception using errcode = 'P0001', message = 'campaign_has_no_eligible_recipients';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(evaluated_people) as evaluated(
      person_id uuid,
      eligible boolean,
      required_channel text,
      usable_contact_id uuid,
      usable_contact_normalized_value text
    )
    where evaluated.eligible
    group by evaluated.required_channel, evaluated.usable_contact_normalized_value
    having count(distinct evaluated.person_id) > 1
  ) then
    raise exception using errcode = 'P0001', message = 'campaign_duplicate_destination_ownership';
  end if;

  perform person.id
  from public.people as person
  join jsonb_to_recordset(evaluated_people) as evaluated(person_id uuid, eligible boolean)
    on evaluated.person_id = person.id
  where evaluated.eligible
  order by person.id
  for key share of person;

  perform contact.id
  from public.person_contacts as contact
  join jsonb_to_recordset(evaluated_people) as evaluated(usable_contact_id uuid, eligible boolean)
    on evaluated.usable_contact_id = contact.id
  where evaluated.eligible
  order by contact.id
  for key share of contact;

  insert into public.campaigns (
    request_id,
    event_id,
    audience_selection_id,
    template_version_id,
    name,
    channel,
    delivery_mode,
    status,
    sending_time_zone,
    sending_window_start,
    sending_window_end,
    allowed_weekdays,
    scheduled_at,
    selection_updated_at_snapshot,
    recipient_count,
    created_by,
    updated_by
  )
  values (
    p_request_id,
    selected_selection.event_id,
    selected_selection.id,
    selected_template_version.id,
    trim(p_name),
    selected_template.channel,
    p_delivery_mode,
    'previewed',
    'America/New_York',
    p_sending_window_start,
    p_sending_window_end,
    p_allowed_weekdays,
    coalesce(p_scheduled_at, now()),
    selected_selection.updated_at,
    0,
    trim(p_created_by),
    trim(p_created_by)
  )
  returning * into created_campaign;

  insert into public.campaign_recipients (
    campaign_id,
    template_version_id,
    ordinal,
    person_id,
    contact_id,
    channel,
    destination_snapshot,
    normalized_destination_snapshot,
    consent_status_snapshot,
    contactability_status_snapshot,
    suppression_status_snapshot,
    identity_status_snapshot,
    selection_reason_codes,
    eligibility,
    policy_reason,
    template_variables_snapshot,
    rendered_subject_snapshot,
    rendered_body_snapshot,
    idempotency_key,
    available_at
  )
  select
    created_campaign.id,
    selected_template_version.id,
    row_number() over (order by lower(evaluated.full_name), evaluated.person_id)::integer,
    evaluated.person_id,
    evaluated.usable_contact_id,
    selected_template.channel,
    evaluated.usable_contact_value,
    evaluated.usable_contact_normalized_value,
    evaluated.usable_contact_consent_status,
    evaluated.usable_contact_contactability_status,
    evaluated.suppression_status,
    evaluated.identity_status,
    evaluated.reason_codes,
    'eligible',
    'allowed',
    template_values.render_values,
    public.render_message_template_text(
      selected_template_version.subject_template,
      template_values.render_values,
      selected_template_version.variables
    ),
    public.render_message_template_text(
      selected_template_version.body_template,
      template_values.render_values,
      selected_template_version.variables
    ),
    'campaign-recipient:' || created_campaign.id::text || ':' || evaluated.person_id::text,
    created_campaign.scheduled_at
  from jsonb_to_recordset(evaluated_people) as evaluated(
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
  join public.people as person
    on person.id = evaluated.person_id
   and person.suppression_status = 'active'
   and person.identity_status = 'resolved'
  join public.person_contacts as contact
    on contact.id = evaluated.usable_contact_id
   and contact.person_id = evaluated.person_id
   and contact.channel = selected_template.channel
   and contact.value = evaluated.usable_contact_value
   and contact.normalized_value = evaluated.usable_contact_normalized_value
   and contact.consent_status = 'opted_in'
   and contact.contactability_status = 'reachable'
  cross join lateral (
    select jsonb_build_object(
      'full_name', evaluated.full_name,
      'event_title', selected_event.title,
      'event_date', to_char(selected_event.starts_at at time zone 'America/New_York', 'YYYY-MM-DD'),
      'event_time', to_char(selected_event.starts_at at time zone 'America/New_York', 'HH24:MI'),
      'venue', selected_event.venue
    ) as render_values
  ) as template_values
  where evaluated.eligible
    and evaluated.required_channel = selected_template.channel
    and evaluated.usable_contact_id is not null
    and evaluated.usable_contact_value is not null
    and evaluated.usable_contact_normalized_value is not null
    and evaluated.usable_contact_consent_status = 'opted_in'
    and evaluated.usable_contact_contactability_status = 'reachable'
    and evaluated.suppression_status = 'active'
    and evaluated.identity_status = 'resolved';

  get diagnostics inserted_recipient_count = row_count;
  if inserted_recipient_count <> expected_recipient_count then
    raise exception using errcode = 'P0001', message = 'campaign_preview_stale_policy';
  end if;

  update public.campaigns
  set recipient_count = inserted_recipient_count,
      updated_at = now()
  where id = created_campaign.id;

  insert into public.outbound_audit_entries (
    idempotency_key,
    action,
    operator_identity,
    template_id,
    template_version_id,
    campaign_id,
    details
  )
  values (
    'campaign-preview-created:' || p_request_id::text,
    'campaign_preview_created',
    trim(p_created_by),
    selected_template.id,
    selected_template_version.id,
    created_campaign.id,
    jsonb_build_object(
      'audience_selection_id', selected_selection.id,
      'delivery_mode', created_campaign.delivery_mode,
      'evaluated_count', evaluated_count,
      'recipient_count', inserted_recipient_count,
      'selection_updated_at_snapshot', selected_selection.updated_at
    )
  );

  return jsonb_build_object(
    'status', 'created',
    'campaign_id', created_campaign.id,
    'recipient_count', inserted_recipient_count
  );
end;
$$;

create or replace function public.queue_campaign_outbox(
  p_campaign_id uuid,
  p_queued_by text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  selected_campaign public.campaigns%rowtype;
  inserted_count integer;
  blocked_count integer;
begin
  if p_campaign_id is null then
    raise exception using errcode = 'P0001', message = 'missing_campaign_id';
  end if;
  if p_queued_by is null or char_length(trim(p_queued_by)) not between 1 and 320 then
    raise exception using errcode = 'P0001', message = 'missing_campaign_queue_operator';
  end if;

  select campaign.*
  into selected_campaign
  from public.campaigns as campaign
  where campaign.id = p_campaign_id
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'campaign_not_found';
  end if;

  if selected_campaign.status in ('queued', 'processing', 'dry_run_completed', 'completed') then
    select count(*), count(*) filter (where message.status = 'blocked')
    into inserted_count, blocked_count
    from public.outbox_messages as message
    where message.campaign_id = selected_campaign.id;

    return jsonb_build_object(
      'status', 'already_queued',
      'campaign_id', selected_campaign.id,
      'outbox_count', inserted_count,
      'blocked_count', blocked_count
    );
  end if;

  if selected_campaign.status <> 'previewed' then
    raise exception using errcode = 'P0001', message = 'campaign_not_queueable';
  end if;
  if selected_campaign.recipient_count = 0 then
    raise exception using errcode = 'P0001', message = 'campaign_has_no_recipients';
  end if;

  insert into public.outbox_messages (
    campaign_id,
    campaign_recipient_id,
    person_id,
    contact_id,
    idempotency_key,
    channel,
    destination_snapshot,
    normalized_destination_snapshot,
    subject_snapshot,
    body_snapshot,
    delivery_mode,
    status,
    available_at,
    attempt_count,
    last_result_code,
    completed_at
  )
  select
    recipient.campaign_id,
    recipient.id,
    recipient.person_id,
    recipient.contact_id,
    'outbox:' || recipient.id::text,
    recipient.channel,
    recipient.destination_snapshot,
    recipient.normalized_destination_snapshot,
    recipient.rendered_subject_snapshot,
    recipient.rendered_body_snapshot,
    selected_campaign.delivery_mode,
    case
      when person.suppression_status <> 'active' then 'blocked'
      when person.identity_status <> 'resolved' then 'blocked'
      when contact.consent_status = 'opted_out' then 'blocked'
      when contact.consent_status <> 'opted_in' then 'blocked'
      when contact.channel <> recipient.channel
        or contact.value <> recipient.destination_snapshot
        or contact.normalized_value <> recipient.normalized_destination_snapshot then 'blocked'
      when not ownership.destination_unique_owner then 'blocked'
      when contact.contactability_status = 'suppressed' then 'blocked'
      when contact.contactability_status = 'unreachable' then 'blocked'
      when contact.contactability_status <> 'reachable' then 'blocked'
      else 'pending'
    end,
    greatest(recipient.available_at, selected_campaign.scheduled_at),
    0,
    case
      when person.suppression_status <> 'active' then 'person_suppressed'
      when person.identity_status <> 'resolved' then 'identity_review_required'
      when contact.consent_status = 'opted_out' then 'contact_opted_out'
      when contact.consent_status <> 'opted_in' then 'unknown_consent'
      when contact.channel <> recipient.channel
        or contact.value <> recipient.destination_snapshot
        or contact.normalized_value <> recipient.normalized_destination_snapshot then 'stale_destination'
      when not ownership.destination_unique_owner then 'duplicate_destination_ownership'
      when contact.contactability_status = 'suppressed' then 'contact_suppressed'
      when contact.contactability_status = 'unreachable' then 'contact_unreachable'
      when contact.contactability_status <> 'reachable' then 'unknown_contactability'
      else null
    end,
    case
      when person.suppression_status <> 'active'
        or person.identity_status <> 'resolved'
        or not ownership.destination_unique_owner
        or contact.channel <> recipient.channel
        or contact.value <> recipient.destination_snapshot
        or contact.normalized_value <> recipient.normalized_destination_snapshot
        or contact.consent_status <> 'opted_in'
        or contact.contactability_status <> 'reachable'
      then now()
      else null
    end
  from public.campaign_recipients as recipient
  join public.people as person on person.id = recipient.person_id
  join public.person_contacts as contact
    on contact.id = recipient.contact_id
   and contact.person_id = recipient.person_id
  cross join lateral (
    select not exists (
      select 1
      from public.person_contacts as other_contact
      where other_contact.channel = recipient.channel
        and other_contact.normalized_value = recipient.normalized_destination_snapshot
        and other_contact.person_id <> recipient.person_id
    ) as destination_unique_owner
  ) as ownership
  where recipient.campaign_id = selected_campaign.id
  order by recipient.ordinal;

  get diagnostics inserted_count = row_count;
  if inserted_count <> selected_campaign.recipient_count then
    raise exception using errcode = 'P0001', message = 'campaign_outbox_materialization_mismatch';
  end if;

  update public.campaigns
  set status = 'queued',
      queued_at = now(),
      updated_at = now(),
      updated_by = trim(p_queued_by)
  where id = selected_campaign.id
    and status = 'previewed';

  if not found then
    raise exception using errcode = 'P0001', message = 'campaign_queue_race';
  end if;

  select count(*)
  into blocked_count
  from public.outbox_messages as message
  where message.campaign_id = selected_campaign.id
    and message.status = 'blocked';

  if blocked_count = inserted_count then
    update public.campaigns
    set status = case
          when selected_campaign.delivery_mode = 'dry_run' then 'dry_run_completed'
          else 'completed'
        end,
        completed_at = now(),
        updated_at = now(),
        updated_by = trim(p_queued_by)
    where campaigns.id = selected_campaign.id
      and campaigns.status = 'queued';
  end if;

  insert into public.outbound_audit_entries (
    idempotency_key,
    action,
    operator_identity,
    campaign_id,
    details
  )
  values (
    'campaign-queued:' || selected_campaign.id::text,
    'campaign_queued',
    trim(p_queued_by),
    selected_campaign.id,
    jsonb_build_object(
      'delivery_mode', selected_campaign.delivery_mode,
      'outbox_count', inserted_count,
      'blocked_count', blocked_count
    )
  );

  return jsonb_build_object(
    'status', 'queued',
    'campaign_id', selected_campaign.id,
    'outbox_count', inserted_count,
    'blocked_count', blocked_count
  );
end;
$$;

create or replace function public.claim_campaign_outbox(
  p_campaign_id uuid,
  p_worker_id text,
  p_limit integer default 50,
  p_now timestamptz default now()
)
returns table (
  id uuid,
  idempotency_key text,
  channel text,
  destination_snapshot text,
  subject_snapshot text,
  body_snapshot text,
  delivery_mode text,
  live_suppression_status text,
  live_identity_status text,
  live_consent_status text,
  live_contactability_status text,
  destination_current boolean,
  destination_unique_owner boolean,
  sending_time_zone text,
  sending_window_start_minute integer,
  sending_window_end_minute integer,
  allowed_weekdays smallint[],
  attempt_number integer
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  selected_campaign public.campaigns%rowtype;
begin
  if p_campaign_id is null then
    raise exception using errcode = 'P0001', message = 'missing_claim_campaign_id';
  end if;
  if p_worker_id is null or char_length(trim(p_worker_id)) not between 1 and 320 then
    raise exception using errcode = 'P0001', message = 'missing_outbox_worker_id';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception using errcode = 'P0001', message = 'invalid_outbox_claim_limit';
  end if;
  if p_now is null then
    raise exception using errcode = 'P0001', message = 'missing_outbox_claim_time';
  end if;

  select campaign.*
  into selected_campaign
  from public.campaigns as campaign
  where campaign.id = p_campaign_id
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'claim_campaign_not_found';
  end if;
  if selected_campaign.status not in ('queued', 'processing') then
    raise exception using errcode = 'P0001', message = 'campaign_not_dispatchable';
  end if;

  update public.outbox_messages as stale_message
  set status = 'retry_scheduled',
      available_at = least(stale_message.available_at, p_now),
      lease_owner = null,
      leased_at = null,
      last_result_code = 'lease_expired',
      updated_at = p_now
  where stale_message.campaign_id = selected_campaign.id
    and stale_message.status = 'claimed'
    and stale_message.leased_at < p_now - interval '15 minutes';

  update public.campaigns
  set status = 'processing',
      updated_at = p_now
  where campaigns.id = selected_campaign.id
    and campaigns.status = 'queued';

  return query
  with due_messages as (
    select message.id
    from public.outbox_messages as message
    where message.campaign_id = selected_campaign.id
      and message.status in ('pending', 'retry_scheduled')
      and message.available_at <= p_now
      and message.attempt_count < 5
    order by message.available_at, message.id
    limit p_limit
    for update skip locked
  ), claimed_messages as (
    update public.outbox_messages as message
    set status = 'claimed',
        lease_owner = trim(p_worker_id),
        leased_at = p_now,
        updated_at = p_now
    from due_messages
    where message.id = due_messages.id
    returning message.*
  )
  select
    claimed.id,
    claimed.idempotency_key,
    claimed.channel,
    claimed.destination_snapshot,
    claimed.subject_snapshot,
    claimed.body_snapshot,
    claimed.delivery_mode,
    person.suppression_status,
    person.identity_status,
    contact.consent_status,
    contact.contactability_status,
    contact.person_id = claimed.person_id
      and contact.channel = claimed.channel
      and contact.value = claimed.destination_snapshot
      and contact.normalized_value = claimed.normalized_destination_snapshot,
    not exists (
      select 1
      from public.person_contacts as other_contact
      where other_contact.channel = claimed.channel
        and other_contact.normalized_value = claimed.normalized_destination_snapshot
        and other_contact.person_id <> claimed.person_id
    ),
    selected_campaign.sending_time_zone,
    (
      extract(hour from selected_campaign.sending_window_start)::integer * 60
      + extract(minute from selected_campaign.sending_window_start)::integer
    ),
    (
      extract(hour from selected_campaign.sending_window_end)::integer * 60
      + extract(minute from selected_campaign.sending_window_end)::integer
    ),
    selected_campaign.allowed_weekdays,
    claimed.attempt_count + 1
  from claimed_messages as claimed
  join public.people as person on person.id = claimed.person_id
  join public.person_contacts as contact on contact.id = claimed.contact_id
  order by claimed.available_at, claimed.id;
end;
$$;

revoke execute on function public.reject_outbound_immutable_mutation()
  from public, anon, authenticated;
grant execute on function public.reject_outbound_immutable_mutation()
  to service_role;

revoke execute on function public.render_message_template_text(text, jsonb, text[])
  from public, anon, authenticated;
grant execute on function public.render_message_template_text(text, jsonb, text[])
  to service_role;

revoke execute on function public.create_message_template_version(uuid, text, text, text, text, text, text[], text)
  from public, anon, authenticated;
grant execute on function public.create_message_template_version(uuid, text, text, text, text, text, text[], text)
  to service_role;

revoke execute on function public.create_campaign_preview(
  uuid,
  uuid,
  uuid,
  text,
  text,
  timestamptz,
  time without time zone,
  time without time zone,
  smallint[],
  text
) from public, anon, authenticated;
grant execute on function public.create_campaign_preview(
  uuid,
  uuid,
  uuid,
  text,
  text,
  timestamptz,
  time without time zone,
  time without time zone,
  smallint[],
  text
) to service_role;

revoke execute on function public.queue_campaign_outbox(uuid, text)
  from public, anon, authenticated;
grant execute on function public.queue_campaign_outbox(uuid, text)
  to service_role;

revoke execute on function public.claim_campaign_outbox(uuid, text, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function public.claim_campaign_outbox(uuid, text, integer, timestamptz)
  to service_role;

create or replace function public.record_outbox_attempt(
  p_message_id uuid,
  p_worker_id text,
  p_outcome text,
  p_result_code text,
  p_available_at timestamptz,
  p_operator_identity text,
  p_completed_at timestamptz default now()
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  selected_message public.outbox_messages%rowtype;
  selected_campaign public.campaigns%rowtype;
  target_campaign_id uuid;
  next_attempt_number integer;
  recorded_outcome text;
  terminal_state boolean;
  remaining_count integer;
  failed_count integer;
  final_campaign_status text;
begin
  if p_message_id is null then
    raise exception using errcode = 'P0001', message = 'missing_outbox_message_id';
  end if;
  if p_worker_id is null or char_length(trim(p_worker_id)) not between 1 and 320 then
    raise exception using errcode = 'P0001', message = 'missing_outbox_result_worker';
  end if;
  if p_operator_identity is null or char_length(trim(p_operator_identity)) not between 1 and 320 then
    raise exception using errcode = 'P0001', message = 'missing_outbox_result_operator';
  end if;
  if p_outcome is null or p_outcome not in ('retry_scheduled', 'blocked', 'dry_run_completed', 'disabled') then
    raise exception using errcode = 'P0001', message = 'invalid_outbox_outcome';
  end if;
  if p_result_code is null
     or p_result_code !~ '^[a-z0-9_]+$'
     or char_length(p_result_code) > 120 then
    raise exception using errcode = 'P0001', message = 'invalid_outbox_result_code';
  end if;
  if p_completed_at is null then
    raise exception using errcode = 'P0001', message = 'missing_outbox_result_time';
  end if;

  select message.campaign_id
  into target_campaign_id
  from public.outbox_messages as message
  where message.id = p_message_id;

  if not found then
    raise exception using errcode = 'P0001', message = 'outbox_message_not_found';
  end if;

  select campaign.*
  into selected_campaign
  from public.campaigns as campaign
  where campaign.id = target_campaign_id
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'outbox_campaign_not_found';
  end if;

  select message.*
  into selected_message
  from public.outbox_messages as message
  where message.id = p_message_id
    and message.campaign_id = selected_campaign.id
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'outbox_message_campaign_changed';
  end if;

  if selected_message.status in ('blocked', 'dry_run_completed', 'disabled', 'failed', 'cancelled')
     and selected_message.last_result_code = p_result_code then
    return jsonb_build_object(
      'status', 'already_recorded',
      'message_id', selected_message.id,
      'outcome', selected_message.status,
      'attempt_number', selected_message.attempt_count
    );
  end if;

  if selected_message.status = 'retry_scheduled'
     and p_outcome = 'retry_scheduled'
     and selected_message.last_result_code = p_result_code
     and selected_message.available_at is not distinct from p_available_at then
    return jsonb_build_object(
      'status', 'already_recorded',
      'message_id', selected_message.id,
      'outcome', selected_message.status,
      'attempt_number', selected_message.attempt_count
    );
  end if;

  if selected_message.status <> 'claimed'
     or selected_message.lease_owner is distinct from trim(p_worker_id) then
    raise exception using errcode = 'P0001', message = 'outbox_message_not_owned';
  end if;

  if (selected_message.delivery_mode = 'dry_run' and p_outcome not in ('retry_scheduled', 'blocked', 'dry_run_completed'))
     or (selected_message.delivery_mode = 'disabled' and p_outcome not in ('retry_scheduled', 'blocked', 'disabled')) then
    raise exception using errcode = 'P0001', message = 'outbox_mode_outcome_mismatch';
  end if;

  next_attempt_number := selected_message.attempt_count + 1;
  if next_attempt_number > 5 then
    raise exception using errcode = 'P0001', message = 'outbox_attempt_limit_exceeded';
  end if;

  recorded_outcome := case
    when p_outcome = 'retry_scheduled' and next_attempt_number >= 5 then 'failed'
    else p_outcome
  end;
  terminal_state := recorded_outcome <> 'retry_scheduled';

  if recorded_outcome = 'retry_scheduled'
     and (p_available_at is null or p_available_at <= p_completed_at) then
    raise exception using errcode = 'P0001', message = 'invalid_outbox_retry_time';
  end if;

  insert into public.delivery_attempts (
    outbox_message_id,
    attempt_number,
    adapter,
    outcome,
    result_code,
    error_classification,
    provider_called,
    available_at,
    operator_identity,
    started_at,
    completed_at
  )
  values (
    selected_message.id,
    next_attempt_number,
    selected_message.delivery_mode,
    recorded_outcome,
    p_result_code,
    case
      when recorded_outcome = 'failed' then 'permanent'
      when recorded_outcome = 'blocked' then 'permanent'
      when recorded_outcome = 'retry_scheduled' and p_result_code <> 'outside_sending_window' then 'retryable'
      else null
    end,
    false,
    case when recorded_outcome = 'retry_scheduled' then p_available_at else null end,
    trim(p_operator_identity),
    selected_message.leased_at,
    p_completed_at
  );

  update public.outbox_messages
  set status = recorded_outcome,
      available_at = case
        when recorded_outcome = 'retry_scheduled' then p_available_at
        else selected_message.available_at
      end,
      attempt_count = next_attempt_number,
      lease_owner = null,
      leased_at = null,
      last_result_code = p_result_code,
      completed_at = case when terminal_state then p_completed_at else null end,
      updated_at = p_completed_at
  where outbox_messages.id = selected_message.id
    and outbox_messages.status = 'claimed'
    and outbox_messages.lease_owner = trim(p_worker_id);

  if not found then
    raise exception using errcode = 'P0001', message = 'outbox_result_race';
  end if;

  insert into public.outbound_audit_entries (
    idempotency_key,
    action,
    operator_identity,
    campaign_id,
    campaign_recipient_id,
    outbox_message_id,
    details
  )
  values (
    'outbox-attempt:' || selected_message.id::text || ':' || next_attempt_number::text,
    'outbox_attempt_recorded',
    trim(p_operator_identity),
    selected_message.campaign_id,
    selected_message.campaign_recipient_id,
    selected_message.id,
    jsonb_build_object(
      'attempt_number', next_attempt_number,
      'delivery_mode', selected_message.delivery_mode,
      'outcome', recorded_outcome,
      'provider_called', false,
      'result_code', p_result_code
    )
  );

  select
    count(*) filter (where message.status in ('pending', 'claimed', 'retry_scheduled')),
    count(*) filter (where message.status = 'failed')
  into remaining_count, failed_count
  from public.outbox_messages as message
  where message.campaign_id = selected_campaign.id;

  if remaining_count = 0 then
    final_campaign_status := case
      when failed_count > 0 then 'failed'
      when selected_campaign.delivery_mode = 'dry_run' then 'dry_run_completed'
      else 'completed'
    end;

    update public.campaigns
    set status = final_campaign_status,
        completed_at = p_completed_at,
        updated_at = p_completed_at,
        updated_by = trim(p_operator_identity)
    where campaigns.id = selected_campaign.id
      and campaigns.status in ('queued', 'processing');

    insert into public.outbound_audit_entries (
      idempotency_key,
      action,
      operator_identity,
      campaign_id,
      details
    )
    values (
      'campaign-completed:' || selected_campaign.id::text,
      'campaign_completed',
      trim(p_operator_identity),
      selected_campaign.id,
      jsonb_build_object(
        'delivery_mode', selected_campaign.delivery_mode,
        'failed_count', failed_count,
        'status', final_campaign_status
      )
    )
    on conflict (idempotency_key) do nothing;
  end if;

  return jsonb_build_object(
    'status', 'recorded',
    'message_id', selected_message.id,
    'outcome', recorded_outcome,
    'attempt_number', next_attempt_number
  );
end;
$$;

revoke execute on function public.record_outbox_attempt(uuid, text, text, text, timestamptz, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.record_outbox_attempt(uuid, text, text, text, timestamptz, text, timestamptz)
  to service_role;
