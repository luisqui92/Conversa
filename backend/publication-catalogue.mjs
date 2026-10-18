import { createHash } from 'node:crypto';
import { graphOrigin } from './instagram-connection.mjs';
import { facebookGraph } from './facebook-connection.mjs';

const text = (value, limit) => (typeof value === 'string' ? value.slice(0, limit) : '');
export function publicationUrl(value, image = false) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const allowed = image
      ? ['fbcdn.net', 'cdninstagram.com'].some((domain) => host.endsWith('.' + domain))
      : [
          'facebook.com',
          'www.facebook.com',
          'm.facebook.com',
          'instagram.com',
          'www.instagram.com',
        ].includes(host);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      !allowed ||
      url.searchParams.has('access_token')
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

// Only metadata is cached. Every HTTP route checks ownership before using this service.
export function createPublicationCatalogue({ request = fetch, now = Date.now } = {}) {
  const cache = new Map();
  async function load(config, rules) {
    const facebook = config.channel === 'facebook';
    const origin = facebook ? facebookGraph : graphOrigin;
    const fields = facebook
      ? 'id,from{id},message,full_picture,permalink_url,created_time'
      : 'id,username,caption,media_type,media_url,thumbnail_url,permalink,timestamp';
    const posts = new Map();
    let unavailable = false;
    async function read(path, collection = false) {
      try {
        const response = await request(`${origin}/${path}`, {
          headers: { Authorization: `Bearer ${config.accessToken}` },
          redirect: 'error',
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error();
        }
        const data = await response.json();
        if (data.error) throw new Error();
        for (const post of collection
          ? Array.isArray(data.data)
            ? data.data.slice(0, 24)
            : []
          : [data]) {
          const id = String(post.id || '');
          if (
            facebook
              ? !new RegExp('^' + config.accountId + '_\\d{5,30}$').test(id)
              : !/^\d{5,30}$/.test(id)
          )
            continue;
          if (
            facebook
              ? String(post.from?.id) !== config.accountId
              : post.username?.toLowerCase() !== config.username.toLowerCase()
          )
            continue;
          const caption = text(facebook ? post.message : post.caption, 2000);
          posts.set(id, {
            id,
            title:
              caption
                .split('\n')
                .find((line) => line.trim())
                ?.trim()
                .slice(0, 100) ||
              (facebook ? 'Publicación de Facebook' : 'Publicación de Instagram'),
            caption,
            image: publicationUrl(
              facebook
                ? post.full_picture
                : post.thumbnail_url || (post.media_type !== 'VIDEO' ? post.media_url : null),
              true,
            ),
            permalink: publicationUrl(facebook ? post.permalink_url : post.permalink),
            publishedAt: text(facebook ? post.created_time : post.timestamp, 50),
            type: facebook ? 'POST' : text(post.media_type, 30),
          });
        }
      } catch {
        unavailable = true;
      }
    }
    await read(
      `${config.accountId}/${facebook ? 'posts' : 'media'}?fields=${fields}&limit=24`,
      true,
    );
    const missing = [...new Set(rules.map((rule) => rule.media_id))]
      .filter(
        (id) =>
          !posts.has(id) &&
          (facebook
            ? new RegExp('^' + config.accountId + '_\\d{5,30}$').test(id)
            : /^\d{5,30}$/.test(id)),
      )
      .slice(0, 16);
    for (let i = 0; i < missing.length; i += 4)
      await Promise.all(missing.slice(i, i + 4).map((id) => read(`${id}?fields=${fields}`)));
    return { posts: [...posts.values()], unavailable, checkedAt: now() };
  }
  return {
    get(config, rules = []) {
      const key = createHash('sha256')
        .update(
          JSON.stringify([
            config.id,
            config.channel,
            config.accountId,
            config.ownerId,
            config.username,
            config.accessToken,
            rules.map((r) => r.media_id).sort(),
          ]),
        )
        .digest('hex');
      const previous = cache.get(key);
      if (previous && previous.expires > now()) return previous.promise;
      for (const [id, value] of cache) if (value.expires <= now()) cache.delete(id);
      if (cache.size >= 200) cache.delete(cache.keys().next().value);
      const entry = { expires: now() + 300_000 };
      entry.promise = load(config, rules).then((result) => {
        entry.expires = now() + (result.unavailable ? 60_000 : 300_000);
        return result;
      });
      cache.set(key, entry);
      return entry.promise;
    },
  };
}
