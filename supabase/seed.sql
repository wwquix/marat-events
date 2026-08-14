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

