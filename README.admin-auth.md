# Admin authentication setup

Phase 1 admin authentication uses server-only environment variables and a signed session cookie. No plaintext admin password is stored in the repository or database.

## Required server-only variables

```dotenv
ADMIN_EMAIL=
ADMIN_PASSWORD_HASH=
ADMIN_SESSION_SECRET=
```

Generate the hash and session secret locally:

```bash
npm run admin:credentials
```

The command prompts for the password without echoing it and prints only:

- `ADMIN_PASSWORD_HASH`
- `ADMIN_SESSION_SECRET`

Set `ADMIN_EMAIL` separately to the administrator's email address. Add all three values to the target deployment environment and redeploy.

## Routes

- `/admin/login` — sign in.
- `/admin` — protected admin home.
- Sign out is available from the protected admin header.

## Security properties

- Password verification uses Node.js `scrypt` and a random salt.
- The configured password exists only as a hash.
- Session tokens are HMAC-SHA256 signed and expire after 12 hours.
- The cookie is `HttpOnly`, `SameSite=Lax`, and `Secure` in production.
- Protected admin pages call `requireAdminSession()` server-side.
- Future admin server actions must call `requireAdminSession()` before privileged work.
- Invalid credentials return one generic error; the application does not reveal whether the email or password was wrong.

Login rate limiting is intentionally deferred to the production-hardening phase and must be added before production launch.
