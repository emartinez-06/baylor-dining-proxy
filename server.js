const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// ── Session cookie cache ──────────────────────────────────────
let sessionCookies = '';
let lastCookieFetch = 0;
const COOKIE_TTL_MS = 30 * 60 * 1000;

async function refreshCookies() {
  const now = Date.now();
  if (sessionCookies && now - lastCookieFetch < COOKIE_TTL_MS) return;
  try {
    const res = await fetch('https://dineoncampus.com/baylor/whats-on-the-menu', {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
      },
      redirect: 'follow',
    });
    const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    if (raw.length > 0) {
      sessionCookies = raw.map(c => c.split(';')[0]).join('; ');
      lastCookieFetch = now;
      console.log(`[cookies] Refreshed (${raw.length} cookies)`);
    } else {
      console.log('[cookies] No cookies from homepage');
    }
  } catch (err) {
    console.error('[cookies] Failed:', err.message);
  }
}

function buildHeaders() {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Origin': 'https://dineoncampus.com',
    'Referer': 'https://dineoncampus.com/baylor/whats-on-the-menu',
    'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-site',
    'Connection': 'keep-alive',
    ...(sessionCookies ? { 'Cookie': sessionCookies } : {}),
  };
}

const LOCATIONS = {
  penland: {
    name: 'Penland Crossroads Dining Hall',
    id: '66479a25351d5305fdac9529',
    periods: {
      breakfast: '69e32c0606bcc8f0ccedabd0',
      lunch:     '69e32c0606bcc8f0ccedabd4',
      dinner:    '69e32c0606bcc8f0ccedabd1',
    }
  },
  memorial: {
    name: '1845 at Memorial',
    id: '66c670c8351d53011998534a',
    periods: {
      breakfast: '69e32c0c06bcc8f0ccedb157',
      lunch:     '69e32c0c06bcc8f0ccedb156',
      dinner:    '69e32c0c06bcc8f0ccedb158',
    }
  },
  eastvillage: {
    name: 'East Village Dining Commons',
    id: '66479a25351d5305fdac9517',
    periods: {
      breakfast: '69e32c0406bcc8f0ccedaa45',
      lunch:     '69e32c0406bcc8f0ccedaa46',
      dinner:    '69e32c0406bcc8f0ccedaa47',
    }
  }
};

async function fetchMenu(locationId, date, periodId) {
  await refreshCookies();
  const url = `https://apiv4.dineoncampus.com/locations/${locationId}/menu?date=${date}&period=${periodId}`;
  console.log(`[fetch] ${url}`);
  const res = await fetch(url, { headers: buildHeaders() });
  console.log(`[fetch] status=${res.status}`);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Upstream ${res.status}: ${body.substring(0, 200)}`);
  }
  return res.json();
}

function parseMenu(raw, locationName, periodName, date) {
  const categories = raw?.period?.categories ?? [];
  const rows = [];
  for (const cat of categories) {
    for (const item of (cat.items ?? [])) {
      const nutrients = {};
      for (const n of (item.nutrients ?? [])) nutrients[n.name] = n.value;
      rows.push({
        date, location: locationName, meal: periodName, category: cat.name,
        item: item.name, portion: item.portion ?? null, calories: item.calories ?? null,
        protein_g: nutrients['Protein (g)'] ?? null,
        carbs_g: nutrients['Total Carbohydrates (g)'] ?? null,
        fat_g: nutrients['Total Fat (g)'] ?? null,
        fiber_g: nutrients['Dietary Fiber (g)'] ?? null,
        sodium_mg: nutrients['Sodium (mg)'] ?? null,
        sugar_g: nutrients['Sugar (g)'] ?? null,
        ingredients: item.ingredients ?? null,
        dietaryFilters: (item.filters ?? []).map(f => f.name).join(', ') || null,
      });
    }
  }
  return rows;
}

function getWeekDates(referenceDate) {
  const ref = referenceDate ? new Date(referenceDate) : new Date();
  const day = ref.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(ref);
  monday.setDate(ref.getDate() + diffToMonday);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d.toISOString().split('T')[0];
  });
}

app.get('/', (req, res) => {
  res.json({
    status: 'ok', service: 'Baylor Dining Proxy', version: '1.1.0',
    cookies: sessionCookies ? 'loaded' : 'none',
    endpoints: {
      single: '/menu?location=penland&date=2026-04-18&meal=lunch',
      week:   '/week?date=2026-04-18',
      debug:  '/debug',
    }
  });
});

// Debug: shows upstream status + cookies so you can diagnose 403s
app.get('/debug', async (req, res) => {
  await refreshCookies();
  const url = 'https://apiv4.dineoncampus.com/locations/66479a25351d5305fdac9529/menu?date=2026-04-18&period=69e32c0606bcc8f0ccedabd0';
  try {
    const upstream = await fetch(url, { headers: buildHeaders() });
    const body = await upstream.text();
    res.json({
      upstreamStatus: upstream.status,
      cookiesLoaded: sessionCookies ? true : false,
      cookiePreview: sessionCookies.substring(0, 100) || 'none',
      sentHeaders: buildHeaders(),
      bodyPreview: body.substring(0, 800),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/menu', async (req, res) => {
  const { location, date, meal } = req.query;
  if (!location || !date || !meal)
    return res.status(400).json({ error: 'Required: location, date, meal' });
  const loc = LOCATIONS[location.toLowerCase()];
  if (!loc)
    return res.status(400).json({ error: `Unknown location. Valid: ${Object.keys(LOCATIONS).join(', ')}` });
  const periodId = loc.periods[meal.toLowerCase()];
  if (!periodId)
    return res.status(400).json({ error: `Unknown meal. Valid: ${Object.keys(loc.periods).join(', ')}` });
  try {
    const raw = await fetchMenu(loc.id, date, periodId);
    const items = parseMenu(raw, loc.name, meal, date);
    res.json({ date, location: loc.name, meal, itemCount: items.length, items });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/week', async (req, res) => {
  const dates = getWeekDates(req.query.date);
  const allItems = [], errors = [];
  for (const date of dates) {
    for (const [locKey, loc] of Object.entries(LOCATIONS)) {
      for (const [mealKey, periodId] of Object.entries(loc.periods)) {
        try {
          const raw = await fetchMenu(loc.id, date, periodId);
          allItems.push(...parseMenu(raw, loc.name, mealKey, date));
        } catch (err) {
          errors.push({ date, location: locKey, meal: mealKey, error: err.message });
        }
        await new Promise(r => setTimeout(r, 800));
      }
    }
  }
  const grouped = {};
  for (const row of allItems) {
    if (!grouped[row.date]) grouped[row.date] = {};
    if (!grouped[row.date][row.location]) grouped[row.date][row.location] = {};
    if (!grouped[row.date][row.location][row.meal]) grouped[row.date][row.location][row.meal] = [];
    grouped[row.date][row.location][row.meal].push(row);
  }
  res.json({
    scrapedAt: new Date().toISOString(),
    school: 'Baylor University',
    weekDates: dates,
    totalItems: allItems.length,
    errors: errors.length > 0 ? errors : undefined,
    weeklyMenu: grouped,
    flatItems: allItems,
  });
});

app.listen(PORT, () => console.log(`Baylor Dining Proxy running on port ${PORT}`));
