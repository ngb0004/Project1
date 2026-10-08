#!/usr/bin/env tsx
/**
 * Prints the JSON Schemas the database enforces, generated from the Zod schemas:
 *   {"case": {...}, "seed_profile": {...}}
 *
 * When the Zod schema changes, add a migration that updates app.json_schemas
 * with this output; supabase/tests/json-schema.test.ts fails until you do.
 */
import { caseJsonSchema, seedProfileJsonSchema } from '../src/json-schema';

process.stdout.write(JSON.stringify({ case: caseJsonSchema(), seed_profile: seedProfileJsonSchema() }) + '\n');
