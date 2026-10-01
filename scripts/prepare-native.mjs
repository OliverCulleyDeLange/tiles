import { cp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const project = resolve(import.meta.dirname, '..');
const source = resolve(project, 'dist');
const target = resolve(project, 'native-dist');

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });

console.log('Prepared offline Tiles bundle in native-dist/');
