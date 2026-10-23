import assert from 'node:assert/strict';
import fs from 'node:fs';
import { patchInstagram } from '../scripts/patch-cobalt.mjs';

const source = fs.readFileSync(new URL('../cobalt-api/api/src/processing/services/instagram.js', import.meta.url), 'utf8');
const patched = patchInstagram(source);
assert.equal(patchInstagram(patched), patched);
const preamble = `import {randomBytes} from 'node:crypto';
const genericUserAgent='test';
const getCookie=()=>undefined, updateCookie=()=>{}, createStream=(o)=>o.url;`;
const module = await import('data:text/javascript;base64,' + Buffer.from(preamble + patched.replace(/^import .*;\n/gm, '')).toString('base64'));
const originalFetch = globalThis.fetch;
let fallbackCalled = false;
try {
  globalThis.fetch = async (url, options) => {
    const route = new URL(url).pathname;
    if (route.includes('oembed')) return Response.json({});
    if (route.includes('/embed/')) return new Response('<html>changed embed markup</html>');
    if (route === '/graphql/query') {
      fallbackCalled = true;
      assert.match(options.headers.cookie, /csrftoken=test-csrf/);
      return Response.json({data: {xdt_shortcode_media: {video_url: 'https://media.test/reel.mp4'}}});
    }
    return new Response('["InstagramSecurityConfig",[],{"csrf_token":"test-csrf"},1]');
  };
  const result = await module.default({postId: 'DexAHRzzjLK'});
  assert.ok(fallbackCalled, 'Broken embed markup must not skip GraphQL fallback');
  assert.equal(result.urls, 'https://media.test/reel.mp4');
  assert.equal(result.filename, 'instagram_DexAHRzzjLK.mp4');
  console.log('PASS  Instagram fallback survives malformed embed and retains anonymous cookies');
} finally { globalThis.fetch = originalFetch; }
