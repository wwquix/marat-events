alter table public.campaigns
  add constraint campaigns_id_event_id_unique unique (id, event_id);

alter table public.campaign_recipients
  add constraint campaign_recipients_id_campaign_id_unique unique (id, campaign_id);

create table public.campaign_invitation_tokens (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  campaign_id uuid not null,
  campaign_recipient_id uuid not null,
  event_id uuid not null,
  token_hash text not null unique
    check (token_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'active'
    check (status in ('active', 'revoked')),
  expires_at timestamptz not null,
  issued_by text not null
    check (char_length(trim(issued_by)) between 1 and 320),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by text
    check (revoked_by is null or char_length(trim(revoked_by)) between 1 and 320),
  revocation_reason text
    check (revocation_reason is null or char_length(trim(revocation_reason)) between 1 and 500),
  foreign key (campaign_id, event_id)
    references public.campaigns(id, event_id) on delete restrict,
  foreign key (campaign_recipient_id, campaign_id)
    references public.campaign_recipients(id, campaign_id) on delete restrict,
  unique (id, event_id, campaign_recipient_id),
  check (expires_at > created_at),
  check (
    (status = 'active' and revoked_at is null and revoked_by is null and revocation_reason is null)
    or (
      status = 'revoked'
      and revoked_at is not null
      and revoked_by is not null
      and revocation_reason is not null
    )
  )
);

create index campaign_invitation_tokens_recipient_status_idx
  on public.campaign_invitation_tokens(campaign_recipient_id, status, created_at desc);
create index campaign_invitation_tokens_campaign_created_idx
  on public.campaign_invitation_tokens(campaign_id, created_at desc, id);
create index campaign_invitation_tokens_active_expiry_idx
  on public.campaign_invitation_tokens(expires_at, id)
  where status = 'active';

alter table public.registrations
  add column campaign_recipient_id uuid,
  add column invitation_token_id uuid,
  add constraint registrations_invitation_attribution_complete_check
    check (
      (campaign_recipient_id is null and invitation_token_id is null)
      or (
        campaign_recipient_id is not null
        and invitation_token_id is not null
        and source = 'campaign_invite'
      )
    ),
  add constraint registrations_invitation_attribution_fkey
    foreign key (invitation_token_id, event_id, campaign_recipient_id)
    references public.campaign_invitation_tokens(id, event_id, campaign_recipient_id)
    on delete restrict;

create index registrations_campaign_recipient_created_idx
  on public.registrations(campaign_recipient_id, created_at desc, id)
  where campaign_recipient_id is not null;
create index registrations_invitation_attribution_idx
  on public.registrations(invitation_token_id, event_id, campaign_recipient_id)
  where invitation_token_id is not null;

alter table public.campaign_invitation_tokens enable row level security;
alter table public.campaign_invitation_tokens force row level security;

revoke all on table public.campaign_invitation_tokens from public, anon, authenticated;
grant select, insert, update on table public.campaign_invitation_tokens to service_role;

create or replace function public.enforce_campaign_invitation_token_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = 'P0001', message = 'campaign_invitation_token_immutable';
  end if;

  if new.id is distinct from old.id
     or new.request_id is distinct from old.request_id
     or new.campaign_id is distinct from old.campaign_id
     or new.campaign_recipient_id is distinct from old.campaign_recipient_id
     or new.event_id is distinct from old.event_id
     or new.token_hash is distinct from old.token_hash
     or new.expires_at is distinct from old.expires_at
     or new.issued_by is distinct from old.issued_by
     or new.created_at is distinct from old.created_at then
    raise exception using errcode = 'P0001', message = 'campaign_invitation_token_identity_immutable';
  end if;

  if old.status = 'revoked' then
    if new is distinct from old then
      raise exception using errcode = 'P0001', message = 'campaign_invitation_token_already_revoked';
    end if;
    return new;
  end if;

  if new.status <> 'revoked'
     or new.revoked_at is null
     or new.revoked_by is null
     or new.revocation_reason is null then
    raise exception using errcode = 'P0001', message = 'invalid_campaign_invitation_revocation';
  end if;

  return new;
end;
$$;

create trigger campaign_invitation_tokens_mutation_guard
before update or delete on public.campaign_invitation_tokens
for each row execute function public.enforce_campaign_invitation_token_mutation();

create or replace function public.enforce_registration_invitation_attribution()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  attribution_is_current boolean;
begin
  if new.invitation_token_id is null and new.campaign_recipient_id is null then
    return new;
  end if;

  select true
    into attribution_is_current
    from public.campaign_invitation_tokens as invitation
    join public.campaign_recipients as recipient
      on recipient.id = invitation.campaign_recipient_id
     and recipient.campaign_id = invitation.campaign_id
    join public.campaigns as campaign
      on campaign.id = invitation.campaign_id
     and campaign.event_id = invitation.event_id
    where invitation.id = new.invitation_token_id
      and invitation.event_id = new.event_id
      and invitation.campaign_recipient_id = new.campaign_recipient_id
      and recipient.person_id = new.person_id
      and invitation.status = 'active'
      and invitation.revoked_at is null
      and invitation.expires_at > pg_catalog.statement_timestamp()
      and recipient.eligibility = 'eligible'
      and recipient.policy_reason = 'allowed'
      and campaign.status not in ('cancelled', 'failed')
    for share of invitation, recipient, campaign;

  if not coalesce(attribution_is_current, false) then
    raise exception using errcode = 'P0001', message = 'invalid_campaign_invitation_attribution';
  end if;

  return new;
end;
$$;

create trigger registrations_invitation_attribution_insert_guard
before insert on public.registrations
for each row execute function public.enforce_registration_invitation_attribution();

create trigger registrations_invitation_attribution_update_guard
before update of event_id, person_id, campaign_recipient_id, invitation_token_id, source
on public.registrations
for each row execute function public.enforce_registration_invitation_attribution();

create or replace function public.issue_campaign_invitation_token(
  p_request_id uuid,
  p_campaign_recipient_id uuid,
  p_token_hash text,
  p_expires_at timestamptz,
  p_issued_by text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  existing_invitation public.campaign_invitation_tokens%rowtype;
  selected_campaign public.campaigns%rowtype;
  selected_recipient public.campaign_recipients%rowtype;
  selected_event public.events%rowtype;
  selected_person public.people%rowtype;
  selected_contact public.person_contacts%rowtype;
  invitation_id uuid;
begin
  if p_request_id is null then
    raise exception using errcode = 'P0001', message = 'missing_invitation_request_id';
  end if;

  if p_campaign_recipient_id is null then
    raise exception using errcode = 'P0001', message = 'missing_campaign_recipient';
  end if;

  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'P0001', message = 'invalid_invitation_token_hash';
  end if;

  if p_issued_by is null or char_length(trim(p_issued_by)) not between 1 and 320 then
    raise exception using errcode = 'P0001', message = 'invalid_invitation_issuer';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'marat_campaign_invitation_request:' || p_request_id::text,
      0
    )
  );

  select invitation.*
    into existing_invitation
    from public.campaign_invitation_tokens as invitation
    where invitation.request_id = p_request_id
    for share;

  if found then
    if existing_invitation.campaign_recipient_id is distinct from p_campaign_recipient_id
       or existing_invitation.token_hash is distinct from p_token_hash
       or existing_invitation.expires_at is distinct from p_expires_at
       or existing_invitation.issued_by is distinct from trim(p_issued_by) then
      raise exception using errcode = 'P0001', message = 'invitation_request_conflict';
    end if;

    if existing_invitation.status <> 'active' then
      raise exception using errcode = 'P0001', message = 'invitation_request_already_revoked';
    end if;
  end if;

  select recipient.*
    into selected_recipient
    from public.campaign_recipients as recipient
    where recipient.id = p_campaign_recipient_id;

  if not found then
    raise exception using errcode = 'P0001', message = 'campaign_recipient_not_found';
  end if;

  select campaign.*
    into selected_campaign
    from public.campaigns as campaign
    where campaign.id = selected_recipient.campaign_id
    for share;

  if not found then
    raise exception using errcode = 'P0001', message = 'campaign_not_found';
  end if;

  select event.*
    into selected_event
    from public.events as event
    where event.id = selected_campaign.event_id
    for share;

  if not found then
    raise exception using errcode = 'P0001', message = 'campaign_event_not_found';
  end if;

  select recipient.*
    into selected_recipient
    from public.campaign_recipients as recipient
    where recipient.id = p_campaign_recipient_id
      and recipient.campaign_id = selected_campaign.id
    for share;

  if not found
     or selected_recipient.eligibility <> 'eligible'
     or selected_recipient.policy_reason <> 'allowed' then
    raise exception using errcode = 'P0001', message = 'campaign_recipient_not_invitable';
  end if;

  select person.*
    into selected_person
    from public.people as person
    where person.id = selected_recipient.person_id
    for share;

  if not found
     or selected_person.suppression_status <> 'active'
     or selected_person.identity_status <> 'resolved' then
    raise exception using errcode = 'P0001', message = 'campaign_recipient_not_invitable';
  end if;

  select contact.*
    into selected_contact
    from public.person_contacts as contact
    where contact.id = selected_recipient.contact_id
      and contact.person_id = selected_recipient.person_id
    for share;

  if not found
     or selected_contact.channel <> selected_recipient.channel
     or selected_contact.value <> selected_recipient.destination_snapshot
     or selected_contact.normalized_value <> selected_recipient.normalized_destination_snapshot
     or selected_contact.consent_status <> 'opted_in'
     or selected_contact.contactability_status <> 'reachable' then
    raise exception using errcode = 'P0001', message = 'campaign_recipient_not_invitable';
  end if;

  if exists (
    select 1
    from public.person_contacts as other_contact
    where other_contact.channel = selected_contact.channel
      and other_contact.normalized_value = selected_contact.normalized_value
      and other_contact.person_id <> selected_contact.person_id
  ) then
    raise exception using errcode = 'P0001', message = 'campaign_recipient_destination_ambiguous';
  end if;

  if selected_campaign.status in ('cancelled', 'failed') then
    raise exception using errcode = 'P0001', message = 'campaign_not_invitable';
  end if;

  if selected_event.status <> 'published'
     or selected_event.starts_at <= pg_catalog.statement_timestamp() then
    raise exception using errcode = 'P0001', message = 'campaign_event_not_invitable';
  end if;

  if p_expires_at is null
     or p_expires_at <= pg_catalog.statement_timestamp()
     or p_expires_at > selected_event.starts_at
     or p_expires_at > pg_catalog.statement_timestamp() + interval '180 days' then
    raise exception using errcode = 'P0001', message = 'invalid_invitation_expiry';
  end if;

  if existing_invitation.id is not null then
    return pg_catalog.jsonb_build_object(
      'status', 'already_issued',
      'token_id', existing_invitation.id,
      'campaign_id', existing_invitation.campaign_id,
      'campaign_recipient_id', existing_invitation.campaign_recipient_id,
      'event_id', existing_invitation.event_id,
      'expires_at', existing_invitation.expires_at
    );
  end if;

  insert into public.campaign_invitation_tokens (
    request_id,
    campaign_id,
    campaign_recipient_id,
    event_id,
    token_hash,
    expires_at,
    issued_by
  )
  values (
    p_request_id,
    selected_campaign.id,
    selected_recipient.id,
    selected_event.id,
    p_token_hash,
    p_expires_at,
    trim(p_issued_by)
  )
  returning id into invitation_id;

  insert into public.outbound_audit_entries (
    idempotency_key,
    action,
    operator_identity,
    campaign_id,
    campaign_recipient_id,
    details
  )
  values (
    'campaign-invitation-issued:' || invitation_id::text,
    'campaign_invitation_issued',
    trim(p_issued_by),
    selected_campaign.id,
    selected_recipient.id,
    pg_catalog.jsonb_build_object(
      'token_id', invitation_id,
      'event_id', selected_event.id,
      'expires_at', p_expires_at
    )
  );

  return pg_catalog.jsonb_build_object(
    'status', 'issued',
    'token_id', invitation_id,
    'campaign_id', selected_campaign.id,
    'campaign_recipient_id', selected_recipient.id,
    'event_id', selected_event.id,
    'expires_at', p_expires_at
  );
end;
$$;

create or replace function public.revoke_campaign_invitation_token(
  p_token_id uuid,
  p_revoked_by text,
  p_reason text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  selected_invitation public.campaign_invitation_tokens%rowtype;
  revoked_timestamp timestamptz := pg_catalog.statement_timestamp();
begin
  if p_token_id is null then
    raise exception using errcode = 'P0001', message = 'missing_invitation_token_id';
  end if;

  if p_revoked_by is null or char_length(trim(p_revoked_by)) not between 1 and 320 then
    raise exception using errcode = 'P0001', message = 'invalid_invitation_revoker';
  end if;

  if p_reason is null or char_length(trim(p_reason)) not between 1 and 500 then
    raise exception using errcode = 'P0001', message = 'invalid_invitation_revocation_reason';
  end if;

  select invitation.*
    into selected_invitation
    from public.campaign_invitation_tokens as invitation
    where invitation.id = p_token_id
    for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'campaign_invitation_token_not_found';
  end if;

  if selected_invitation.status = 'revoked' then
    return pg_catalog.jsonb_build_object(
      'status', 'already_revoked',
      'token_id', selected_invitation.id
    );
  end if;

  update public.campaign_invitation_tokens
  set status = 'revoked',
      revoked_at = revoked_timestamp,
      revoked_by = trim(p_revoked_by),
      revocation_reason = trim(p_reason)
  where id = selected_invitation.id
    and status = 'active';

  if not found then
    raise exception using errcode = 'P0001', message = 'campaign_invitation_revocation_race';
  end if;

  insert into public.outbound_audit_entries (
    idempotency_key,
    action,
    operator_identity,
    campaign_id,
    campaign_recipient_id,
    details
  )
  values (
    'campaign-invitation-revoked:' || selected_invitation.id::text,
    'campaign_invitation_revoked',
    trim(p_revoked_by),
    selected_invitation.campaign_id,
    selected_invitation.campaign_recipient_id,
    pg_catalog.jsonb_build_object(
      'token_id', selected_invitation.id,
      'event_id', selected_invitation.event_id,
      'reason', trim(p_reason)
    )
  );

  return pg_catalog.jsonb_build_object(
    'status', 'revoked',
    'token_id', selected_invitation.id
  );
end;
$$;

create or replace function public.create_pending_registration_with_invitation(
  p_event_id uuid,
  p_person_id uuid,
  p_ticket_type_id uuid,
  p_full_name text,
  p_email text,
  p_phone text,
  p_age integer,
  p_gender text,
  p_amount_cents integer,
  p_currency text,
  p_invitation_token_hash text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  selected_invitation public.campaign_invitation_tokens%rowtype;
  registration_id uuid;
begin
  if p_invitation_token_hash is not null
     and p_invitation_token_hash ~ '^[0-9a-f]{64}$' then
    select invitation.*
      into selected_invitation
      from public.campaign_invitation_tokens as invitation
      join public.campaign_recipients as recipient
        on recipient.id = invitation.campaign_recipient_id
       and recipient.campaign_id = invitation.campaign_id
      join public.campaigns as campaign
        on campaign.id = invitation.campaign_id
       and campaign.event_id = invitation.event_id
      where invitation.token_hash = p_invitation_token_hash
        and invitation.event_id = p_event_id
        and recipient.person_id = p_person_id
        and invitation.status = 'active'
        and invitation.revoked_at is null
        and invitation.expires_at > pg_catalog.statement_timestamp()
        and recipient.eligibility = 'eligible'
        and recipient.policy_reason = 'allowed'
        and campaign.status not in ('cancelled', 'failed')
      for share of invitation, recipient, campaign;
  end if;

  insert into public.registrations (
    event_id,
    person_id,
    ticket_type_id,
    full_name,
    email,
    phone,
    age,
    gender,
    source,
    amount_cents,
    currency,
    payment_status,
    campaign_recipient_id,
    invitation_token_id
  )
  values (
    p_event_id,
    p_person_id,
    p_ticket_type_id,
    p_full_name,
    p_email,
    p_phone,
    p_age,
    p_gender,
    case when selected_invitation.id is null then 'event_page' else 'campaign_invite' end,
    p_amount_cents,
    p_currency,
    'pending',
    selected_invitation.campaign_recipient_id,
    selected_invitation.id
  )
  returning id into registration_id;

  if selected_invitation.id is not null then
    insert into public.outbound_audit_entries (
      idempotency_key,
      action,
      operator_identity,
      campaign_id,
      campaign_recipient_id,
      details
    )
    values (
      'campaign-invitation-attributed:' || registration_id::text,
      'campaign_invitation_attributed',
      'system:public-checkout',
      selected_invitation.campaign_id,
      selected_invitation.campaign_recipient_id,
      pg_catalog.jsonb_build_object(
        'registration_id', registration_id,
        'token_id', selected_invitation.id,
        'event_id', selected_invitation.event_id
      )
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'registration_id', registration_id,
    'attributed', selected_invitation.id is not null,
    'campaign_recipient_id', selected_invitation.campaign_recipient_id
  );
end;
$$;

revoke all on function public.enforce_campaign_invitation_token_mutation()
  from public, anon, authenticated;
revoke all on function public.enforce_registration_invitation_attribution()
  from public, anon, authenticated;
revoke all on function public.issue_campaign_invitation_token(uuid, uuid, text, timestamptz, text)
  from public, anon, authenticated;
revoke all on function public.revoke_campaign_invitation_token(uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.create_pending_registration_with_invitation(
  uuid, uuid, uuid, text, text, text, integer, text, integer, text, text
)
  from public, anon, authenticated;

grant execute on function public.issue_campaign_invitation_token(uuid, uuid, text, timestamptz, text)
  to service_role;
grant execute on function public.revoke_campaign_invitation_token(uuid, text, text)
  to service_role;
grant execute on function public.create_pending_registration_with_invitation(
  uuid, uuid, uuid, text, text, text, integer, text, integer, text, text
)
  to service_role;
