export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
}

export function postView(task) {
  const post = task.post || {};
  let url;
  try { url = new URL(task.url); } catch { return ''; }
  if (!['https:', 'http:'].includes(url.protocol)) return '';
  const platform = post.platform || url.hostname.replace(/^www\./, '');
  const author = [post.author, post.handle && post.author !== post.handle ? `@${post.handle}` : ''].filter(Boolean).join('  ');
  const date = post.publishedAt ? new Date(post.publishedAt) : null;
  const published = date && !Number.isNaN(date.getTime()) ? date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '';
  const text = String(post.text || '');
  const excerpt = text.split('\n').find(Boolean)?.slice(0, 120) || '';
  const expandable = text.length > 120 || text.includes('\n');
  const caption = text ? expandable
    ? `<details class="post-text"><summary><span>${escapeHtml(excerpt)}</span><span class="post-expand">展开正文</span></summary><p>${escapeHtml(text)}</p></details>`
    : `<p class="post-text">${escapeHtml(text)}</p>` : '';
  return `<div class="post-info">
    <div class="post-author"><span class="post-platform">${escapeHtml(platform)}</span>${author ? `<span class="post-byline">${escapeHtml(author)}</span>` : ''}${published ? `<time datetime="${escapeHtml(date.toISOString())}">${escapeHtml(published)}</time>` : ''}</div>
    ${caption}
    <a class="post-source" href="${escapeHtml(url.href)}" target="_blank" rel="noreferrer" title="${escapeHtml(url.href)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13a4 4 0 0 0 6 0l4-4a4 4 0 0 0-6-6l-2 2M14 11a4 4 0 0 0-6 0l-4 4a4 4 0 0 0 6 6l2-2" /></svg><span class="post-source-label">源地址</span><span class="post-source-url">${escapeHtml(url.href)}</span></a>
  </div>`;
}
