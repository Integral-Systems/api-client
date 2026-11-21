#!/usr/bin/env node
// Imports the secret environment variables stored in the Bruno desktop app
// (~/Library/Application Support/bruno/secrets.json, Electron safeStorage "$00:")
// into ISD OpenBao under secret-store/operations/bruno-client/<collection>/<environment>.
//
// Values never reach stdout: each one is decrypted in memory and piped on stdin to
// `ops-cli secret --system isd --yes put PATH KEY --create`. Output: path, key, length.
//
//   node scripts/bruno-secrets-to-openbao.mjs            dry run: planned paths and keys, no decryption
//   node scripts/bruno-secrets-to-openbao.mjs --apply    decrypt and write (macOS asks for the keychain item)
//
// Existing keys are not overwritten (no --replace); such keys are reported and skipped.
// FreshX entries are skipped: they never go into the ISD OpenBao.

import { readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { basename } from 'node:path';
import crypto from 'node:crypto';

const APPLY = process.argv.includes('--apply');
const BASE = 'operations/bruno-client';
const SECRETS_FILE = `${homedir()}/Library/Application Support/bruno/secrets.json`;
const KEYCHAIN_SERVICE = 'bruno Safe Storage';

// FreshX: by collection path or environment name.
const isFreshX = (collectionPath, envName) =>
  /\/(ITS|FreshX|Jaeger)\//i.test(collectionPath) ||
  /\/FX-/i.test(collectionPath) ||
  /freshx/i.test(envName);

const slug = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// Chromium safeStorage on macOS: "v10" + AES-128-CBC, key = PBKDF2-SHA1(keychain password,
// "saltysalt", 1003, 16), IV = 16 spaces. Bruno stores it as "$00:" + hex.
let key;
const decrypt = (stored) => {
  if (!stored.startsWith('$00:')) throw new Error(`unknown format ${stored.slice(0, 4)}`);
  const buf = Buffer.from(stored.slice(4), 'hex');
  if (buf.subarray(0, 3).toString() !== 'v10') throw new Error('no v10 prefix');
  if (!key) {
    const pw = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    }).trimEnd();
    key = crypto.pbkdf2Sync(pw, 'saltysalt', 1003, 16, 'sha1');
  }
  const d = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '));
  return Buffer.concat([d.update(buf.subarray(3)), d.final()]).toString('utf8');
};

const data = JSON.parse(readFileSync(SECRETS_FILE, 'utf8'));
const plan = [];
const skipped = [];
for (const c of data.collections ?? []) {
  const coll = basename(c.path);
  for (const env of c.environments ?? []) {
    for (const s of env.secrets ?? []) {
      if (!s?.value) continue;
      const entry = { coll, env: env.name, name: s.name, value: s.value,
        path: `${BASE}/${slug(coll)}/${slug(env.name)}` };
      (isFreshX(c.path, env.name) ? skipped : plan).push(entry);
    }
  }
}

for (const e of skipped) console.log(`skip (FreshX)  ${e.coll} / ${e.env} / ${e.name}`);
console.log(`\n${plan.length} secrets to import, ${skipped.length} skipped${APPLY ? '' : ' (dry run)'}\n`);

let failed = 0;
for (const e of plan) {
  if (!APPLY) {
    console.log(`plan  ${e.path}  ${e.name}`);
    continue;
  }
  let value;
  try {
    value = decrypt(e.value);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${e.path}  ${e.name}  decrypt: ${err.message}`);
    continue;
  }
  const r = spawnSync('ops-cli', ['secret', '--system', 'isd', '--yes', 'put', e.path, e.name, '--create'], {
    input: value,
    encoding: 'utf8',
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().replace(/\s+/g, ' ');
  if (r.status === 0) console.log(`ok    ${e.path}  ${e.name}  len=${value.length}`);
  else { failed++; console.log(`FAIL  ${e.path}  ${e.name}  ${out}`); }
  value = undefined;
}
process.exit(failed ? 1 : 0);
