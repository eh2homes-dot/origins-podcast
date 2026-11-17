// Origins podcast site.
// Every page is built here from two sources:
//   1. The beehiiv podcast feed (FEED_URL): title, description, date, audio, runtime.
//   2. Optional per-episode extras in public/data/episodes/<number>.json:
//      YouTube video, chapters, guest, show notes, transcript, roles.
// Settings (links, feed address, launch switch) live in wrangler.jsonc.

const FEED_CACHE_SECONDS = 600;

// ---------- small helpers ----------

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Only http(s) links are ever written into a page.
const safeUrl = (value) => (/^https?:\/\//i.test(String(value ?? '').trim()) ? String(value).trim() : '');

const decodeEntities = (s) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');

const unwrap = (s) => {
  const cdata = s.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return cdata ? cdata[1] : decodeEntities(s);
};

const tagText = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? unwrap(m[1]).trim() : '';
};

const tagAttr = (xml, name, attr) => {
  const m = xml.match(new RegExp(`<${name}\\s[^>]*?${attr}\\s*=\\s*["']([^"']*)["']`, 'i'));
  return m ? decodeEntities(m[1]) : '';
};

// Feed descriptions arrive as HTML. Turn them into plain paragraphs.
const toParagraphs = (html) =>
  decodeEntities(
    html
      .replace(/<\s*(br|\/p|\/div|\/li|\/h\d)\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean);

const slugify = (s) =>
  s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70);

const formatDate = (date) =>
  date && !isNaN(date) ? date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '';

const formatRuntime = (raw) => {
  if (!raw) return '';
  const parts = String(raw).split(':').map(Number);
  if (parts.some(isNaN)) return '';
  const seconds = parts.reduce((total, n) => total * 60 + n, 0);
  return seconds >= 60 ? `${Math.round(seconds / 60)} min` : '';
};

const toSeconds = (stamp) =>
  String(stamp ?? '').split(':').map(Number).reduce((total, n) => total * 60 + (isNaN(n) ? 0 : n), 0);

const pad2 = (n) => String(n).padStart(2, '0');

// ---------- feed ----------

export function parseFeed(xml) {
  const items = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  const episodes = items.map((item) => {
    const title = tagText(item, 'title');
    const body = tagText(item, 'content:encoded') || tagText(item, 'description') || tagText(item, 'itunes:summary');
    return {
      title,
      paragraphs: toParagraphs(body),
      date: new Date(tagText(item, 'pubDate')),
      audio: safeUrl(tagAttr(item, 'enclosure', 'url')),
      runtime: formatRuntime(tagText(item, 'itunes:duration')),
      number: parseInt(tagText(item, 'itunes:episode'), 10) || null,
      type: tagText(item, 'itunes:episodeType') || 'full',
      image: safeUrl(tagAttr(item, 'itunes:image', 'href'))
    };
  }).filter((ep) => ep.title && ep.type !== 'trailer');

  // Oldest first, so episodes without a number in the feed still count up from 1.
  episodes.sort((a, b) => a.date - b.date);
  episodes.forEach((ep, i) => {
    if (!ep.number) ep.number = i + 1;
    ep.slug = `${ep.number}-${slugify(ep.title)}`;
    ep.summary = ep.paragraphs[0] || '';
  });
  return episodes.reverse(); // newest first
}

async function getEpisodes(env, ctx) {
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const cacheKey = new Request('https://feed-cache.internal/episodes');
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return (await hit.json()).map((ep) => ({ ...ep, date: new Date(ep.date) }));
  }
  let episodes = [];
  try {
    const res = await fetch(env.FEED_URL, { headers: { 'user-agent': 'origins-podcast-site' } });
    if (res.ok) episodes = parseFeed(await res.text());
  } catch (err) {
    console.log('Feed fetch failed:', err.message);
  }
  if (cache && episodes.length) {
    const stored = new Response(JSON.stringify(episodes), {
      headers: { 'content-type': 'application/json', 'cache-control': `max-age=${FEED_CACHE_SECONDS}` }
    });
    ctx.waitUntil(cache.put(cacheKey, stored));
  }
  return episodes;
}

// Per-episode extras: public/data/episodes/<number>.json. Missing file = no extras.
async function getExtras(env, request, number) {
  try {
    const res = await env.ASSETS.fetch(new URL(`/data/episodes/${number}.json`, request.url));
    if (!res.ok) return {};
    const data = await res.json();
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

// ---------- shared layout ----------

const PLAY_ICON = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16"><path d="M3 1.5v13l11-6.5z" fill="currentColor"/></svg>';

function listenButtons(env, { primary = true } = {}) {
  const links = [
    [env.YOUTUBE_URL, `${PLAY_ICON}Watch on YouTube`, primary ? 'btn btn-pink' : 'btn'],
    [env.SPOTIFY_URL, 'Spotify', 'btn'],
    [env.APPLE_URL, 'Apple Podcasts', 'btn']
  ];
  return links
    .filter(([url]) => safeUrl(url))
    .map(([url, label, cls]) => `<a class="${cls}" href="${esc(safeUrl(url))}">${label}</a>`)
    .join('');
}

function layout(env, { title, description, path, body, image }) {
  const nav = [['/episodes', 'Episodes'], ['/about', 'About'], ['/guest', 'Be a guest'], ['/sponsor', 'Sponsor']]
    .map(([href, label]) => `<a href="${href}"${path.startsWith(href) ? ' aria-current="page"' : ''}>${label}</a>`)
    .join('');
  const footLinks = (pairs) => pairs.filter(([url]) => url).map(([url, label]) => `<a href="${esc(url)}">${label}</a>`).join('');
  const fullTitle = title ? `${title} · Origins` : 'Origins: How Leaders Got Their Start';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(fullTitle)}</title>
<meta name="description" content="${esc(description)}">
<meta name="theme-color" content="#151214">
<meta property="og:title" content="${esc(fullTitle)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${esc(image || '/assets/cover.jpg')}">
<meta name="twitter:card" content="summary_large_image">
${env.SITE_LIVE === 'true' ? '' : '<meta name="robots" content="noindex, nofollow">'}
<link rel="alternate" type="application/rss+xml" title="Origins podcast" href="${esc(env.FEED_URL)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Anton&family=Space+Grotesk:wght@400;500;700&family=Yellowtail&display=swap">
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="wrap site-head">
<a class="logo" href="/" aria-label="Origins home">Origins</a>
<nav aria-label="Main">${nav}<a class="btn btn-mint" href="/#listen">Listen</a></nav>
</header>
<main id="main">
${body}
</main>
<footer class="site-foot">
<div class="wrap">
<div class="stack" style="max-width:360px;gap:8px">
<a class="logo" href="/">Origins</a>
<div class="muted">How Leaders Got Their Start. A Property and Technology production.</div>
</div>
<div class="cols">
<div class="col"><b>The show</b><a href="/episodes">Episodes</a><a href="/about">About</a><a href="/guest">Be a guest</a><a href="/sponsor">Sponsor</a></div>
<div class="col"><b>Listen</b>${footLinks([[safeUrl(env.YOUTUBE_URL), 'YouTube'], [safeUrl(env.SPOTIFY_URL), 'Spotify'], [safeUrl(env.APPLE_URL), 'Apple Podcasts'], [safeUrl(env.FEED_URL), 'RSS feed']])}</div>
<div class="col"><b>More</b>${footLinks([[safeUrl(env.NEWSLETTER_URL), 'Origins newsletter'], [safeUrl(env.JOBS_URL), 'Job board'], [safeUrl(env.HUB_URL), 'Property and Technology']])}</div>
</div>
</div>
</footer>
<script src="/site.js" defer></script>
</body>
</html>`;
}

const page = (html, status = 200) =>
  new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' } });

const episodeRow = (ep) => `<a class="ep-row" href="/episodes/${esc(ep.slug)}">
<span class="ep-num">EP. ${pad2(ep.number)}</span>
<span class="ep-main"><span class="ep-title">${esc(ep.title)}</span></span>
<span class="muted">${esc([formatDate(ep.date), ep.runtime].filter(Boolean).join(' · '))}</span>
</a>`;

const newsletterCta = (env) => `<section class="wrap" style="padding-top:56px;padding-bottom:32px">
<div class="cta">
<div class="stack" style="gap:10px">
<h2 class="display">Get the roles before the roundup</h2>
<p>The Origins newsletter sends the best open roles in property and technology every week. The podcast only has time for a few.</p>
<a href="${esc(safeUrl(env.JOBS_URL))}">Browse the job board</a>
</div>
<form class="stack" style="gap:10px" action="${esc(safeUrl(env.NEWSLETTER_URL))}subscribe" method="get">
<label for="nl-email">Email address</label>
<div class="row"><input id="nl-email" name="email" type="email" required placeholder="you@company.com" autocomplete="email"><button class="btn btn-ink" type="submit">Subscribe</button></div>
</form>
</div>
</section>`;

// ---------- pages ----------

const SHOW_PITCH = 'Founders and executives in property and technology on their first break, the moves that shaped their careers, and who they’re hiring now. Hosted by Evan Howard.';

function homePage(env, episodes) {
  const latest = episodes[0];
  const latestBand = latest
    ? `<section class="band"><div class="wrap">
<a href="/episodes/${esc(latest.slug)}" aria-label="Watch ${esc(latest.title)}"><img class="frame cover" style="aspect-ratio:16/9;border-color:#151214" src="${esc(latest.image || '/assets/cover.jpg')}" alt=""></a>
<div class="stack" style="gap:14px">
<div class="kicker">Latest episode · EP. ${pad2(latest.number)}${latest.date && !isNaN(latest.date) ? ' · ' + esc(formatDate(latest.date)) : ''}${latest.runtime ? ' · ' + esc(latest.runtime) : ''}</div>
<h2 class="display" style="font-size:clamp(34px,4.4vw,48px)">${esc(latest.title)}</h2>
<p style="margin:0">${esc(latest.summary)}</p>
<div class="row"><a class="btn btn-ink" href="/episodes/${esc(latest.slug)}">Watch the episode</a></div>
</div>
</div></section>`
    : `<section class="band"><div class="wrap">
<div class="stack" style="gap:14px">
<div class="kicker">Coming soon</div>
<h2 class="display" style="font-size:clamp(34px,4.4vw,48px)">Episode 01 is on the way</h2>
<p style="margin:0">New episodes every other Wednesday. Get the Origins newsletter and you will hear about the first one the day it drops.</p>
<div class="row"><a class="btn btn-ink" href="${esc(safeUrl(env.NEWSLETTER_URL))}">Get the newsletter</a></div>
</div>
</div></section>`;

  const list = episodes.length
    ? episodes.slice(0, 5).map(episodeRow).join('')
    : '<p class="soft">No episodes yet. The first one is being recorded.</p>';

  return layout(env, {
    title: '',
    description: SHOW_PITCH,
    path: '/',
    body: `<section class="wrap hero">
<div class="stack" style="gap:24px">
<div class="kicker">The podcast · Every other Wednesday</div>
<h1 class="display">How leaders got their <span class="pink">start.</span></h1>
<p class="lede" style="max-width:520px">${SHOW_PITCH}</p>
<div class="row" id="listen">${listenButtons(env)}</div>
</div>
<div><img class="frame cover" src="/assets/cover.jpg" alt="Origins cover art: a cowboy leaning on a half-chrome horse on a desert road under a pink sky, beside a neon Origins sign"></div>
</section>
${latestBand}
<section class="wrap section stack" style="gap:32px">
<h2 class="display">Every episode, three things</h2>
<div class="cards">
<div class="card"><div class="num">01</div><h3>The first break</h3><p>Where it started: the first job, the first deal, the person who took a chance.</p></div>
<div class="card"><div class="num">02</div><h3>The moves that mattered</h3><p>The handful of decisions that changed the path, told by the person who made them.</p></div>
<div class="card"><div class="num">03</div><h3>Who’s hiring now</h3><p>A quick roundup of the best open roles from the Origins newsletter closes every show.</p></div>
</div>
</section>
<section class="wrap section">
<div class="section-head"><h2 class="display">Episodes</h2>${episodes.length > 5 ? '<a href="/episodes"><b>All episodes</b></a>' : ''}</div>
${list}
</section>
${newsletterCta(env)}
<section class="wrap cards" style="padding-top:32px">
<div class="card" style="padding:36px;gap:14px"><h2 class="display" style="font-size:36px">Be a guest</h2><p>Built or led something in property and technology? Tell us how you got your start, or nominate someone whose story should be heard.</p><a class="btn btn-mint" href="/guest">Nominate a guest</a></div>
<div class="card" style="padding:36px;gap:14px"><h2 class="display" style="font-size:36px">Sponsor the show</h2><p>Put your company in front of the founders, executives and operators who listen.</p><a class="btn" href="/sponsor">Ask about sponsoring</a></div>
</section>`
  });
}

function episodesPage(env, episodes) {
  return layout(env, {
    title: 'Episodes',
    description: 'Every episode of Origins: How Leaders Got Their Start.',
    path: '/episodes',
    body: `<section class="wrap page-head stack">
<div class="kicker">Episodes</div>
<h1 class="display">Every origin <span class="pink">story.</span></h1>
</section>
<section class="wrap">${episodes.length ? episodes.map(episodeRow).join('') : '<p class="soft">No episodes yet. The first one is being recorded.</p>'}</section>
${newsletterCta(env)}`
  });
}

function episodePage(env, episodes, ep, extras) {
  const index = episodes.indexOf(ep);
  const newer = episodes[index - 1];
  const older = episodes[index + 1];
  const youtubeId = /^[\w-]{6,20}$/.test(extras.youtubeId || '') ? extras.youtubeId : '';
  const watchUrl = youtubeId ? `https://www.youtube.com/watch?v=${youtubeId}` : '';
  const poster = youtubeId ? `https://i.ytimg.com/vi/${youtubeId}/maxresdefault.jpg` : ep.image || '/assets/cover.jpg';
  const tags = Array.isArray(extras.tags) ? extras.tags : [];
  const chapters = Array.isArray(extras.chapters) ? extras.chapters : [];
  const notes = Array.isArray(extras.notes) ? extras.notes : [];
  const roles = Array.isArray(extras.roles) ? extras.roles : [];
  const guest = extras.guest && extras.guest.name ? extras.guest : null;

  const video = youtubeId
    ? `<div class="video frame"><a href="${watchUrl}" data-youtube="${youtubeId}" aria-label="Play episode ${ep.number}: ${esc(ep.title)}"><img src="${esc(poster)}" alt=""><svg aria-hidden="true" width="110" height="110" viewBox="0 0 110 110"><circle cx="55" cy="55" r="52" fill="#151214" stroke="#ff4f96" stroke-width="4"/><path d="M45 34v42l34-21z" fill="#ff4f96"/></svg></a></div>`
    : ep.audio
      ? `<div class="frame" style="padding:28px;background:#211c20"><audio controls preload="none" src="${esc(ep.audio)}" style="width:100%"></audio></div>`
      : '';

  const listen = [
    watchUrl && `<a class="btn btn-pink" href="${watchUrl}">${PLAY_ICON}Watch on YouTube</a>`,
    safeUrl(env.SPOTIFY_URL) && `<a class="btn" href="${esc(safeUrl(env.SPOTIFY_URL))}">Spotify</a>`,
    safeUrl(env.APPLE_URL) && `<a class="btn" href="${esc(safeUrl(env.APPLE_URL))}">Apple Podcasts</a>`,
    ep.audio && `<a href="${esc(ep.audio)}" style="font-weight:700;padding:14px 8px">Download the audio</a>`
  ].filter(Boolean).join('');

  const chapterList = chapters.length
    ? `<div><h2 class="display" style="font-size:36px;margin-bottom:12px">Chapters</h2>${chapters.map((c) => {
        const seconds = toSeconds(c.time);
        const href = watchUrl ? `${watchUrl}&t=${seconds}s` : '#';
        return `<a class="chapter" href="${href}"><b>${esc(c.time)}</b><span>${esc(c.title)}</span></a>`;
      }).join('')}</div>`
    : '';

  const showNotes = `<div class="stack" style="gap:14px"><h2 class="display" style="font-size:36px">Show notes</h2>
${(ep.paragraphs.length > 1 ? ep.paragraphs.slice(1) : ep.paragraphs).map((p) => `<p class="soft" style="margin:0">${esc(p)}</p>`).join('')}
${notes.length ? `<ul class="soft" style="margin:0;padding-left:22px">${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}</div>`;

  const transcript = extras.transcript
    ? `<details><summary>Full transcript</summary><p class="muted" style="margin:0 0 12px">Auto-generated, so it may contain errors.</p><p class="transcript">${esc(extras.transcript)}</p></details>`
    : '';

  const person = (p, role) => `<div class="person">${safeUrl(p.photo) || /^\/[\w./-]+$/.test(p.photo || '') ? `<img src="${esc(p.photo)}" alt="">` : ''}<div><b>${esc(p.name)}</b><span class="muted">${esc(role)}</span>${safeUrl(p.linkedin) ? `<a href="${esc(safeUrl(p.linkedin))}" style="padding:6px 0">LinkedIn</a>` : ''}</div></div>`;

  const people = `<div class="card" style="gap:18px;align-items:stretch"><h2 class="kicker" style="margin:0">In this episode</h2>
${guest ? person(guest, [guest.title, guest.company].filter(Boolean).join(', ')) : ''}
${person({ name: 'Evan Howard', linkedin: 'https://www.linkedin.com/in/evanprothrohoward' }, 'Host, Property and Technology')}</div>`;

  const rolesBox = roles.length
    ? `<div class="box box-mint" id="roles" style="gap:6px"><h2 class="display" style="font-size:28px;margin-bottom:8px">Roles from this week’s roundup</h2>
${roles.map((r) => `<a class="role" href="${esc(safeUrl(r.url) || safeUrl(env.JOBS_URL))}"><b>${esc(r.title)}</b><span>${esc([r.company, r.location].filter(Boolean).join(' · '))}</span></a>`).join('')}
<a href="${esc(safeUrl(env.JOBS_URL))}" style="font-weight:700;padding:12px 0 0;border-top:2px solid #151214;align-self:stretch">See every open role on the job board</a></div>`
    : `<div class="box box-mint"><h2>Hiring in property and technology?</h2><p>Every episode closes with a roundup of open roles from the Origins newsletter.</p><a href="${esc(safeUrl(env.JOBS_URL))}"><b>See the job board</b></a></div>`;

  return layout(env, {
    title: `EP. ${pad2(ep.number)}: ${ep.title}`,
    description: ep.summary.slice(0, 200),
    path: '/episodes',
    image: poster,
    body: `<section class="wrap stack" style="padding-top:16px;padding-bottom:40px">
<nav aria-label="Breadcrumb" class="muted"><a href="/episodes">Episodes</a> / EP. ${pad2(ep.number)}</nav>
<div class="kicker">${esc([`Episode ${pad2(ep.number)}`, formatDate(ep.date), ep.runtime].filter(Boolean).join(' · '))}</div>
<h1 class="display" style="max-width:980px;font-size:clamp(40px,5.6vw,76px)">${esc(ep.title)}</h1>
${ep.summary ? `<p class="lede" style="max-width:760px">${esc(ep.summary)}</p>` : ''}
${tags.length ? `<div class="tags">${tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
</section>
<section class="wrap" style="padding-bottom:32px">
${video}
<div class="row" style="margin-top:32px">${listen}</div>
</section>
<section class="wrap split" style="padding-top:40px;padding-bottom:72px">
<div class="main stack" style="gap:56px">${chapterList}${showNotes}${transcript}</div>
<aside>${people}${rolesBox}
<div class="box"><h2>Know someone with a story?</h2><p class="soft">Every guest names who we should talk to next. You can too.</p><a href="/guest"><b>Nominate a guest</b></a></div>
</aside>
</section>
<section class="pager"><div class="wrap">
${older ? `<a href="/episodes/${esc(older.slug)}">Older · EP. ${pad2(older.number)}</a>` : '<a href="/episodes">All episodes</a>'}
${newer ? `<a href="/episodes/${esc(newer.slug)}">Newer · EP. ${pad2(newer.number)}</a>` : '<a href="/episodes">All episodes</a>'}
</div></section>`
  });
}

function aboutPage(env) {
  return layout(env, {
    title: 'About',
    description: SHOW_PITCH,
    path: '/about',
    body: `<section class="wrap page-head stack">
<div class="kicker">About the show</div>
<h1 class="display" style="max-width:900px">Origins: how leaders got their <span class="pink">start.</span></h1>
<p class="lede">Founders and executives in property and technology share how they got their start: the first break, the moves that shaped their careers, and who they’re hiring now.</p>
</section>
<section class="wrap" style="padding-bottom:72px"><img class="frame cover" src="/assets/cover.jpg" alt="Origins cover art: a cowboy leaning on a half-chrome horse on a desert road under a pink sky"></section>
<section class="wrap stack" style="gap:28px;padding-bottom:72px">
<h2 class="display">How an episode runs</h2>
<div class="cards">
<div class="card"><div class="num">01</div><h3>The origin story</h3><p>A long-form interview built around the moments that changed the guest’s path.</p></div>
<div class="card"><div class="num">02</div><h3>Quick-fire and close</h3><p>A quick-fire round, a closing ritual, and the guest names who we should talk to next.</p></div>
<div class="card"><div class="num">03</div><h3>Jobs roundup</h3><p>A short roundup of the best open roles from the Origins newsletter, recorded fresh each release week.</p></div>
</div>
</section>
<section class="band"><div class="wrap">
<div class="stack" style="gap:12px">
<div class="kicker">Your host</div>
<h2 class="display" style="font-size:48px">Evan Howard</h2>
<p style="margin:0;font-size:19px">Evan runs Property and Technology, home of the Origins newsletter and the Founders &amp; Friends job board.</p>
<a href="https://www.linkedin.com/in/evanprothrohoward">Evan on LinkedIn</a>
</div>
</div></section>
<section class="wrap section stack" style="gap:28px">
<h2 class="display">New episodes every other Wednesday</h2>
<div class="row">${listenButtons(env)}<a href="${esc(safeUrl(env.NEWSLETTER_URL))}" style="font-weight:700;padding:14px 8px">Get the Origins newsletter</a></div>
</section>`
  });
}

const field = (id, label, { type = 'text', placeholder = '', hint = '', area = false, required = false, autocomplete = '' } = {}) =>
  `<div class="field"><label for="${id}">${label}</label>${hint ? `<span class="hint">${hint}</span>` : ''}${
    area
      ? `<textarea id="${id}" name="${id}" rows="5" maxlength="3000"${required ? ' required' : ''}></textarea>`
      : `<input id="${id}" name="${id}" type="${type}" maxlength="300" placeholder="${placeholder}"${required ? ' required' : ''}${autocomplete ? ` autocomplete="${autocomplete}"` : ''}>`
  }</div>`;

// Hidden field real people never fill in; bots do.
const HONEYPOT = '<div class="hp" aria-hidden="true"><label for="website2">Leave this empty</label><input id="website2" name="website2" type="text" tabindex="-1" autocomplete="off"></div>';

function guestPage(env) {
  return layout(env, {
    title: 'Be a guest',
    description: 'Nominate yourself or another leader in property and technology for the Origins podcast.',
    path: '/guest',
    body: `<section class="wrap page-head stack">
<div class="kicker">Be a guest</div>
<h1 class="display" style="max-width:900px">Tell us how you got your <span class="pink">start.</span></h1>
<p class="lede">Origins is a conversation about the handful of moments that changed your path. Put yourself forward, or nominate a leader in property and technology whose story should be heard.</p>
</section>
<section class="wrap split">
<form class="main formbox" action="/api/guest" method="post" data-api>
<h2 class="display" style="font-size:36px">Nominate a guest</h2>
<fieldset><legend>Who are you nominating?</legend>
<label class="radio"><input type="radio" name="nominating" value="Myself" checked>Myself</label>
<label class="radio"><input type="radio" name="nominating" value="Someone else">Someone else</label></fieldset>
<div class="two">${field('guest_name', 'Guest name', { required: true })}${field('company_title', 'Company and title', { required: true })}</div>
<div class="two">${field('linkedin', 'Guest LinkedIn', { type: 'url', placeholder: 'https://linkedin.com/in/' })}${field('email', 'Your email', { type: 'email', placeholder: 'you@company.com', required: true, autocomplete: 'email' })}</div>
${field('why', 'Why this story?', { area: true, required: true, hint: 'The first break, a turning point, a risk that paid off. A few sentences is plenty.' })}
${HONEYPOT}
<button class="btn btn-pink" type="submit">Send nomination</button>
<p class="hint" role="status" aria-live="polite" style="margin:0">We read every nomination. If it is a fit, you will hear from us to book a time.</p>
</form>
<aside>
<div class="box box-mint"><h2>What to expect</h2><ol><li>A short prep call or email so we know your story.</li><li>A recorded conversation with Evan, remote or in person.</li><li>You preview the clips before they go out.</li><li>A share kit on release day.</li></ol></div>
<div class="box"><h2>The conversation</h2><p class="soft">Your origin story, a quick-fire round, a closing ritual, and one question we ask everyone: who should we talk to next?</p></div>
</aside>
</section>`
  });
}

function sponsorPage(env) {
  return layout(env, {
    title: 'Sponsor',
    description: 'Ask about sponsoring the Origins podcast.',
    path: '/sponsor',
    body: `<section class="wrap page-head stack">
<div class="kicker">Sponsor the show</div>
<h1 class="display" style="max-width:900px">Reach the people building property and <span class="pink">technology.</span></h1>
<p class="lede">Origins listeners are founders, executives and operators across property and technology. Sponsoring puts your company in the conversation they chose to spend an hour with.</p>
</section>
<section class="wrap split">
<form class="main formbox" action="/api/sponsor" method="post" data-api>
<h2 class="display" style="font-size:36px">Ask about sponsoring</h2>
<div class="two">${field('name', 'Your name', { required: true, autocomplete: 'name' })}${field('email', 'Work email', { type: 'email', placeholder: 'you@company.com', required: true, autocomplete: 'email' })}</div>
<div class="two">${field('company', 'Company', { required: true, autocomplete: 'organization' })}${field('website', 'Company website', { type: 'url', placeholder: 'https://' })}</div>
${field('goal', 'What are you hoping to get out of it?', { area: true, hint: 'Hiring, product awareness, a launch. Whatever you are working toward.' })}
${HONEYPOT}
<button class="btn btn-pink" type="submit">Send inquiry</button>
<p class="hint" role="status" aria-live="polite" style="margin:0">Evan replies to every sponsor inquiry personally.</p>
</form>
<aside>
<div class="box box-mint"><h2>What happens next</h2><ol><li>Your note goes straight to Evan.</li><li>He replies to talk through what you are working toward.</li><li>If it is a fit, you shape the sponsorship together.</li></ol></div>
</aside>
</section>`
  });
}

function messagePage(env, status, heading, text) {
  return page(layout(env, {
    title: heading,
    description: text,
    path: '',
    body: `<section class="wrap page-head stack" style="padding-bottom:120px"><h1 class="display">${esc(heading)}</h1><p class="lede">${esc(text)}</p><div class="row"><a class="btn btn-mint" href="/">Back to the show</a></div></section>`
  }), status);
}

// ---------- forms ----------

const FORMS = {
  guest: {
    table: 'Guest nominations',
    required: ['guest_name', 'company_title', 'email', 'why'],
    fields: { nominating: 'Nominating', guest_name: 'Guest name', company_title: 'Company and title', linkedin: 'LinkedIn', email: 'Submitter email', why: 'Why this story' },
    thanks: 'Thanks. Your nomination is in, and we read every one.'
  },
  sponsor: {
    table: 'Sponsor inquiries',
    required: ['name', 'email', 'company'],
    fields: { name: 'Name', email: 'Email', company: 'Company', website: 'Website', goal: 'Goal' },
    thanks: 'Thanks. Evan will get back to you personally.'
  }
};

async function handleForm(request, env, kind) {
  const form = FORMS[kind];
  const wantsJson = (request.headers.get('accept') || '').includes('application/json');
  const reply = (status, text) =>
    wantsJson
      ? Response.json(status < 400 ? { message: text } : { error: text }, { status })
      : messagePage(env, status, status < 400 ? 'Got it.' : 'That did not go through.', text);

  let data = {};
  try {
    data = (request.headers.get('content-type') || '').includes('application/json')
      ? await request.json()
      : Object.fromEntries(await request.formData());
  } catch {
    return reply(400, 'We could not read that form. Please try again.');
  }

  if (data.website2) return reply(200, form.thanks); // bot filled the hidden field: pretend it worked

  const record = {};
  for (const [key, column] of Object.entries(form.fields)) {
    const value = String(data[key] ?? '').trim().slice(0, 3000);
    if (value) record[column] = value;
  }
  for (const key of form.required) {
    if (!record[form.fields[key]]) return reply(400, 'Please fill in every required field.');
  }
  const emailColumn = form.fields.email;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(record[emailColumn])) return reply(400, 'That email address does not look right.');

  const fallback = `We could not save that just now. Please email ${env.CONTACT_EMAIL} instead.`;
  if (!env.AIRTABLE_TOKEN || !env.AIRTABLE_BASE_ID) {
    console.log('Form received but Airtable is not configured.');
    return reply(503, fallback);
  }
  try {
    const res = await fetch(`https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${encodeURIComponent(form.table)}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.AIRTABLE_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ records: [{ fields: record }], typecast: true })
    });
    if (!res.ok) {
      console.log('Airtable rejected the record:', res.status, await res.text());
      return reply(502, fallback);
    }
  } catch (err) {
    console.log('Airtable request failed:', err.message);
    return reply(502, fallback);
  }
  return reply(200, form.thanks);
}

// ---------- router ----------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'POST') {
      if (path === '/api/guest') return handleForm(request, env, 'guest');
      if (path === '/api/sponsor') return handleForm(request, env, 'sponsor');
      return new Response('Not found', { status: 404 });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });

    if (path === '/robots.txt') {
      return new Response(env.SITE_LIVE === 'true' ? 'User-agent: *\nAllow: /\n' : 'User-agent: *\nDisallow: /\n', { headers: { 'content-type': 'text/plain' } });
    }
    if (path === '/about') return page(aboutPage(env));
    if (path === '/guest') return page(guestPage(env));
    if (path === '/sponsor') return page(sponsorPage(env));
    if (path === '/rss' || path === '/feed') return Response.redirect(env.FEED_URL, 302);

    if (path === '/' || path === '/episodes' || path.startsWith('/episodes/')) {
      const episodes = await getEpisodes(env, ctx);
      if (path === '/') return page(homePage(env, episodes));
      if (path === '/episodes') return page(episodesPage(env, episodes));

      // /episodes/3-anything matches episode 3, so a retitled episode keeps its old links.
      const number = parseInt(path.slice('/episodes/'.length), 10);
      const ep = episodes.find((e) => e.number === number);
      if (ep) {
        if (path !== `/episodes/${ep.slug}`) return Response.redirect(new URL(`/episodes/${ep.slug}`, url).toString(), 301);
        return page(episodePage(env, episodes, ep, await getExtras(env, request, ep.number)));
      }
    }
    return messagePage(env, 404, 'Nothing here.', 'That page does not exist. Head back to the show.');
  }
};
