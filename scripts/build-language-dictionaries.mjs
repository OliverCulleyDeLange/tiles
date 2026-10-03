import { mkdir, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';

const revision = '32b006a2c22a4ac7e8ed3f03346f7b3d85a970a4';
const rawBase = `https://raw.githubusercontent.com/LibreOffice/dictionaries/${revision}`;
const outputDir = new URL('../public/dictionaries/', import.meta.url);
const noticesDir = new URL('../public/dictionaries/libreoffice-notices/', import.meta.url);

const dictionaries = [
  { id: 'de', path: 'de/de_DE_frami.dic', encoding: 'iso-8859-1' },
  { id: 'es', path: 'es/es_ES.dic', encoding: 'utf-8' },
  { id: 'it', path: 'it_IT/it_IT.dic', encoding: 'utf-8' },
  { id: 'fr', path: 'fr_FR/dictionaries/fr.dic', encoding: 'utf-8' },
  { id: 'pt', path: 'pt_PT/pt_PT.dic', encoding: 'utf-8' },
];

const notices = [
  'de/README_de_DE_frami.txt',
  'de/COPYING_GPLv2',
  'de/COPYING_GPLv3',
  'de/COPYING_LGPL_v2.0.txt',
  'de/COPYING_LGPL_v2.1.txt',
  'de/COPYING_OASIS.txt',
  'es/LICENSE.md',
  'es/README_hunspell_es.txt',
  'it_IT/README_it_IT.txt',
  'fr_FR/dictionaries/README_dict_fr.txt',
  'pt_PT/LICENSES.txt',
  'pt_PT/README_pt_PT.txt',
];

async function download(path) {
  const response = await fetch(`${rawBase}/${path}`);
  if (!response.ok) throw new Error(`${response.status} fetching ${path}`);
  return new Uint8Array(await response.arrayBuffer());
}

function normalizeWord(value) {
  return value
    .replace(/\/.*/, '')
    .replace(/\t.*/, '')
    .replaceAll('ß', 'ss')
    .replaceAll('ẞ', 'SS')
    .replaceAll('œ', 'oe')
    .replaceAll('Œ', 'OE')
    .replaceAll('æ', 'ae')
    .replaceAll('Æ', 'AE')
    .normalize('NFD')
    .replace(/\p{Mark}/gu, '')
    .toUpperCase();
}

await mkdir(outputDir, { recursive: true });
await mkdir(noticesDir, { recursive: true });

for (const dictionary of dictionaries) {
  const bytes = await download(dictionary.path);
  const text = new TextDecoder(dictionary.encoding).decode(bytes);
  const words = new Set();
  for (const line of text.split(/\r?\n/).slice(1)) {
    const word = normalizeWord(line.trim());
    if (/^[A-Z]{2,32}$/.test(word)) words.add(word);
  }
  const sorted = [...words].sort().join('\n') + '\n';
  await writeFile(new URL(`${dictionary.id}.txt.gz`, outputDir), gzipSync(sorted, { level: 9 }));
  console.log(`${dictionary.id}: ${words.size.toLocaleString()} words`);
}

for (const path of notices) {
  const safeName = path.replaceAll('/', '--');
  await writeFile(new URL(safeName, noticesDir), await download(path));
}

await writeFile(
  new URL('SOURCE.txt', noticesDir),
  `Derived from LibreOffice dictionaries at revision ${revision}.\n` +
    `Source: https://github.com/LibreOffice/dictionaries/tree/${revision}\n` +
    `The original notices and licences for each included dictionary are in this directory.\n`,
);
