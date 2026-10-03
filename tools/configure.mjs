import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const site = process.argv[2] || process.env.FIREBASE_QUOTES_SITE;
const project = process.argv[3] || process.env.FIREBASE_PROJECT_ID || 'retocker';
if (!site || !/^[a-z0-9][a-z0-9-]{2,61}$/.test(site) || site === project) {
  throw new Error('Specify a separate quotes site ID, different from the main journal site/project');
}
if (!/^[a-z][a-z0-9-]{4,62}$/.test(project)) throw new Error('Invalid Firebase project ID');
fs.writeFileSync(path.join(root, '.firebaserc'), JSON.stringify({
  projects: { default: project }, targets: { [project]: { hosting: { quotes: [site] } } },
}, null, 2) + '\n');
console.log('Configured quotes target:', site, 'project:', project);
console.log('Quotes URL: https://' + site + '.web.app/replay-data/');
