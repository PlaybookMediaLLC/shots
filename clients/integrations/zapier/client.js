'use strict';

const { createHash } = require('node:crypto');

function origin(auth) {
  const url = new URL(auth.origin);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Use an HTTPS Shots origin without a path, query, or credentials.');
  }
  return url.origin;
}

async function request(z, bundle, path, method = 'GET', body) {
  if (!path.startsWith('/api/v1/') || path.includes('://')) throw new Error('Invalid Shots API path.');
  const response = await z.request({
    url: origin(bundle.authData) + path, method,
    headers: { 'X-API-Key': bundle.authData.apiKey, 'Content-Type': 'application/json' },
    redirect: 'manual', follow: 0,
    ...(body === undefined ? {} : { body }),
  });
  if (response.status >= 300 && response.status < 400) throw new Error('Shots redirected the request. Check the configured origin.');
  response.throwForStatus();
  return response.json;
}

async function sets(z, bundle) {
  return (await request(z, bundle, '/api/v1/social-sets')).items;
}

async function createDraft(z, bundle) {
  const input = bundle.inputData;
  if (!input.requestId || input.requestId.length > 512) throw new Error('Supply the stable source event ID; reuse it on a retry.');
  const set = (await sets(z, bundle)).find(item => item.id === input.socialSetId);
  if (!set) throw new Error('This profile is unavailable to this API key.');
  const platforms = input.platforms?.length ? input.platforms : set.defaultPlatforms;
  const channelConnectionIds = [...new Set(platforms)].map(platform => {
    const account = set.accounts.find(item => item.platform === platform);
    if (!account) throw new Error(`No ${platform} account is connected to this profile.`);
    return account.id;
  });
  const text = input.text || '';
  const posts = text.replace(/\r\n?/g, '\n').split(/\n[ \t]*---[ \t]*\n|\n(?:[ \t]*\n){3,}/).map(value => value.trim()).filter(Boolean);
  if (!posts.length || posts.length > 25 || text.length > 100000) throw new Error('Provide 1–25 posts, up to 100,000 characters.');
  const body = posts.flatMap((post, index) => [
    { type: 'post_break', id: `zapier_${index}`, children: [{ text: '' }] },
    ...post.split('\n').map(line => ({ type: 'p', children: [{ text: line }] })),
  ]);
  return request(z, bundle, '/api/v1/content-drafts', 'POST', {
    importKey: 'zapier:' + createHash('sha256').update(input.requestId).digest('hex'),
    socialSetId: set.id, channelConnectionIds, body,
    title: input.title?.trim() || posts[0].slice(0, 80), plainText: posts.join('\n\n'),
  });
}

module.exports = { origin, request, sets, createDraft };
