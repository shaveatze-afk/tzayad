// Reads the current price of each KSP product in tracker/ksp-items.json
// and appends it to data/ksp-history.json. Run by .github/workflows/track-prices.yml.
import { readFile, writeFile } from 'node:fs/promises';

const ITEMS_FILE = new URL('./ksp-items.json', import.meta.url);
const HISTORY_FILE = new URL('../data/ksp-history.json', import.meta.url);
const MAX_POINTS = 500;
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8',
};

const num = (v) => {
  const n = typeof v === 'string' ? Number(v.replace(/[^\d.]/g, '')) : Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

// Walk a JSON value and return the first object that looks like a product (has a name and a price).
function findProduct(v, depth = 0) {
  if (!v || typeof v !== 'object' || depth > 8) return null;
  if (!Array.isArray(v)) {
    const name = v.name ?? v.title ?? v.itemName;
    const price = num(v.price ?? v.final_price ?? v.priceAfterDiscount ?? v.min_price);
    if (typeof name === 'string' && name.trim() && price) {
      return { name: name.trim(), price, image: typeof v.img === 'string' ? v.img : typeof v.image === 'string' ? v.image : '' };
    }
  }
  for (const k of Object.keys(v)) {
    const r = findProduct(v[k], depth + 1);
    if (r) return r;
  }
  return null;
}

async function fromApi(id) {
  const r = await fetch(`https://ksp.co.il/m_action/api/item/${id}`, { headers: { ...HEADERS, Accept: 'application/json' } });
  const text = await r.text();
  if (!r.ok) throw new Error(`api HTTP ${r.status}: ${text.slice(0, 200)}`);
  let j; try { j = JSON.parse(text); } catch { throw new Error(`api not JSON: ${text.slice(0, 200)}`); }
  const p = findProduct(j);
  if (!p) throw new Error(`api: no product in JSON (keys: ${Object.keys(j).join(',')}) ${text.slice(0, 300)}`);
  return p;
}

async function fromHtml(id) {
  const r = await fetch(`https://ksp.co.il/web/item/${id}`, { headers: { ...HEADERS, Accept: 'text/html' } });
  const html = await r.text();
  if (!r.ok) throw new Error(`html HTTP ${r.status}: ${html.slice(0, 200)}`);
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const d = JSON.parse(m[1]);
      for (const node of [d, ...(Array.isArray(d) ? d : []), ...(d['@graph'] || [])]) {
        const offers = Array.isArray(node?.offers) ? node.offers[0] : node?.offers;
        const price = num(offers?.price ?? offers?.lowPrice);
        if (node?.name && price) return { name: String(node.name), price, image: Array.isArray(node.image) ? node.image[0] : node.image || '' };
      }
    } catch {}
  }
  const meta = (p) => html.match(new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${p}["'][^>]+content=["']([^"']+)`, 'i'))?.[1];
  const price = num(meta('product:price:amount') ?? meta('price'));
  const name = meta('og:title') ?? html.match(/<title>([^<]+)/i)?.[1];
  if (price && name) return { name: name.trim(), price, image: meta('og:image') || '' };
  throw new Error(`html: no price found (${html.length} bytes) ${html.slice(0, 200).replace(/\s+/g, ' ')}`);
}

const { items } = JSON.parse(await readFile(ITEMS_FILE, 'utf8'));
let history = { updated: null, items: {} };
try { history = JSON.parse(await readFile(HISTORY_FILE, 'utf8')); } catch {}

const now = new Date().toISOString();
let ok = 0;
for (const { id } of items) {
  const rec = (history.items[id] ||= { id, url: `https://ksp.co.il/web/item/${id}`, name: '', image: '', history: [] });
  let p = null; const errors = [];
  for (const get of [fromApi, fromHtml]) {
    try { p = await get(id); break; } catch (e) { errors.push(e.message); }
  }
  if (p) {
    rec.name = p.name; if (p.image) rec.image = p.image.startsWith('http') ? p.image : `https://ksp.co.il${p.image.startsWith('/') ? '' : '/'}${p.image}`;
    rec.history.push({ t: now, price: p.price });
    if (rec.history.length > MAX_POINTS) rec.history.splice(0, rec.history.length - MAX_POINTS);
    rec.lastError = null; ok++;
    console.log(`OK ${id} ₪${p.price} ${p.name}`);
  } else {
    rec.lastError = { t: now, message: errors.join(' | ').slice(0, 500) };
    console.log(`FAIL ${id}: ${errors.join(' | ')}`);
  }
  await new Promise((r) => setTimeout(r, 1500));
}
// Drop items no longer in the list.
for (const id of Object.keys(history.items)) if (!items.some((i) => i.id === id)) delete history.items[id];
history.updated = now;
await writeFile(HISTORY_FILE, JSON.stringify(history, null, 1) + '\n');
console.log(`${ok}/${items.length} prices read`);
if (ok === 0) process.exitCode = 1;
