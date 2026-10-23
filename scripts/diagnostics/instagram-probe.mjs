import fs from 'node:fs';
const source = fs.readFileSync('cobalt-api/api/src/processing/services/instagram.js', 'utf8');
const imports = `import {randomBytes} from 'node:crypto';
const genericUserAgent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36';
const getCookie=()=>undefined, updateCookie=()=>{}, createStream=(o)=>o.url;`;
const fetchOriginal = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  const response = await fetchOriginal(url, { ...options, signal: AbortSignal.timeout(20000) });
  const body = await response.clone().text();
  console.log(JSON.stringify({ path: new URL(url).pathname, status: response.status, bytes: body.length,
    login: body.includes('login_required'), media: body.includes('video_url'), embed: body.includes('contextJSON') }));
  return response;
};
let code = source.replace(/^import .*;\r?\n/gm, '');
code = code.replace("...headers,\n                cookie,", "...headers,\n                ...(cookie && {cookie}),");
code = code.replace('JSON.parse(data?.match(/"init",\\[\\],\\[(.*?)\\]\\],/)[1])', 'JSON.parse(data?.match(/"init",\\[\\],\\[(.*?)\\]\\],/)?.[1] || "null")');
const module = await import('data:text/javascript;base64,' + Buffer.from(imports + code).toString('base64'));
for (const postId of ['DexsAXJSgqT','Dey1t8OSH2a','DexAHRzzjLK']) {
  try { const result = await module.default({postId}); console.log(JSON.stringify({postId, error: result?.error, video: Boolean(result?.urls)})); }
  catch(error) { console.log(postId, error.message); }
}
