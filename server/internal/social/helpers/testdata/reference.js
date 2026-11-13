// Regenerates reference.json from the real npm packages the original app uses.
//   mkdir /tmp/hjs && cd /tmp/hjs && npm i parse5@6.0.1 striptags@3.2.0 \
//     twitter-text@3.1.0 remove-markdown@0.5.5 isomorphic-dompurify@3 tldts@6
//   NODE_PATH=/tmp/hjs/node_modules node reference.js > reference.json
// The helper bodies below are copied from libraries/helpers/src/utils.
const striptags = require('striptags');
const { parseFragment, serialize } = require('parse5');
const twitter = require('twitter-text');
const removeMd = require('remove-markdown');
const DOMPurify = require('isomorphic-dompurify');
const { parse } = require('tldts');

const bold = { a: '𝗮', b: '𝗯', c: '𝗰', d: '𝗱', e: '𝗲', f: '𝗳', g: '𝗴', h: '𝗵', i: '𝗶', j: '𝗷', k: '𝗸', l: '𝗹', m: '𝗺', n: '𝗻', o: '𝗼', p: '𝗽', q: '𝗾', r: '𝗿', s: '𝘀', t: '𝘁', u: '𝘂', v: '𝘃', w: '𝘄', x: '𝘅', y: '𝘆', z: '𝘇', A: '𝗔', B: '𝗕', C: '𝗖', D: '𝗗', E: '𝗘', F: '𝗙', G: '𝗚', H: '𝗛', I: '𝗜', J: '𝗝', K: '𝗞', L: '𝗟', M: '𝗠', N: '𝗡', O: '𝗢', P: '𝗣', Q: '𝗤', R: '𝗥', S: '𝗦', T: '𝗧', U: '𝗨', V: '𝗩', W: '𝗪', X: '𝗫', Y: '𝗬', Z: '𝗭', '1': '𝟭', '2': '𝟮', '3': '𝟯', '4': '𝟰', '5': '𝟱', '6': '𝟲', '7': '𝟳', '8': '𝟴', '9': '𝟵', '0': '𝟬' };
const underlineMap = {};
for (const c of 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890') underlineMap[c] = c + '̲';

const stripHtmlValidation = (type, val, replaceBold = false, none = false, plain = false, convertMentionFunction, inlineImages = false) => {
  if (plain) return val;
  const value = serialize(parseFragment(val));
  if (type === 'none') {
    return striptags(value).replace(/&gt;/gi, '>').replace(/&lt;/gi, '<').replace(/&amp;/gi, '&').replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'");
  }
  if (type === 'html') {
    return striptags(convertMention(inlineImages ? convertImages(value) : value, convertMentionFunction), ['ul', 'li', 'h1', 'h2', 'h3', 'p', 'strong', 'u', 'a', ...(inlineImages ? ['img'] : [])])
      .replace(/&gt;/gi, '>').replace(/&lt;/gi, '<').replace(/&amp;/gi, '&').replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'");
  }
  if (type === 'markdown') {
    return striptags(convertMention(value
      .replace(/<h1[^>]*>([.\s\S]*?)<\/h1>/g, (match, p1) => `<h1># ${p1}</h1>\n`)
      .replace(/&amp;/gi, '&').replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
      .replace(/<h2[^>]*>([.\s\S]*?)<\/h2>/g, (match, p1) => `<h2>## ${p1}</h2>\n`)
      .replace(/<h3[^>]*>([.\s\S]*?)<\/h3>/g, (match, p1) => `<h3>### ${p1}</h3>\n`)
      .replace(/<u>([.\s\S]*?)<\/u>/g, (match, p1) => `<u>__${p1}__</u>`)
      .replace(/<strong>([.\s\S]*?)<\/strong>/g, (match, p1) => `<strong>**${p1}**</strong>`)
      .replace(/<li.*?>([.\s\S]*?)<\/li.*?>/gm, (match, p1) => `<li>- ${p1.replace(/\n/gm, '')}</li>`)
      .replace(/<p[^>]*>([.\s\S]*?)<\/p>/g, (match, p1) => `<p>${p1}</p>\n`)
      .replace(/<a.*?href="([.\s\S]*?)".*?>([.\s\S]*?)<\/a>/g, (match, p1, p2) => `<a href="${p1}">[${p2}](${p1})</a>`),
      convertMentionFunction)).replace(/&gt;/gi, '>').replace(/&lt;/gi, '<');
  }
  if (!/<p[\s>]/i.test(value) && !none) return value;
  const html = (value || '').replace(/&amp;/gi, '&').replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/^<p[^>]*>/i, '').replace(/<p[^>]*>/gi, '\n').replace(/<\/p>/gi, '');
  if (none) return striptags(html).replace(/&gt;/gi, '>').replace(/&lt;/gi, '<');
  if (replaceBold) {
    const processedHtml = convertMention(convertToAscii(html
      .replace(/<a.*?href="([.\s\S]*?)".*?>([.\s\S]*?)<\/a>/g, (match, p1, p2) => `<a href="${p1}">${p1}</a>`)
      .replace(/<ul>/, '\n<ul>').replace(/<\/ul>\n/, '</ul>')
      .replace(/<li.*?>([.\s\S]*?)<\/li.*?>/gm, (match, p1) => `<li><p>- ${p1.replace(/\n/gm, '')}\n</p></li>`)), convertMentionFunction);
    return striptags(processedHtml).replace(/&gt;/gi, '>').replace(/&lt;/gi, '<').replace(/&𝗹𝘁;/gi, '<').replace(/&𝗴𝘁;/gi, '>').replace(/&g̲t̲;/gi, '>').replace(/&l̲t̲;/gi, '<');
  }
  return striptags(html, ['ul', 'li', 'h1', 'h2', 'h3']).replace(/&gt;/gi, '>').replace(/&lt;/gi, '<');
};
const convertImages = (value) => value.replace(/<img\b[^>]*>/gi, (match) => {
  const src = /\ssrc="(https?:\/\/[^"]*)"/i.exec(match)?.[1];
  const alt = /\salt="([^"]*)"/i.exec(match)?.[1];
  if (!src || src.includes('&quot;')) return '';
  return `<img src="${src}"${alt && !alt.includes('&quot;') ? ` alt="${alt}"` : ''}>`;
});
const convertMention = (value, process) => {
  if (!process) return value;
  return value.replace(/<span.*?data-mention-id="([.\s\S]*?)"[.\s\S]*?>([.\s\S]*?)<\/span>/gi, (match, id, name) => `<span>` + process(id, name) + `</span>`);
};
const convertToAscii = (value) => value
  .replace(/<strong>(.+?)<\/strong>/gi, (match, p1) => match.replace(p1, p1.split('').map((char) => bold?.[char] || char).join('')))
  .replace(/<u>(.+?)<\/u>/gi, (match, p1) => match.replace(p1, p1.split('').map((char) => underlineMap?.[char] || char).join('')));

const textSlicer = (integrationType, end, text) => {
  if (integrationType !== 'x') return { start: 0, end };
  const { validRangeEnd, valid } = twitter.parseTweet(text, { version: 3, maxWeightedTweetLength: end, scale: 100, defaultWeight: 200, emojiParsingEnabled: true, transformedURLLength: 23,
    ranges: [{ start: 0, end: 4351, weight: 100 }, { start: 8192, end: 8205, weight: 100 }, { start: 8208, end: 8223, weight: 100 }, { start: 8242, end: 8247, weight: 100 }] });
  return { start: 0, end: valid ? end : validRangeEnd };
};
const weightedLength = (text) => twitter.parseTweet(text).weightedLength;
const countLength = (integrationType, text) => integrationType === 'x' ? weightedLength(text) : integrationType === 'threads' ? new TextEncoder().encode(text).length : text.length;

const schemeUrl = /https?:\/\/(?:www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b(?:[-a-zA-Z0-9()@:%_\+.~#?&//=]*)/;
const bareDomainTlds = 'online|store|cloud|social|world|blog|shop|site|tech|news|live|link|info|app|dev|xyz|com|net|org|edu|gov|biz|io|co|ai|me|tv|cc|ly|gl|sh|fm|am|be|to|gg|so|is|us|uk|ca|au|de|fr|es|it|nl|se|no|dk|fi|pl|ch|at|ie|nz|za|in|jp|br|mx|ru|eu';
const bareDomain = new RegExp(`(?<![\\w@./-])(?:[a-zA-Z0-9-]+\\.)+(?:${bareDomainTlds})\\b(?:\\/[-a-zA-Z0-9()@:%_+.~#?&/=]*)?`);
const urlRegex = () => new RegExp(`(?:${schemeUrl.source})|(?:${bareDomain.source})`, 'gmi');
const hasLinks = (text) => !!(text || '').match(urlRegex());
const stripLinks = (text) => (text || '').replace(urlRegex(), '').replace(/<a\b[^>]*>\s*<\/a>/gi, '').replace(/[ \t]{2,}/g, ' ').replace(/ +\n/g, '\n').trim();

const ALLOWED_TAGS = ['p', 'br', 'strong', 'u', 'a', 'ul', 'li', 'h1', 'h2', 'h3', 'span', 'img'];
const ALLOWED_ATTR = ['dir', 'href', 'target', 'rel', 'class', 'data-mention-id', 'data-mention-label', 'src', 'alt'];
DOMPurify.addHook('uponSanitizeElement', (node, data) => {
  if (data.tagName === 'img' && !/^https?:\/\//i.test(node.getAttribute('src') || '')) node.parentNode?.removeChild(node);
});
const sanitizePostContent = (value) => (typeof value !== 'string' || !value) ? '' : DOMPurify.sanitize(value, { ALLOWED_TAGS, ALLOWED_ATTR, ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|\/|#)/i });
const postContentPlainText = (value) => {
  const walk = (nodes) => nodes.map((node) => node.nodeName === '#text' ? node.value : walk(node.childNodes || [])).join('');
  return walk(parseFragment(sanitizePostContent(value)).childNodes);
};
const getCookieUrlFromDomain = (domain) => { const url = parse(domain); return url.domain ? '.' + url.domain : url.hostname; };

const mention = (id, name) => `@[${name}](${id})`;
const out = { strip: [], stripTags: [], weighted: [], slicer: [], count: [], links: [], markdown: [], sanitize: [], cookie: [] };

const html = [
  '<p>Hello <strong>world</strong></p><p>Second &amp; line</p>',
  'Hello & <b>x</b> "q" \'s\' a b',
  '<p>Hi <strong>bold</strong> and <u>under</u></p><ul><li><p>one</p></li><li><p>two</p></li></ul><p>Link <a href="https://x.com/a?b=1&amp;c=2" target="_blank">site</a></p>',
  '<p>a &lt;tag&gt; b</p><p>c&nbsp;d</p><p></p>',
  '<h1>Title</h1><p>Text <strong>b</strong> <u>u</u> <a href="https://a.com">link</a></p><ul><li><p>x</p></li><li><p>y\nz</p></li></ul><h2 class="x">Sub</h2><h3>S3</h3>',
  '<p>Hello <span data-mention-id="123" data-mention-label="john" class="mention">@john</span> &amp; "quotes" it\'s</p><img src="https://img.com/a.png?x=1&amp;y=2" alt="pic"><img src="data:image/png;base64,xx"><img alt="no src">',
  '<p>Hello&nbsp;<strong>World</strong> &lt;3 \'x\' "y"</p>',
  '<p><strong>s</strong> <strong>&lt;tag&gt;</strong> <u>&gt;</u> <strong>a$&amp;b</strong></p>',
  '<p>a<b>c</p>d<p>x</p><script>alert("<p>")</script>a < b > c',
  '<p>Café 😀 — “quotes” 日本語</p><p>Line<br>break</p>',
  '<p dir="ltr">One</p>\n<p>Two <span data-mention-id="u1" data-mention-label="x">@x</span></p>',
  '<p>T <a href="https://a.com/x"   rel="noopener">A</a> and <a class="c" href="https://b.com">B</a></p>',
  'plain text no tags',
  '',
  '<P CLASS="x">Up</P><ul><li>no p</li></ul>',
  '<p><!-- comment -->x<textarea><b></textarea><style>p{}</style></p>',
];
const variants = [
  ['normal', false, false, false, false, false], ['normal', true, false, false, false, false], ['normal', false, true, false, false, false],
  ['normal', true, false, false, true, false], ['markdown', false, false, false, false, false], ['markdown', false, false, false, true, false],
  ['html', false, false, false, false, false], ['html', false, false, false, true, true], ['none', false, false, false, false, false],
  ['normal', false, false, true, false, false],
];
for (const val of html) for (const [type, replaceBold, none, plain, men, inline] of variants) {
  out.strip.push({ type, val, replaceBold, none, plain, mention: men, inlineImages: inline, want: stripHtmlValidation(type, val, replaceBold, none, plain, men ? mention : undefined, inline) });
}

for (const [h, allowed] of [
  ['<a href="x>y">t</a><!-- c --> <b>z</b> < x <<p>>', ['a']], ['<p>abc<span', []], ['<\nx < y', []], ['a<!-->b<!-- x -->c', []],
  ['<P>Up</P><br/><img src="a"/>', ['p', 'br']], ["<a title='it\"s'>q</a>", []], ['</ b>x<\tb>y', ['b']], ['<ul><li>1</li></ul><h4>h</h4>', ['ul', 'li']],
]) out.stripTags.push({ html: h, allowed, want: striptags(h, allowed) });

const texts = ['', 'hello', '日本語テキスト', '😀', '👨‍👩‍👧‍👦 family', '🇺🇸🇫🇷', '1️⃣ #️⃣', '❤️ ☺ ✔', 'https://example.com/very/long/path?x=1', 'visit sample.com today',
  'email me@sample.com', 'a.b', 't.co/abc', 'https://t.co/abcdef?x=1', 'é café', 'see example.co.uk/path and http://localhost:3000', 'x'.repeat(300),
  'Hello﻿world', '“smart” — dash…', 'www.google.com, foo.bar', 'Ünicode.com and xn--bcher-kva.com', 'a b', 'http://' + 'a'.repeat(70) + '.com', '#hashtag @mention $CASH',
  'mixed 日本 and emoji 🎉 and https://a.io',
  // JavaScript's /i folds case unlike Unicode lowercasing: İ, Ⱦ, Ʀ, Ι, ι, and Cyrillic and Greek variant forms in a TLD.
  'https://tr.wikipedia.org/w/index.php?search=\u0130stanbul', '\u0130https://example.com/a/long/path', 'https://example.com/path\u023E',
  'https://example.com/a\u01A6b', 'https://el.wikipedia.org/wiki/\u0399\u03C3\u03C4\u03BF\u03C1\u03AF\u03B1', 'https://пример.\u1C83айт/x',
  'https://el.wikipedia.org/wiki/\u03B9\u03C3\u03C4\u03BF\u03C1\u03AF\u03B1', 'https://παράδειγμα.\u03F5λ/a/long/path',
  // Punycode and the bare-domain search use the domain as written, not its stand-ins.
  'https://\u0399' + 'a'.repeat(55) + '.com/x', 'see \u00C0a.comx\u0436\u2C65a.com now',
  // NFC past 30 combining marks in a row: no U+034F, and a mark of a higher class still composes.
  'a' + '\u0301'.repeat(40), 'a' + '\u0316'.repeat(30) + '\u0301', 'x' + '\u0301'.repeat(31) + '\u1100\u1161\u11A8',
  'a\u030D' + '\u0316\u0301'.repeat(15)];
for (const t of texts) out.weighted.push({ text: t, want: weightedLength(t) });
for (const [type, end, t] of [['x', 280, 'a'.repeat(300)], ['x', 10, '日本語日本語日本語'], ['x', 280, 'short'], ['linkedin', 3000, 'a'.repeat(4000)],
  ['x', 25, 'see https://example.com/a/b/c and more text here'], ['x', 5, '😀😀😀😀'], ['x', 4, 'ééééé'], ['x', 280, ''],
  ['x', 30, 'a' + '\u0301'.repeat(40) + 'bc']])
  out.slicer.push({ type, end, text: t, want: textSlicer(type, end, t).end });
for (const [type, t] of [['threads', 'héllo😀'], ['linkedin', 'héllo😀'], ['x', 'héllo😀 https://a.com'], ['bluesky', '日本']]) out.count.push({ type, text: t, want: countLength(type, t) });

for (const t of ['Check https://sample.com/x now', 'visit sample.com today', 'mail me at user@sample.com', 'path a/b.com', 'no links here', '<a href="https://x.com">https://x.com</a> after',
  'multiple  spaces https://a.io  here \nnext', 'bit.ly/abc', 'sub.domain.co.uk/path', 'version 1.2.3', 'example.comma', 'see.it', '  EXAMPLE.COM/A  ', 'v1.2 api.dev/x?y=1', 'hello.world', '-x.com _y.com .z.com'])
  out.links.push({ text: t, has: hasLinks(t), strip: stripLinks(t) });

for (const t of ['# Title\n\n**bold** and _it_ and `code`\n- item\n* star\n1. num\n> quote\n[link](http://x)\n![alt](img.png)\n~~strike~~\n---\n',
  'Setext\n===\nmore', '```\ncode\n```\nafter', '## Heading ##\ntext', 'snake_case_word and __dunder__', '<b>html</b> text', '[^1]: note\nref [a]: http://x', 'a *b* c **d** e ***f***',
  '~single~ tilde', '  [id]: http://example.com "Title"', 'a\r\n# h\r\n- x']) out.markdown.push({ text: t, want: removeMd(t) });

for (const v of ['<p dir="ltr">Hi <span data-mention-id="1" data-mention-label="a" class="m">@a</span></p>', '<a href="javascript:alert(1)" target="_blank" rel="noopener">x</a>',
  '<a href="https://x.com" target="_blank">x</a>', '<img src="data:image/png;base64,aa"><p>t</p>', '<img src="https://x.com/a.png" onerror="x" alt="a">', '<script>alert(1)</script><p>ok</p>',
  '<div><b>bold</b> text</div>', '  <p>lead</p>', 'a & b', '<style>p{}</style><p>a</p>', '<p>&lt;b&gt;<!--c--></p>', '<svg><a href="#">x</a></svg>y',
  '<p data-foo="1" aria-label="x" id="y" title="t">z</p>', '<table><tr><td>cell</td></tr></table>', '<p>a&nbsp;b &amp; c &lt;d&gt;</p>', '<template><p>t</p></template>x',
  '<a href=" https://x.com ">x</a>', '<img src=" https://x.com/a.png">', '<P CLASS="x">U</P>', '<a href="https://a" href="javascript:x">d</a>', '<h4>h4</h4><br><ul><li>1</li></ul>',
  '<p>x</p><!-- <b> -->', '<a href="mailto:a@b.c">m</a><a href="/rel">r</a><a href="#h">h</a><a href="ftp://x">f</a>', '<span class="a" style="color:red">s</span>', '<p>a</p>\n<p>b</p>', '',
  '<math><mi>x</mi></math>z', '<p><textarea>&lt;b&gt;</textarea></p>', '<noscript><p>n</p></noscript>k', '<title>t</title><p>after</p>', '<frameset></frameset>', '<p>x "q"</p>'])
  out.sanitize.push({ value: v, want: sanitizePostContent(v), plain: postContentPlainText(v) });

for (const d of ['https://app.sample.com', 'http://localhost:4200', 'http://127.0.0.1:3000', 'https://example.co.uk', 'https://foo.vercel.app', 'https://a.b.example.com/path', 'sample.com',
  'localhost', 'https://app.localhost:3000', 'https://APP.Example.COM.', 'https://x.github.io']) out.cookie.push({ domain: d, want: getCookieUrlFromDomain(d) });

process.stdout.write(JSON.stringify(out, null, 1) + '\n');
