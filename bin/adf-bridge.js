#!/usr/bin/env node
// Installed copies run the built dist/; a development checkout without a build runs src/ directly.
import { existsSync } from 'node:fs';

const dist = new URL('../dist/cli.js', import.meta.url);
const { run } = await import(existsSync(dist) ? dist.href : new URL('../src/cli.ts', import.meta.url).href);
run();
