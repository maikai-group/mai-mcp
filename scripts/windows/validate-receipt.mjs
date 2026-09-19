#!/usr/bin/env node
// SPDX-License-Identifier: MIT — Copyright © 2026 Maikai Group Inc.
// Part of mai-mcp (MIT — the whole project; see LICENSE). Copy freely.
//
// The one receipt validator (Plan 32b): additionalProperties:false at every
// object, required keys, const, boolean, string + pattern — and nothing else,
// so a schema node this file does not understand is a refusal, never a pass.
// Used by the release leak gate, by the tests, and by hand:
//
//   node scripts/windows/validate-receipt.mjs <schema.json> <receipt.json> [<expected-reviewed-sha>]
//
// Exit 0 when the receipt is schema-valid; with an expected SHA it must also be
// releasable: every boolean true and release.reviewedSha equal to the SHA.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Returns the list of violations; an empty list means schema-valid. */
export function validateReceipt(schema, value, at = 'receipt') {
  const problems = [];
  if (!isRecord(schema)) return [`${at}: schema node is not an object`];
  if (schema.type === 'object') {
    if (!isRecord(value)) return [`${at}: expected object`];
    const props = isRecord(schema.properties) ? schema.properties : {};
    for (const key of Object.keys(value)) {
      if (!(key in props)) { problems.push(`${at}.${key}: key not permitted`); continue; }
      problems.push(...validateReceipt(props[key], value[key], `${at}.${key}`));
    }
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const req of required) if (!(String(req) in value)) problems.push(`${at}.${String(req)}: required key missing`);
    return problems;
  }
  if ('const' in schema) return schema.const === value ? [] : [`${at}: must equal ${JSON.stringify(schema.const)}`];
  if (schema.type === 'boolean') return typeof value === 'boolean' ? [] : [`${at}: expected boolean`];
  if (schema.type === 'string') {
    if (typeof value !== 'string') return [`${at}: expected string`];
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) return [`${at}: pattern mismatch`];
    return [];
  }
  return [`${at}: unsupported schema node`];
}

/** Every `false` boolean anywhere in the receipt, by path. */
export function falseBooleans(value, at = 'receipt') {
  if (!isRecord(value)) return value === false ? [at] : [];
  return Object.entries(value).flatMap(([key, child]) => falseBooleans(child, `${at}.${key}`));
}

/** Releasable: schema-valid, no false boolean, reviewedSha equals the expected commit. */
export function releasable(schema, receipt, expectedSha) {
  const problems = validateReceipt(schema, receipt);
  problems.push(...falseBooleans(receipt).map((at) => `${at}: false boolean`));
  const release = isRecord(receipt) ? receipt.release : undefined;
  if (!isRecord(release) || release.reviewedSha !== expectedSha) problems.push('receipt.release.reviewedSha: not the reviewed commit');
  return problems;
}

export function main(argv = process.argv.slice(2)) {
  const [schemaPath, receiptPath, expectedSha] = argv;
  if (!schemaPath || !receiptPath) {
    process.stderr.write('usage: validate-receipt.mjs <schema.json> <receipt.json> [<expected-reviewed-sha>]\n');
    return 2;
  }
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  const problems = expectedSha ? releasable(schema, receipt, expectedSha) : validateReceipt(schema, receipt);
  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`${problem}\n`);
    return 1;
  }
  process.stdout.write(`receipt ok: ${path.basename(receiptPath)}\n`);
  return 0;
}

const invoked = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false;
if (invoked) process.exitCode = main();
