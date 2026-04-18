const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// ── Browser-like headers that fool dineoncampus ──────────────
const SPOOF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Origin': 'https://dineoncampus.com',
  'Referer': 'https://dineoncampus.com/',
  'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-site',
  'Connection': 'keep-alive',
};

// ── Known Baylor dining halls ─────────────────────────────────
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

// ── Helper: fetch one menu from dineoncampus ──────────────────
async function fetchMenu(locationId, date, periodId) {
  const url = `https://apiv4.dineoncampus.com/locations/${locationId}/menu?date=${date}&period=${periodId}`;
  const res = await fetch(url, { headers: SPOOF_HEADERS });
  if (!res.ok) throw new Error(`Upstream returned ${res.status} for ${url}`);
  return res.json();
}

// ── Helper: parse raw menu into clean rows ────────────────────
function parseMenu(raw, locationName, periodName, date) {
  const categories = raw?.period?.categories ?? [];
  const rows = [];
  for (const cat of categories) {
    for (const item of (cat.items ?? [])) {
      const nutrients = {};
      for (const n of (item.nutrients ?? [])) nutrients[n.name] = n.value;
      rows.push({
        date,
        location: locationName,
        meal: periodName,
        category: cat.name,
        item: item.name,
        portion: item.portion ?? null,
        calories: item.calories ?? null,
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

// ── Helper: generate Mon–Sun dates for a given week ──────────
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

// ── ROUTES ────────────────────────────────────────────────────

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Baylor Dining Proxy', version: '1.0.0' });
});

// GET /menu?location=penland&date=2026-04-18&meal=lunch
// Fetch a single meal for a single hall
app.get('/menu', async (req, res) => {
  const { location, date, meal } = req.query;
  if (!location || !date || !meal) {
    return res.status(400).json({ error: 'Required: location, date, meal' });
  }
  const loc = LOCATIONS[location.toLowerCase()];
  if (!loc) {
    return res.status(400).json({ error: `Unknown location. Valid: ${Object.keys(LOCATIONS).join(', ')}` });
  }
  const periodId = loc.periods[meal.toLowerCase()];
  if (!periodId) {
    return res.status(400).json({ error: `Unknown meal. Valid: ${Object.keys(loc.periods).join(', ')}` });
  }
  try {
    const raw = await fetchMenu(loc.id, date, periodId);
    const items = parseMenu(raw, loc.name, meal, date);
    res.json({ date, location: loc.name, meal, itemCount: items.length, items });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// GET /week?date=2026-04-18   (date optional — defaults to current week)
// Fetch ALL halls, ALL meals, ALL 7 days
app.get('/week', async (req, res) => {
  const dates = getWeekDates(req.query.date);
  const allItems = [];
  const errors = [];

  for (const date of dates) {
    for (const [locKey, loc] of Object.entries(LOCATIONS)) {
      for (const [mealKey, periodId] of Object.entries(loc.periods)) {
        try {
          const raw = await fetchMenu(loc.id, date, periodId);
          const items = parseMenu(raw, loc.name, mealKey, date);
          allItems.push(...items);
        } catch (err) {
          errors.push({ date, location: locKey, meal: mealKey, error: err.message });
        }
        // Be polite to upstream
        await new Promise(r => setTimeout(r, 800));
      }
    }
  }

  // Group by date → location → meal
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
