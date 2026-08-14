# Marat Events safety rules

- Never expose Stripe secret keys or privileged Supabase secret keys.
- Server secrets must never use a `NEXT_PUBLIC_` prefix and must stay on the server.
- Payment success may eventually be established only from verified Stripe webhooks. A redirect to a success page never proves payment.
- Eventual webhook processing must be idempotent.
- Email failures must never roll back a confirmed payment.
- Staging and test environments must never use Stripe live credentials.
- Stripe production accounts and credentials belong to Marat's business.
- Use Node.js 22 or later for local, CI, preview, and production environments.
- Do not implement out-of-scope features without explicit approval.
