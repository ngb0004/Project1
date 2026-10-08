import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');

export function loadFixture(name: string): any {
  return JSON.parse(readFileSync(join(root, 'cases/fixtures', `${name}.json`), 'utf8'));
}

export const FIXTURES = ['fixture-harbor-bridge', 'fixture-orchard-school'] as const;
