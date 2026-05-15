const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const REDFIN_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Connection': 'keep-alive',
  'Cache-Control': 'no-cache'
};

// Bounding boxes for each suburb - expanded to cover full city limits
const SUBURB_BOUNDS = {
  'Des Moines':      { s: 41.48, n: 41.66, w: -93.74, e: -93.49 },
  'West Des Moines': { s: 41.52, n: 41.61, w: -93.84, e: -93.66 },
  'Ankeny':          { s: 41.69, n: 41.80, w: -93.66, e: -93.53 },
  'Urbandale':       { s: 41.59, n: 41.67, w: -93.80, e: -93.66 },
  'Waukee':          { s: 41.56, n: 41.65, w: -93.94, e: -93.80 },
  'Johnston':        { s: 41.63, n: 41.74, w: -93.76, e: -93.64 },
  'Clive':           { s: 41.58, n: 41.63, w: -93.82, e: -93.73 },
  'Grimes':          { s: 41.66, n: 41.74, w: -93.84, e: -93.72 },
  'Norwalk':         { s: 41.43, n: 41.52, w: -93.74, e: -93.61 },
  'Altoona':         { s: 41.61, n: 41.68, w: -93.52, e: -93.42 },
  'Pleasant Hill':   { s: 41.55, n: 41.62, w: -93.56, e: -93.46 },
  'Bondurant':       { s: 41.67, n: 41.74, w: -93.50, e: -93.40 },
  'Carlisle':        { s: 41.46, n: 41.54, w: -93.53, e: -93.44 },
  'Indianola':       { s: 41.32, n: 41.40, w: -93.61, e: -93.51 },
  'Adel':            { s: 41.58, n: 41.66, w: -94.07, e: -93.95 },
  'Van Meter':       { s: 41.50, n: 41.56, w: -93.98, e: -93.90 },
  'Polk City':       { s: 41.74, n: 41.81, w: -93.76, e: -93.67 },
  'Windsor Heights': { s: 41.58, n: 41.62, w: -93.73, e: -93.67 },
  'Cumming':         { s: 41.45, n: 41.51, w: -93.88, e: -93.81 },
  'Mitchellville':   { s: 41.64, n: 41.70, w: -93.39, e: -93.32 }
};

// Search a single suburb via CSV using bounding box
async function searchSuburb(suburbName, filters) {
  const bounds = SUBURB_BOUNDS[suburbName];
  if (!bounds) {
    console.warn(`No bounds for ${suburbName}, skipping`);
    return [];
  }

  // Create closed polygon from bounding box
  const poly = `${bounds.w} ${bounds.s},${bounds.w} ${bounds.n},${bounds.e} ${bounds.n},${bounds.e} ${bounds.s},${bounds.w} ${bounds.s}`;

  const uipt = filters.home_type === 'single family' ? '1' :
               filters.home_type === 'condo' ? '2' :
               filters.home_type === 'townhouse' ? '3' : '1,2,3';

  const params = new URLSearchParams({
    al: 1,
    status: 1,
    min_price: filters.min_price,
    max_price: filters.max_price,
    num_beds: filters.min_beds,
    min_num_baths: filters.min_baths,
    num_homes: 350,
    page_number: 1,
    sp: true,
    v: 8,
    uipt,
    poly
  });

  if (filters.min_sqft) params.set('min_listing_approx_size', filters.min_sqft);
  if (filters.max_sqft) params.set('max_listing_approx_size', filters.max_sqft);

  const url = `https://www.redfin.com/stingray/api/gis-csv?${params}`;
  console.log(`Searching ${suburbName}...`);

  const resp = await fetch(url, { headers: REDFIN_HEADERS, timeout: 20000 });
  const text = await resp.text();

  if (!resp.ok || text.includes('<!DOCTYPE') || text.length < 100) {
    console.warn(`CSV failed for ${suburbName}: status=${resp.status} len=${text.length}`);
    return [];
  }

  const listings = parseCSV(text);
  console.log(`${suburbName}: ${listings.length} listings`);
  return listings;
}

// Main search endpoint
app.get('/api/search', async (req, res) => {
  try {
    const {
      min_price = 200000, max_price = 500000,
      min_beds = 3, min_baths = 1,
      min_sqft, max_sqft, home_type, suburbs
    } = req.query;

    console.log('Search request:', req.query);

    const selectedSuburbs = suburbs
      ? suburbs.split(',').map(s => s.trim())
      : Object.keys(SUBURB_BOUNDS);

    const filters = { min_price, max_price, min_beds, min_baths, min_sqft, max_sqft, home_type };
    const allListings = [];
    const suburbResults = {};

    // Search each suburb in parallel batches of 3
    const batchSize = 3;
    for (let i = 0; i < selectedSuburbs.length; i += batchSize) {
      const batch = selectedSuburbs.slice(i, i + batchSize);

      const results = await Promise.all(
        batch.map(async (suburb) => {
          try {
            const listings = await searchSuburb(suburb, filters);
            suburbResults[suburb] = listings.length;
            return listings;
          } catch (err) {
            console.warn(`Error searching ${suburb}:`, err.message);
            suburbResults[suburb] = 0;
            return [];
          }
        })
      );

      results.forEach(listings => allListings.push(...listings));

      if (i + batchSize < selectedSuburbs.length) {
        await new Promise(r => setTimeout(r, 300));
      }
    }

    // Deduplicate by address
    const seen = new Set();
    const unique = allListings.filter(l => {
      const key = l.address.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    unique.sort((a, b) => a.price - b.price);

    console.log(`Total: ${unique.length} unique listings from ${selectedSuburbs.length} suburbs`);
    console.log('Per suburb:', suburbResults);

    res.json({
      success: unique.length > 0,
      count: unique.length,
      method: 'per-suburb-bbox',
      listings: unique,
      suburbCounts: suburbResults
    });

  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Parse Redfin CSV
function parseCSV(csvText) {
  const lines = csvText.split('\n');
  if (lines.length < 2) return [];
  const headers = parseCSVLine(lines[0]);
  const listings = [];

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const values = parseCSVLine(lines[i]);
    const row = {};
    headers.forEach((h, idx) => { row[h.trim().toUpperCase()] = (values[idx] || '').trim(); });

    const address = row['ADDRESS'] || row['STREET ADDRESS'] || '';
    const city = row['CITY'] || '';
    const state = row['STATE OR PROVINCE'] || row['STATE'] || 'IA';
    const zip = row['ZIP OR POSTAL CODE'] || row['ZIP'] || '';
    const price = parseInt((row['PRICE'] || row['LIST PRICE'] || '0').replace(/[^0-9]/g, ''));
    const beds = parseInt(row['BEDS'] || row['BEDROOMS'] || '0');
    const baths = parseFloat(row['BATHS'] || row['BATHROOMS'] || '0');
    const sqft = parseInt((row['SQUARE FEET'] || row['SQFT'] || '0').replace(/[^0-9]/g, '')) || null;
    const yearBuilt = parseInt(row['YEAR BUILT'] || '0') || null;
    const dom = row['DAYS ON MARKET'] || '';
    const lot = row['LOT SIZE'] || '';
    const hoa = row['HOA/MONTH'] || '';
    const lat = parseFloat(row['LATITUDE'] || '0') || null;
    const lng = parseFloat(row['LONGITUDE'] || '0') || null;
    const mls = row['MLS#'] || row['MLS NUMBER'] || '';
    const status = row['STATUS'] || row['SALE TYPE'] || '';

    let redfUrl = '';
    for (const key of Object.keys(row)) {
      if (key.startsWith('URL')) { redfUrl = row[key]; break; }
    }

    if (!address || !price) continue;
    const sl = status.toLowerCase();
    if (sl.includes('sold') || sl.includes('pending') || sl.includes('contingent')) continue;

    listings.push({
      address: [address, city, state, zip].filter(Boolean).join(', '),
      suburb: city || 'Unknown', price, beds, baths, sqft, yearBuilt,
      url: redfUrl.startsWith('http') ? redfUrl : (redfUrl ? `https://www.redfin.com${redfUrl}` : ''),
      source: 'Redfin', daysOnMarket: dom ? parseInt(dom) : null,
      lot: lot || null, hoa: hoa || null, mlsNumber: mls || null,
      lat, lng, status: status || 'Active'
    });
  }
  return listings;
}

function parseCSVLine(line) {
  const result = []; let current = ''; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (inQ && line[i + 1] === '"') { current += '"'; i++; } else { inQ = !inQ; } }
    else if (c === ',' && !inQ) { result.push(current); current = ''; }
    else { current += c; }
  }
  result.push(current);
  return result;
}

// Debug endpoint
app.get('/api/debug', async (req, res) => {
  const results = {};

  // Test a few suburb bounding box searches
  const testSuburbs = ['Des Moines', 'Ankeny', 'Grimes'];
  for (const name of testSuburbs) {
    try {
      const listings = await searchSuburb(name, {
        min_price: 300000, max_price: 450000,
        min_beds: 3, min_baths: 1
      });
      results[name] = {
        count: listings.length,
        sample: listings.slice(0, 2).map(l => ({ address: l.address, price: l.price, suburb: l.suburb }))
      };
    } catch (e) {
      results[name] = { error: e.message };
    }
  }

  res.json(results);
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'House Hunter DSM - Redfin Proxy v4 (bounding box)' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Redfin proxy v4 running on port ${PORT}`);
});
