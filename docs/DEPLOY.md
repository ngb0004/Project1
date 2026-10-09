# Deploying to the owner's accounts

Hosted targets for v1, and the steps to bring them up. A Claude session with
these environment secrets can run every step below:

| Secret | Used for |
| --- | --- |
| `SUPABASE_ACCESS_TOKEN` | Supabase CLI and Management API (link, push migrations, read API keys, auth config) |
| `SUPABASE_DB_PASSWORD` | `supabase link` / `supabase db push` |
| `EXPO_TOKEN` | EAS CLI (environment variables, builds) |

## Accounts

- Supabase project: **social issues**, ref `sbzxnzlfgiqiwgyagdet`,
  URL `https://sbzxnzlfgiqiwgyagdet.supabase.co`
- Expo project: `@ngb0004/dive` (`apps/mobile/app.json` holds the project id)

## 1. Database

```sh
cd supabase
npx supabase link --project-ref sbzxnzlfgiqiwgyagdet --password "$SUPABASE_DB_PASSWORD"
npx supabase db push            # applies every migration in supabase/migrations
```

Check afterwards that `pg_cron` and `pg_jsonschema` are enabled
(`select extname from pg_extension`) and that the two cron jobs exist
(`select jobname from cron.job`).

If the Supabase GitHub integration is connected with "Deploy to production",
merging into `master` applies the same migrations; run `db push` only once.

## 2. Auth settings

Turn off new signups while keeping email and password sign-in (Dashboard:
Authentication -> Sign In / Providers -> "Allow new users to sign up" off), or
through the Management API:

```sh
curl -X PATCH "https://api.supabase.com/v1/projects/sbzxnzlfgiqiwgyagdet/config/auth" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" \
  -d '{"disable_signup": true}'
```

## 3. Staff accounts

The service-role key is needed once, to set `app_metadata.app_role`. Read it
from the Management API (`GET /v1/projects/sbzxnzlfgiqiwgyagdet/api-keys`)
into a shell variable for this step only; never store it in a file, the
repo, the admin console or the pipeline worker.

```sh
SUPABASE_URL=https://sbzxnzlfgiqiwgyagdet.supabase.co SUPABASE_SERVICE_ROLE_KEY=... \
  pnpm --filter @sia/supabase staff:create --role admin --email <owner email> --password '<12+ chars>'
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
  pnpm --filter @sia/supabase staff:create --role pipeline --email <pipeline email> --password '<12+ chars>'
```

The owner chooses the admin password; give the owner the pipeline account's
password to store as `PIPELINE_EMAIL` / `PIPELINE_PASSWORD` wherever the worker
runs.

## 4. Seed case

Import the Cornell case into the review queue (it is not published):

```sh
SUPABASE_URL=https://sbzxnzlfgiqiwgyagdet.supabase.co SUPABASE_ANON_KEY=sb_publishable_bLglFGR3PAnCNehrsZMg_Q_7k3v_iuR \
SIA_STAFF_EMAIL=<owner email> SIA_STAFF_PASSWORD=... \
  pnpm --filter @sia/supabase import-case ../cases/seed/cornell.json --seed-profile ../cases/seed/cornell.seed-profile.json
```

## 5. Dive app (EAS)

The publishable key and URL are public values; they ship inside the app.

```sh
cd apps/mobile
for env in preview production; do
  npx eas-cli env:set --environment $env --name EXPO_PUBLIC_SUPABASE_URL \
    --value https://sbzxnzlfgiqiwgyagdet.supabase.co --visibility plaintext --non-interactive
  npx eas-cli env:set --environment $env --name EXPO_PUBLIC_SUPABASE_ANON_KEY \
    --value sb_publishable_bLglFGR3PAnCNehrsZMg_Q_7k3v_iuR --visibility plaintext --non-interactive
done
npx eas-cli build --platform android --profile preview --non-interactive
```

`EXPO_PUBLIC_SHARE_BASE_URL` needs the public web origin once the web build is
hosted. iOS builds need the owner's Apple Developer account and a one-time
credentials setup on expo.dev.

## 6. Admin console and worker

Deploy `apps/admin` with `NEXT_PUBLIC_SUPABASE_URL` and
`NEXT_PUBLIC_SUPABASE_ANON_KEY` (publishable key). Run the pipeline worker
(`services/pipeline`, see its README and Dockerfile) with the pipeline account
and Claude access.
