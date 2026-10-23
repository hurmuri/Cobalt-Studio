import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// AGPL-3.0-only compatibility patch for cobalt. Keep the vendored checkout intact and apply reviewed fixes to staged releases only. This does not add a login or access-control bypass.
export function patchInstagram(source) {
  const replacements = [
    ['data = await requestHTML(id);', 'data = await requestHTML(id).catch(() => null);'],
    ['data = await requestHTML(id, cookie);', 'data = await requestHTML(id, cookie).catch(() => null);'],
    ['data = await requestGQL(id);', 'data = await requestGQL(id).catch(() => null);'],
    ['data = await requestGQL(id, cookie);', 'data = await requestGQL(id, cookie).catch(() => null);'],
    ['...headers,\n                cookie,', '...headers,\n                ...(cookie && { cookie }),'],
  ];
  let result = source.replace(/\r\n/g, '\n');
  for (const [before, after] of replacements) {
    if (result.includes(after)) continue;
    if (!result.includes(before)) throw new Error('Instagram upstream changed; review the compatibility patch.');
    result = result.replace(before, after);
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const file = path.join(process.argv[2], 'api/src/processing/services/instagram.js');
  fs.writeFileSync(file, patchInstagram(fs.readFileSync(file, 'utf8')));
}
