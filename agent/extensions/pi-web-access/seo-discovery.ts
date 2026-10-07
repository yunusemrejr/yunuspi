import { publicSeoPages, seoUrl, type SeoPagePolicy } from '../lib/seo-policy.ts';
import { validSeoDate } from './seo-document.ts';
const xml = (value: string) => value.replace(/[<>&"']/g, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char]!);
const plain = (value: string) => value.replace(/[\r\n\[\]<>\\]/g, ' ').replace(/\s+/g, ' ').trim();
export function buildSeoDiscovery(input: { canonicalOrigin: string; pages: SeoPagePolicy[]; siteName?: string; sitemapBatchSize?: number; now?: number }) {
  const parsed = seoUrl(input.canonicalOrigin);
  if (!parsed || new URL(parsed).search || new URL(parsed).pathname !== '/') throw new Error('Provide the canonical site origin, without path/query/credentials.');
  const origin = new URL(parsed).origin;
  const batch = input.sitemapBatchSize ?? 50000;
  if (!Number.isInteger(batch) || batch < 1 || batch > 50000) throw new Error('Sitemap batch size must be 1 through 50000.');
  const inventory = publicSeoPages(input.pages, origin);
  if (!inventory.accepted.length) throw new Error('No canonical indexable public pages in the inventory.');
  for (const page of inventory.accepted) for (const field of ['lastmod', 'published'] as const) if (page[field]) {
    if (!validSeoDate(page[field]!) || Date.parse(page[field]!) > (input.now ?? Date.now()) + 86400000) throw new Error(`${field} must be an actual valid source date, not an invented build timestamp.`);
    if (page.lastmod && page.published && Date.parse(page.lastmod) < Date.parse(page.published)) throw new Error('Substantive modification precedes publication.');
  }
  const files: Record<string, string> = {};
  const groups: SeoPagePolicy[][] = [];
  for (let start = 0; start < inventory.accepted.length; start += batch) groups.push(inventory.accepted.slice(start, start + batch));
  groups.forEach((pages, index) => {
    const file = groups.length === 1 ? 'sitemap.xml' : `sitemap-${index + 1}.xml`;
    files[file] = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + pages.map(page => `  <url><loc>${xml(page.url)}</loc>${page.lastmod ? `<lastmod>${xml(page.lastmod)}</lastmod>` : ''}</url>`).join('\n') + '\n</urlset>\n';
  });
  if (groups.length > 1) files['sitemap.xml'] = '<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + groups.map((_group, index) => `  <sitemap><loc>${xml(origin)}/sitemap-${index + 1}.xml</loc></sitemap>`).join('\n') + '\n</sitemapindex>\n';
  const name = plain(input.siteName ?? '') || 'Public resources';
  files['llms.txt'] = `# ${name}\n\n> Canonical public resources.\n\n## Resources\n\n` + inventory.accepted.map(page => `- [${plain(page.title || page.intent || new URL(page.url).pathname)}](${page.url})${page.description ? ': ' + plain(page.description).slice(0, 300) : ''}`).join('\n') + '\n';
  const articles = inventory.accepted.filter(page => page.published && page.title && page.description);
  if (articles.length) files['feed.xml'] = '<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel>' + `<title>${xml(name)}</title><link>${xml(origin)}/</link><description>${xml(name)} published resources</description>` + articles.map(page => `<item><title>${xml(page.title!)}</title><link>${xml(page.url)}</link><guid isPermaLink="true">${xml(page.url)}</guid><description>${xml(page.description!)}</description><pubDate>${new Date(page.published!).toUTCString()}</pubDate></item>`).join('') + '</channel></rss>\n';
  const website = { '@type': 'WebSite', '@id': origin + '/#website', url: origin + '/', ...(input.siteName ? { name: plain(input.siteName) } : {}) };
  files['site-graph.json'] = JSON.stringify({ '@context': 'https://schema.org', '@graph': [website, ...inventory.accepted.map(page => ({ '@type': 'WebPage', '@id': page.url + '#webpage', url: page.url,
    isPartOf: { '@id': website['@id'] }, ...(page.title ? { name: page.title } : {}), ...(page.description ? { description: page.description } : {}), ...(page.locale ? { inLanguage: page.locale } : {}),
    ...(page.published ? { datePublished: page.published } : {}), ...(page.lastmod ? { dateModified: page.lastmod } : {}) }))] }, null, 2) + '\n';
  return { files, accepted: inventory.accepted.map(page => page.url), excluded: inventory.excluded,
    robotsSitemapLine: `Sitemap: ${origin}/sitemap.xml`,
    note: 'Generated from caller-reviewed canonical public inventory. Publish through the project owner; do not replace custom robots/auth rules. JSON graph is a source representation: embed the relevant visible page facts. Dates are supplied source dates and still require provenance. No submission, crawling, indexing or ranking claim.' };
}
