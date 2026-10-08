#!/usr/bin/env tsx
/**
 * Creates (or updates) a staff account: the owner (`admin`) or the pipeline
 * worker (`pipeline`). The role is stored in app_metadata, which only the
 * service role can write, so nobody can promote themselves.
 *
 * Run once per environment by the owner:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *   pnpm --filter @sia/supabase staff:create -- --role admin --email owner@example.com --password '...'
 *
 * The service role key is used only here. Never give it to the pipeline worker.
 */
import { parseArgs } from 'node:util';
import { createClient } from '@supabase/supabase-js';

const { values } = parseArgs({
  options: {
    role: { type: 'string' },
    email: { type: 'string' },
    password: { type: 'string' },
  },
});

const role = values.role;
if (role !== 'admin' && role !== 'pipeline') {
  console.error('--role must be "admin" or "pipeline"');
  process.exit(2);
}
if (!values.email || !values.password || values.password.length < 12) {
  console.error('--email and --password (12+ characters) are required');
  process.exit(2);
}
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  process.exit(2);
}

const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const created = await admin.auth.admin.createUser({
  email: values.email,
  password: values.password,
  email_confirm: true,
  app_metadata: { app_role: role },
});
if (created.error) {
  if (!/already/i.test(created.error.message)) throw created.error;
  // Existing user: find it and set the role.
  let page = 1;
  for (;;) {
    const list = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (list.error) throw list.error;
    const user = list.data.users.find((u) => u.email?.toLowerCase() === values.email!.toLowerCase());
    if (user) {
      const upd = await admin.auth.admin.updateUserById(user.id, {
        password: values.password,
        app_metadata: { ...user.app_metadata, app_role: role },
      });
      if (upd.error) throw upd.error;
      console.log(`updated ${values.email} -> ${role}`);
      break;
    }
    if (list.data.users.length < 200) throw new Error('user exists but could not be found');
    page++;
  }
} else {
  console.log(`created ${values.email} -> ${role}`);
}
