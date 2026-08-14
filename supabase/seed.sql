insert into public.events (
  slug,
  title,
  description,
  venue,
  starts_at,
  capacity,
  price_cents,
  currency,
  stripe_price_id,
  status
)
values (
  'demo-marats-future-event',
  'Demo: Marat’s Future Event',
  'A clearly fictional Phase 0 event for local development only.',
  'Demo Hall',
  '2099-06-15 18:30:00+00',
  100,
  2500,
  'USD',
  null,
  'published'
)
on conflict (slug) do nothing;

insert into public.ticket_types (
  event_id,
  code,
  name,
  audience,
  price_cents,
  currency,
  capacity,
  status
)
select
  events.id,
  'general',
  'General Admission',
  'any',
  events.price_cents,
  events.currency,
  events.capacity,
  'active'
from public.events
where events.slug = 'demo-marats-future-event'
on conflict (event_id, code) do nothing;
