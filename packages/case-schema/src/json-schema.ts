import { z } from 'zod';
import { Case } from './schema';
import { SeedProfile } from './seed';

/**
 * JSON Schemas for the documents the database stores, generated from the Zod
 * schemas (output shape, defaults applied). The database enforces them with
 * pg_jsonschema: a case at publish time, a seed profile when it is saved.
 * Refinements such as "a real calendar date" are not representable and are
 * enforced by the TypeScript validator only.
 */
const toJson = (schema: z.ZodType) =>
  z.toJSONSchema(schema, { io: 'output', unrepresentable: 'any', target: 'draft-2020-12' }) as Record<string, unknown>;

export function caseJsonSchema(): Record<string, unknown> {
  return toJson(Case);
}

export function seedProfileJsonSchema(): Record<string, unknown> {
  return toJson(SeedProfile);
}
