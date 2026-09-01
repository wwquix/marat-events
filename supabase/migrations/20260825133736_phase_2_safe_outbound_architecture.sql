-- Phase 2.4: provider-independent outbound safety foundation. No provider is wired here.
alter table public.invitation_campaign_results
  add constraint invitation_campaign_results_id_campaign_event_person_contact_unique
  unique (id, campaign_id, event_id, person_id, person_contact_id),
  add constraint invitation_campaign_results_id_campaign_event_person_unique
  unique (id, campaign_id, event_id, person_id);

create table public.outbound_messages (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete restrict,
  campaign_id uuid not null,
  invitation_campaign_result_id uuid not null,
  person_id uuid not null references public.people(id) on delete restrict,
  person_contact_id uuid references public.person_contacts(id) on delete restrict,
  channel text not null check (channel in ('email', 'phone', 'sms', 'instagram', 'linkedin', 'whatsapp', 'telegram', 'other')),
  purpose text not null check (purpose = 'invitation'),
  status text not null check (status in ('ready', 'scheduled', 'processing', 'sent', 'retryable_failed', 'permanent_failed', 'blocked', 'cancelled')),
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 300),
  available_at timestamptz not null,
  scheduled_at timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 3 check (max_attempts between 1 and 10),
  last_attempt_at timestamptz,
  claim_token uuid,
  claimed_by text,
  lease_expires_at timestamptz,
  provider text,
  provider_message_id text,
  last_error_code text,
  last_error_message text,
  sent_at timestamptz,
  cancelled_at timestamptz,
  terminal_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (invitation_campaign_result_id, campaign_id, event_id, person_id, person_contact_id)
    references public.invitation_campaign_results(id, campaign_id, event_id, person_id, person_contact_id) on delete restrict,
  foreign key (invitation_campaign_result_id, campaign_id, event_id, person_id)
    references public.invitation_campaign_results(id, campaign_id, event_id, person_id) on delete restrict,
  unique (idempotency_key),
  unique (id, event_id, campaign_id),
  check ((status = 'processing') = (claim_token is not null and claimed_by is not null and lease_expires_at is not null)),
  check (sent_at is null or status = 'sent'),
  check (cancelled_at is null or status = 'cancelled'),
  check ((status in ('sent', 'permanent_failed', 'blocked', 'cancelled')) = (terminal_at is not null)),
  check (last_error_code is null or last_error_code in ('provider_timeout', 'provider_unavailable', 'provider_rejected', 'internal_error', 'lease_expired')),
  check (last_error_message is null or char_length(last_error_message) <= 300)
);

create index outbound_messages_claim_idx on public.outbound_messages(status, available_at, id)
  where status in ('ready', 'scheduled', 'retryable_failed', 'processing');
create index outbound_messages_campaign_idx on public.outbound_messages(campaign_id, created_at desc);

create table public.outbound_dry_runs (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete restrict,
  campaign_id uuid not null,
  requested_by text not null check (char_length(trim(requested_by)) between 1 and 254),
  requested_at timestamptz not null default now(),
  total_count integer not null default 0 check (total_count >= 0),
  allowed_count integer not null default 0 check (allowed_count >= 0),
  blocked_count integer not null default 0 check (blocked_count >= 0),
  delayed_count integer not null default 0 check (delayed_count >= 0),
  already_queued_count integer not null default 0 check (already_queued_count >= 0),
  foreign key (campaign_id, event_id) references public.invitation_campaigns(id, event_id) on delete restrict,
  unique (id, event_id, campaign_id),
  check (allowed_count + blocked_count + delayed_count = total_count)
);

create table public.outbound_dry_run_results (
  id uuid primary key default gen_random_uuid(),
  dry_run_id uuid not null references public.outbound_dry_runs(id) on delete restrict,
  event_id uuid not null,
  campaign_id uuid not null,
  invitation_campaign_result_id uuid not null,
  person_id uuid not null references public.people(id) on delete restrict,
  person_contact_id uuid references public.person_contacts(id) on delete restrict,
  channel text not null check (channel in ('email', 'phone', 'sms', 'instagram', 'linkedin', 'whatsapp', 'telegram', 'other')),
  decision text not null check (decision in ('allowed', 'blocked', 'delayed')),
  decision_code text not null check (char_length(decision_code) between 1 and 100),
  decision_reason text not null check (char_length(decision_reason) between 1 and 300),
  next_available_at timestamptz,
  already_queued boolean not null default false,
  created_at timestamptz not null default now(),
  foreign key (dry_run_id, event_id, campaign_id) references public.outbound_dry_runs(id, event_id, campaign_id) on delete restrict,
  foreign key (invitation_campaign_result_id, campaign_id, event_id, person_id, person_contact_id)
    references public.invitation_campaign_results(id, campaign_id, event_id, person_id, person_contact_id) on delete restrict,
  foreign key (invitation_campaign_result_id, campaign_id, event_id, person_id)
    references public.invitation_campaign_results(id, campaign_id, event_id, person_id) on delete restrict,
  unique (dry_run_id, invitation_campaign_result_id)
);
create index outbound_dry_run_results_run_idx on public.outbound_dry_run_results(dry_run_id, decision, id);

create table public.outbound_audit_log (
  id bigint generated always as identity primary key,
  event_id uuid not null references public.events(id) on delete restrict,
  campaign_id uuid not null,
  outbound_message_id uuid,
  dry_run_id uuid,
  action text not null check (action in ('dry_run_evaluated', 'enqueued', 'scheduled', 'claimed', 'lease_recovered', 'blocked', 'retry_scheduled', 'permanent_failed', 'cancelled', 'sent')),
  actor_type text not null check (actor_type in ('admin', 'service')),
  actor_id text not null check (char_length(trim(actor_id)) between 1 and 254),
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object' and pg_column_size(details) <= 4096),
  created_at timestamptz not null default now(),
  foreign key (campaign_id, event_id) references public.invitation_campaigns(id, event_id) on delete restrict,
  foreign key (outbound_message_id, event_id, campaign_id) references public.outbound_messages(id, event_id, campaign_id) on delete restrict,
  foreign key (dry_run_id, event_id, campaign_id) references public.outbound_dry_runs(id, event_id, campaign_id) on delete restrict,
  check (outbound_message_id is not null or dry_run_id is not null)
);
create index outbound_audit_log_message_idx on public.outbound_audit_log(outbound_message_id, created_at desc);
create index outbound_audit_log_dry_run_idx on public.outbound_audit_log(dry_run_id, created_at desc);

create function public.outbound_audit_log_append_only()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  raise exception using errcode = 'P0001', message = 'outbound_audit_log_append_only';
end;
$$;
create trigger outbound_audit_log_append_only before update or delete on public.outbound_audit_log for each row execute function public.outbound_audit_log_append_only();

create function public.next_outbound_send_time(p_at timestamptz)
returns timestamptz language plpgsql stable security invoker set search_path = '' as $$
declare
  local_time timestamp;
  candidate_date date;
begin
  if p_at is null then raise exception using errcode = 'P0001', message = 'missing_outbound_time'; end if;
  local_time := p_at at time zone 'America/New_York';
  candidate_date := local_time::date;
  if extract(isodow from local_time) between 1 and 5 and local_time::time >= time '09:00' and local_time::time < time '18:00' then
    return p_at;
  end if;
  if extract(isodow from local_time) between 1 and 5 and local_time::time < time '09:00' then
    return (candidate_date + time '09:00') at time zone 'America/New_York';
  end if;
  candidate_date := candidate_date + 1;
  while extract(isodow from candidate_date) not between 1 and 5 loop candidate_date := candidate_date + 1; end loop;
  return (candidate_date + time '09:00') at time zone 'America/New_York';
end;
$$;

create function public.evaluate_outbound_policy(p_invitation_campaign_result_id uuid, p_at timestamptz default now())
returns table (event_id uuid, campaign_id uuid, invitation_campaign_result_id uuid, person_id uuid, person_contact_id uuid, channel text, decision text, decision_code text, decision_reason text, next_available_at timestamptz)
language plpgsql stable security invoker set search_path = '' as $$
declare r record; next_time timestamptz;
begin
  select result.event_id, result.campaign_id, result.id, result.person_id, result.person_contact_id, campaign.target_channel,
         result.eligibility_status, person.suppression_status, person.identity_status, contact.consent_status, contact.contactability_status
    into r
    from public.invitation_campaign_results result
    join public.invitation_campaigns campaign on campaign.id = result.campaign_id and campaign.event_id = result.event_id
    join public.people person on person.id = result.person_id
    left join public.person_contacts contact on contact.id = result.person_contact_id and contact.person_id = result.person_id and contact.channel = campaign.target_channel
   where result.id = p_invitation_campaign_result_id;
  if not found then raise exception using errcode = 'P0001', message = 'campaign_result_not_found'; end if;
  event_id := r.event_id; campaign_id := r.campaign_id; invitation_campaign_result_id := r.id; person_id := r.person_id; person_contact_id := r.person_contact_id; channel := r.target_channel;
  if r.eligibility_status <> 'eligible' then decision := 'blocked'; decision_code := 'campaign_result_ineligible'; decision_reason := 'Campaign result is not eligible.';
  elsif r.suppression_status = 'suppressed' then decision := 'blocked'; decision_code := 'person_suppressed'; decision_reason := 'Person is suppressed.';
  elsif r.identity_status = 'review_required' then decision := 'blocked'; decision_code := 'identity_review_required'; decision_reason := 'Identity requires human review.';
  elsif r.person_contact_id is null or r.consent_status is distinct from 'opted_in' then decision := 'blocked'; decision_code := 'channel_not_opted_in'; decision_reason := 'Selected contact is not explicitly opted in.';
  elsif r.contactability_status is distinct from 'reachable' then decision := 'blocked'; decision_code := 'channel_not_reachable'; decision_reason := 'Selected contact is not reachable.';
  else
    next_time := public.next_outbound_send_time(p_at);
    next_available_at := next_time;
    if next_time = p_at then decision := 'allowed'; decision_code := 'within_business_window'; decision_reason := 'Within the America/New_York business window.';
    else decision := 'delayed'; decision_code := 'outside_business_window'; decision_reason := 'Scheduled for the next America/New_York business window.'; end if;
  end if;
  return next;
end;
$$;

create function public.outbound_message_transition_guard()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if old.status in ('sent', 'permanent_failed', 'blocked', 'cancelled') and new.status <> old.status then raise exception using errcode = 'P0001', message = 'outbound_terminal_transition_denied'; end if;
  if old.status <> 'processing' and new.status in ('sent', 'retryable_failed', 'permanent_failed') then raise exception using errcode = 'P0001', message = 'outbound_processing_transition_required'; end if;
  if new.status = 'processing' and (new.claim_token is null or new.claimed_by is null or new.lease_expires_at is null) then raise exception using errcode = 'P0001', message = 'outbound_claim_required'; end if;
  if new.status <> 'processing' then new.claim_token := null; new.claimed_by := null; new.lease_expires_at := null; end if;
  if new.status in ('sent', 'permanent_failed', 'blocked', 'cancelled') and new.terminal_at is null then new.terminal_at := now(); end if;
  new.updated_at := now(); return new;
end;
$$;
create trigger outbound_messages_transition_guard before update on public.outbound_messages for each row execute function public.outbound_message_transition_guard();

create function public.create_outbound_dry_run(p_campaign_id uuid, p_requested_by text, p_at timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare run public.outbound_dry_runs%rowtype; policy record;
begin
  if p_requested_by is null or char_length(trim(p_requested_by)) = 0 then raise exception using errcode = 'P0001', message = 'missing_admin_identity'; end if;
  insert into public.outbound_dry_runs(event_id, campaign_id, requested_by)
  select event_id, id, trim(p_requested_by) from public.invitation_campaigns where id = p_campaign_id returning * into run;
  if not found then raise exception using errcode = 'P0001', message = 'campaign_not_found'; end if;
  for policy in
    select evaluation.*
    from public.invitation_campaign_results result
    cross join lateral public.evaluate_outbound_policy(result.id, p_at) evaluation
    where result.campaign_id = p_campaign_id
  loop
    insert into public.outbound_dry_run_results(dry_run_id,event_id,campaign_id,invitation_campaign_result_id,person_id,person_contact_id,channel,decision,decision_code,decision_reason,next_available_at,already_queued)
    values(run.id,policy.event_id,policy.campaign_id,policy.invitation_campaign_result_id,policy.person_id,policy.person_contact_id,policy.channel,policy.decision,policy.decision_code,policy.decision_reason,policy.next_available_at,exists(select 1 from public.outbound_messages m where m.idempotency_key = 'invite:v1:' || policy.campaign_id::text || ':' || policy.invitation_campaign_result_id::text));
  end loop;
  update public.outbound_dry_runs set total_count = (select count(*) from public.outbound_dry_run_results where dry_run_id=run.id), allowed_count=(select count(*) from public.outbound_dry_run_results where dry_run_id=run.id and decision='allowed'), blocked_count=(select count(*) from public.outbound_dry_run_results where dry_run_id=run.id and decision='blocked'), delayed_count=(select count(*) from public.outbound_dry_run_results where dry_run_id=run.id and decision='delayed'), already_queued_count=(select count(*) from public.outbound_dry_run_results where dry_run_id=run.id and already_queued) where id=run.id returning * into run;
  insert into public.outbound_audit_log(event_id,campaign_id,dry_run_id,action,actor_type,actor_id,details) values(run.event_id,run.campaign_id,run.id,'dry_run_evaluated','admin',trim(p_requested_by),jsonb_build_object('total',run.total_count,'allowed',run.allowed_count,'blocked',run.blocked_count,'delayed',run.delayed_count));
  return jsonb_build_object('dry_run_id',run.id,'total_count',run.total_count,'allowed_count',run.allowed_count,'blocked_count',run.blocked_count,'delayed_count',run.delayed_count,'already_queued_count',run.already_queued_count);
end;
$$;

create function public.enqueue_invitation_campaign(p_campaign_id uuid, p_requested_by text, p_at timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare policy record; message public.outbound_messages%rowtype; total_count integer := 0; created_count integer := 0;
begin
  if p_requested_by is null or char_length(trim(p_requested_by)) = 0 then raise exception using errcode = 'P0001', message = 'missing_admin_identity'; end if;
  if not exists (select 1 from public.invitation_campaigns where id = p_campaign_id) then raise exception using errcode = 'P0001', message = 'campaign_not_found'; end if;
  for policy in
    select evaluation.*
    from public.invitation_campaign_results result
    cross join lateral public.evaluate_outbound_policy(result.id, p_at) evaluation
    where result.campaign_id = p_campaign_id
  loop
    total_count := total_count + 1;
    insert into public.outbound_messages(event_id,campaign_id,invitation_campaign_result_id,person_id,person_contact_id,channel,purpose,status,idempotency_key,available_at,scheduled_at,terminal_at)
    values(policy.event_id,policy.campaign_id,policy.invitation_campaign_result_id,policy.person_id,policy.person_contact_id,policy.channel,'invitation',case when policy.decision='blocked' then 'blocked' when policy.decision='delayed' then 'scheduled' else 'ready' end,'invite:v1:' || policy.campaign_id::text || ':' || policy.invitation_campaign_result_id::text,coalesce(policy.next_available_at,p_at),case when policy.decision='delayed' then policy.next_available_at end,case when policy.decision='blocked' then p_at end)
    on conflict (idempotency_key) do nothing returning * into message;
    if found then
      created_count := created_count + 1;
      insert into public.outbound_audit_log(event_id,campaign_id,outbound_message_id,action,actor_type,actor_id,details)
      values(message.event_id,message.campaign_id,message.id,case when message.status='blocked' then 'blocked' when message.status='scheduled' then 'scheduled' else 'enqueued' end,'admin',trim(p_requested_by),jsonb_build_object('decision',policy.decision,'code',policy.decision_code));
    end if;
  end loop;
  return jsonb_build_object('campaign_id',p_campaign_id,'target_count',total_count,'created_count',created_count,'existing_count',total_count-created_count);
end;
$$;

create function public.claim_outbound_messages(p_worker_id text, p_limit integer default 10, p_lease_seconds integer default 300, p_at timestamptz default now())
returns setof public.outbound_messages language plpgsql security definer set search_path = '' as $$
declare candidate public.outbound_messages%rowtype; policy record; claimed public.outbound_messages%rowtype;
begin
  if p_worker_id is null or char_length(trim(p_worker_id)) = 0 or p_limit not between 1 and 100 or p_lease_seconds not between 30 and 3600 then raise exception using errcode = 'P0001', message = 'invalid_claim_arguments'; end if;
  for candidate in select * from public.outbound_messages where status='processing' and lease_expires_at <= p_at for update loop
    update public.outbound_messages
    set status=case when attempts >= max_attempts then 'permanent_failed' else 'retryable_failed' end,
        available_at=p_at,
        last_error_code='lease_expired',
        last_error_message='Processing lease expired.'
    where id=candidate.id;
    insert into public.outbound_audit_log(event_id,campaign_id,outbound_message_id,action,actor_type,actor_id,details)
    values(candidate.event_id,candidate.campaign_id,candidate.id,case when candidate.attempts >= candidate.max_attempts then 'permanent_failed' else 'lease_recovered' end,'service',trim(p_worker_id),jsonb_build_object('previous_worker',candidate.claimed_by,'attempt',candidate.attempts));
  end loop;
  for candidate in select * from public.outbound_messages where status in ('ready','scheduled','retryable_failed') and available_at <= p_at order by available_at,id for update skip locked limit p_limit loop
    select * into policy from public.evaluate_outbound_policy(candidate.invitation_campaign_result_id,p_at);
    if policy.decision='blocked' then update public.outbound_messages set status='blocked',last_error_code=null,last_error_message=null where id=candidate.id; insert into public.outbound_audit_log(event_id,campaign_id,outbound_message_id,action,actor_type,actor_id,details) values(candidate.event_id,candidate.campaign_id,candidate.id,'blocked','service',trim(p_worker_id),jsonb_build_object('code',policy.decision_code)); continue; end if;
    if policy.decision='delayed' then
      update public.outbound_messages set status='scheduled',available_at=policy.next_available_at,scheduled_at=policy.next_available_at where id=candidate.id;
      insert into public.outbound_audit_log(event_id,campaign_id,outbound_message_id,action,actor_type,actor_id,details) values(candidate.event_id,candidate.campaign_id,candidate.id,'scheduled','service',trim(p_worker_id),jsonb_build_object('code',policy.decision_code));
      continue;
    end if;
    update public.outbound_messages set status='processing',attempts=attempts+1,last_attempt_at=p_at,claim_token=pg_catalog.gen_random_uuid(),claimed_by=trim(p_worker_id),lease_expires_at=p_at + make_interval(secs=>p_lease_seconds) where id=candidate.id returning * into claimed;
    insert into public.outbound_audit_log(event_id,campaign_id,outbound_message_id,action,actor_type,actor_id,details) values(claimed.event_id,claimed.campaign_id,claimed.id,'claimed','service',trim(p_worker_id),jsonb_build_object('attempt',claimed.attempts)); return next claimed;
  end loop;
end;
$$;

create function public.report_outbound_failure(p_message_id uuid, p_claim_token uuid, p_error_code text, p_error_message text, p_retryable boolean, p_at timestamptz default now())
returns public.outbound_messages language plpgsql security definer set search_path = '' as $$
declare message public.outbound_messages%rowtype; sanitized text; worker text;
begin
  if p_error_code not in ('provider_timeout','provider_unavailable','provider_rejected','internal_error') or p_error_message is null then raise exception using errcode='P0001',message='invalid_outbound_error'; end if;
  sanitized := left(regexp_replace(trim(p_error_message), '[[:cntrl:]]', ' ', 'g'),300);
  select claimed_by into worker from public.outbound_messages where id=p_message_id and status='processing' and claim_token=p_claim_token and lease_expires_at > p_at for update;
  if worker is null then raise exception using errcode='P0001',message='invalid_outbound_lease'; end if;
  update public.outbound_messages set status=case when p_retryable and attempts < max_attempts then 'retryable_failed' else 'permanent_failed' end, available_at=case when p_retryable and attempts < max_attempts then p_at + make_interval(secs=>least(3600,60 * (2 ^ greatest(attempts-1,0))::integer)) else available_at end,last_error_code=p_error_code,last_error_message=sanitized where id=p_message_id and status='processing' and claim_token=p_claim_token and lease_expires_at > p_at returning * into message;
  if not found then raise exception using errcode='P0001',message='invalid_outbound_lease'; end if;
  insert into public.outbound_audit_log(event_id,campaign_id,outbound_message_id,action,actor_type,actor_id,details) values(message.event_id,message.campaign_id,message.id,case when message.status='permanent_failed' then 'permanent_failed' else 'retry_scheduled' end,'service',worker,jsonb_build_object('code',p_error_code,'attempt',message.attempts)); return message;
end;
$$;

create function public.cancel_outbound_message(p_message_id uuid, p_cancelled_by text)
returns public.outbound_messages language plpgsql security definer set search_path = '' as $$
declare message public.outbound_messages%rowtype;
begin
  update public.outbound_messages set status='cancelled',cancelled_at=now() where id=p_message_id and status in ('ready','scheduled','retryable_failed') returning * into message;
  if not found then raise exception using errcode='P0001',message='outbound_cancellation_denied'; end if;
  insert into public.outbound_audit_log(event_id,campaign_id,outbound_message_id,action,actor_type,actor_id,details) values(message.event_id,message.campaign_id,message.id,'cancelled','service',trim(p_cancelled_by),'{}'); return message;
end;
$$;

create function public.mark_outbound_message_sent(p_message_id uuid, p_claim_token uuid, p_provider text, p_provider_message_id text, p_at timestamptz default now())
returns public.outbound_messages language plpgsql security definer set search_path = '' as $$
declare message public.outbound_messages%rowtype; worker text;
begin
  if p_provider is null or char_length(trim(p_provider)) not between 1 and 80 or p_provider_message_id is null or char_length(trim(p_provider_message_id)) not between 1 and 200 then raise exception using errcode='P0001',message='invalid_provider_receipt'; end if;
  select claimed_by into worker from public.outbound_messages where id=p_message_id and status='processing' and claim_token=p_claim_token and lease_expires_at > p_at for update;
  if worker is null then raise exception using errcode='P0001',message='invalid_outbound_lease'; end if;
  update public.outbound_messages set status='sent',provider=trim(p_provider),provider_message_id=trim(p_provider_message_id),sent_at=p_at where id=p_message_id and status='processing' and claim_token=p_claim_token and lease_expires_at > p_at returning * into message;
  if not found then raise exception using errcode='P0001',message='invalid_outbound_lease'; end if;
  insert into public.outbound_audit_log(event_id,campaign_id,outbound_message_id,action,actor_type,actor_id,details) values(message.event_id,message.campaign_id,message.id,'sent','service',worker,jsonb_build_object('provider',message.provider)); return message;
end;
$$;

alter table public.outbound_messages enable row level security;
alter table public.outbound_dry_runs enable row level security;
alter table public.outbound_dry_run_results enable row level security;
alter table public.outbound_audit_log enable row level security;
revoke all on table public.outbound_messages, public.outbound_dry_runs, public.outbound_dry_run_results, public.outbound_audit_log from public, anon, authenticated, service_role;
grant select on table public.outbound_messages, public.outbound_dry_runs, public.outbound_dry_run_results, public.outbound_audit_log to service_role;
revoke all on sequence public.outbound_audit_log_id_seq from public, anon, authenticated, service_role;

revoke execute on function public.next_outbound_send_time(timestamptz), public.evaluate_outbound_policy(uuid,timestamptz), public.outbound_message_transition_guard(), public.outbound_audit_log_append_only(), public.create_outbound_dry_run(uuid,text,timestamptz), public.enqueue_invitation_campaign(uuid,text,timestamptz), public.claim_outbound_messages(text,integer,integer,timestamptz), public.report_outbound_failure(uuid,uuid,text,text,boolean,timestamptz), public.cancel_outbound_message(uuid,text), public.mark_outbound_message_sent(uuid,uuid,text,text,timestamptz) from public, anon, authenticated;
grant execute on function public.create_outbound_dry_run(uuid,text,timestamptz), public.enqueue_invitation_campaign(uuid,text,timestamptz), public.claim_outbound_messages(text,integer,integer,timestamptz), public.report_outbound_failure(uuid,uuid,text,text,boolean,timestamptz), public.cancel_outbound_message(uuid,text), public.mark_outbound_message_sent(uuid,uuid,text,text,timestamptz) to service_role;
