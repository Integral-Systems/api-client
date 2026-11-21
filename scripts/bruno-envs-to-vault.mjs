#!/usr/bin/env node
// Rewrites the Bruno environments of this repo so that secret variables come from
// ISD OpenBao (Bruno "External Secrets", HashiCorp Vault Server, AppRole bruno-api-client)
// instead of the app's local secret store.
//
// For every environment that has secrets in ~/Library/Application Support/bruno/secrets.json
// (names only are read, never values):
//   - the names leave `vars:secret [ … ]`
//   - `vars { name: {{vault.name}} }` is added, so requests keep using {{name}}
//   - `vars:externalsecrets:hashicorp-vault-server { vault: secret-store/data/operations/bruno-client/<collection>/<env> }`
//
//   node scripts/bruno-envs-to-vault.mjs            dry run
//   node scripts/bruno-envs-to-vault.mjs --apply    write the files
//
// Same path scheme and FreshX filter as bruno-secrets-to-openbao.mjs.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APPLY = process.argv.includes('--apply');
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SECRETS_FILE = `${homedir()}/Library/Application Support/bruno/secrets.json`;
const MOUNT_PATH = 'secret-store/data/operations/bruno-client';
const ROW = 'vault';

const isFreshX = (p, env) => /\/(ITS|FreshX|Jaeger)\//i.test(p) || /\/FX-/i.test(p) || /freshx/i.test(env);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const data = JSON.parse(readFileSync(SECRETS_FILE, 'utf8'));
let changed = 0;
for (const c of data.collections ?? []) {
  if (!c.path.startsWith(REPO + '/')) continue;
  for (const env of c.environments ?? []) {
    const names = (env.secrets ?? []).filter((s) => s?.value).map((s) => s.name);
    if (!names.length || isFreshX(c.path, env.name)) continue;
    const file = join(c.path, 'environments', `${env.name}.bru`);
    if (!existsSync(file)) { console.log(`missing  ${file}`); continue; }
    let text = readFileSync(file, 'utf8');
    if (text.includes('vars:externalsecrets:')) { console.log(`skip (has external secrets)  ${file}`); continue; }

    // vars:secret [ a, b ] -> drop the migrated names, drop the block if empty
    text = text.replace(/vars:secret \[([^\]]*)\]\n?/, (_, body) => {
      const rest = body.split(',').map((n) => n.trim()).filter((n) => n && !names.includes(n.replace(/^~/, '')));
      return rest.length ? `vars:secret [\n  ${rest.join(',\n  ')}\n]\n` : '';
    });

    const refs = names.map((n) => `  ${n}: {{${ROW}.${n}}}`).join('\n');
    if (/^vars \{\n/m.test(text)) text = text.replace(/^vars \{\n/m, `vars {\n${refs}\n`);
    else text = `vars {\n${refs}\n}\n` + text;

    const path = `${MOUNT_PATH}/${slug(basename(c.path))}/${slug(env.name)}`;
    text = text.replace(/\n*$/, '\n') + `vars:externalsecrets:hashicorp-vault-server {\n  ${ROW}: ${path}\n}\n`;

    console.log(`${APPLY ? 'write' : 'plan '}  ${file.slice(REPO.length + 1)}  -> ${path}  [${names.join(', ')}]`);
    if (APPLY) writeFileSync(file, text);
    changed++;
  }
}
console.log(`\n${changed} environment(s)${APPLY ? ' written' : ' (dry run)'}`);
