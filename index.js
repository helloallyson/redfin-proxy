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

const DSM_METRO_BOUNDS = {
  south: 41.45, north: 41.82,
  west: -93.92, east: -93.38
};

app.get('/api/search', async (req, res) => {
  try {
    const {
      min_price = 200000, max_price = 500000,
      min_beds = 3, min_baths = 1,
      min_sqft, max_sqft, home_type, suburbs
    } = req.query;

    console.log('Search request:', req.query);
    let listings = [];
    let method = '';
    let debugInfo = {};

    // Approach 1: CSV
    try {
      console.log('Trying CSV...');
      listings = await searchCSV({ min_price, max_price, min_beds, min_baths, min_sqft, max_sqft, home_type });
      if (listings.length > 0) method = 'csv';
    } catch (err) {
      debugInfo.csvError = err.message;
      console.warn('CSV failed:', err.message);
    }

    // Approach 2: JSON
    if (listings.length === 0) {
      try {
        console.log('Trying JSON...');
        listings = await searchJSON({ min_price, max_price, min_beds, min_baths, min_sqft, max_sqft, home_type });
        if (listings.length > 0) method = 'json';
      } catch (err) {
        debugInfo.jsonError = err.message;
        console.warn('JSON failed:', err.message);
      }
    }

    // Filter by suburbs
    if (suburbs && listings.length > 0) {
      const selected = suburbs.split(',').map(s => s.trim().toLowerCase());
      const filtered = listings.filter(l => {
        const city = (l.suburb || '').toLowerCase();
        return selected.some(s => city.includes(s) || s.includes(city));
      });
      if (filtered.length > 0) listings = filtered;
    }

    // Deduplicate
    const seen = new Set();
    listings = listings.filter(l => {
      const key = l.address.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    listings.sort((a, b) => a.price - b.price);
    console.log(`Returning ${listings.length} via ${method}`);

    res.json({ success: listings.length > 0, count: listings.length, method, listings: listings.slice(0, 100), debug: debugInfo });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

async function searchCSV(f) {
  const poly = `${DSM_METRO_BOUNDS.west} ${DSM_METRO_BOUNDS.south},${DSM_METRO_BOUNDS.west} ${DSM_METRO_BOUNDS.north},${DSM_METRO_BOUNDS.east} ${DSM_METRO_BOUNDS.north},${DSM_METRO_BOUNDS.east} ${DSM_METRO_BOUNDS.south},${DSM_METRO_BOUNDS.west} ${DSM_METRO_BOUNDS.south}`;
  const uipt = f.home_type === 'single family' ? '1' : f.home_type === 'condo' ? '2' : f.home_type === 'townhouse' ? '3' : '1,2,3';
  
  const params = new URLSearchParams({
    al: 1, status: 1, min_price: f.min_price, max_price: f.max_price,
    num_beds: f.min_beds, min_num_baths: f.min_baths,
    num_homes: 350, page_number: 1, sp: true, v: 8, uipt, poly
  });
  if (f.min_sqft) params.set('min_listing_approx_size', f.min_sqft);
  if (f.max_sqft) params.set('max_listing_approx_size', f.max_sqft);

  const url = `https://www.redfin.com/stingray/api/gis-csv?${params}`;
  console.log('CSV URL:', url);
  
  const resp = await fetch(url, { headers: REDFIN_HEADERS, timeout: 20000 });
  const text = await resp.text();
  console.log('CSV status:', resp.status, 'len:', text.length, 'preview:', text.substring(0, 150));
  
  if (!resp.ok || text.includes('<!DOCTYPE') || text.length < 100) {
    throw new Error(`Bad CSV response: status=${resp.status} len=${text.length}`);
  }
  return parseCSV(text);
}

async function searchJSON(f) {
  const poly = `${DSM_METRO_BOUNDS.west} ${DSM_METRO_BOUNDS.south},${DSM_METRO_BOUNDS.west} ${DSM_METRO_BOUNDS.north},${DSM_METRO_BOUNDS.east} ${DSM_METRO_BOUNDS.north},${DSM_METRO_BOUNDS.east} ${DSM_METRO_BOUNDS.south},${DSM_METRO_BOUNDS.west} ${DSM_METRO_BOUNDS.south}`;
  const uipt = f.home_type === 'single family' ? '1' : f.home_type === 'condo' ? '2' : f.home_type === 'townhouse' ? '3' : '1,2,3';
  
  const params = new URLSearchParams({
    al: 1, status: 1, min_price: f.min_price, max_price: f.max_price,
    num_beds: f.min_beds, min_num_baths: f.min_baths,
    num_homes: 100, page_number: 1, sp: true, v: 8, uipt, poly, render: 'json'
  });
  if (f.min_sqft) params.set('min_listing_approx_size', f.min_sqft);
  if (f.max_sqft) params.set('max_listing_approx_size', f.max_sqft);

  const url = `https://www.redfin.com/stingray/api/gis?${params}`;
  console.log('JSON URL:', url);
  
  const resp = await fetch(url, { headers: REDFIN_HEADERS, timeout: 20000 });
  let text = await resp.text();
  console.log('JSON status:', resp.status, 'len:', text.length, 'preview:', text.substring(0, 200));
  
  if (!resp.ok || text.includes('<!DOCTYPE')) {
    throw new Error(`Bad JSON response: status=${resp.status}`);
  }

  // Redfin prepends "{}&&"
  text = text.replace(/^{}&&/, '').trim();
  const data = JSON.parse(text);
  const homes = data.payload?.homes || [];
  console.log('Parsed', homes.length, 'homes from JSON');

  return homes.map(h => {
    const street = typeof h.streetLine === 'object' ? h.streetLine.value : (h.streetLine || '');
    const city = h.city || '';
    const state = h.state || 'IA';
    const zip = h.zip || '';
    const price = typeof h.price === 'object' ? h.price.value : (h.price || 0);
    const sqft = typeof h.sqFt === 'object' ? h.sqFt.value : (h.sqFt || null);
    const yr = typeof h.yearBuilt === 'object' ? h.yearBuilt.value : (h.yearBuilt || null);
    const dom = h.dom ? (typeof h.dom === 'object' ? h.dom.value : h.dom) : null;
    const lat = h.latLong?.value?.latitude || h.latitude || null;
    const lng = h.latLong?.value?.longitude || h.longitude || null;
    const mlsId = typeof h.mlsId === 'object' ? h.mlsId.value : (h.mlsId || null);
    const hoa = typeof h.hoa === 'object' ? h.hoa.value : (h.hoa || null);
    const lot = typeof h.lotSize === 'object' ? h.lotSize.value : (h.lotSize || null);
    const redUrl = h.url ? `https://www.redfin.com${h.url}` : '';
    
    return {
      address: [street, city, state, zip].filter(Boolean).join(', '),
      suburb: city || 'Unknown',
      price, beds: h.beds || 0, baths: h.baths || 0,
      sqft, yearBuilt: yr, url: redUrl, source: 'Redfin',
      daysOnMarket: dom, lot, hoa, lat, lng,
      mlsNumber: mlsId, status: 'Active'
    };
  }).filter(l => l.price > 0 && l.address.length > 5);
}

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
    if (c === '"') { if (inQ && line[i+1] === '"') { current += '"'; i++; } else { inQ = !inQ; } }
    else if (c === ',' && !inQ) { result.push(current); current = ''; }
    else { current += c; }
  }
  result.push(current);
  return result;
}

// Debug endpoint
app.get('/api/debug', async (req, res) => {
  const results = {};
  
  // Test CSV
  try {
    const csvUrl = 'https://www.redfin.com/stingray/api/gis-csv?al=1&status=1&min_price=300000&max_price=450000&num_beds=3&min_num_baths=1&num_homes=5&page_number=1&sp=true&v=8&uipt=1,2,3&poly=-93.92 41.45,-93.92 41.82,-93.38 41.82,-93.38 41.45,-93.92 41.45';
    const r1 = await fetch(csvUrl, { headers: REDFIN_HEADERS, timeout: 15000 });
    const t1 = await r1.text();
    results.csv = { status: r1.status, length: t1.length, preview: t1.substring(0, 300), isHTML: t1.includes('<!DOCTYPE') };
  } catch (e) { results.csv = { error: e.message }; }

  // Test JSON
  try {
    const jsonUrl = 'https://www.redfin.com/stingray/api/gis?al=1&status=1&min_price=300000&max_price=450000&num_beds=3&min_num_baths=1&num_homes=5&page_number=1&sp=true&v=8&uipt=1,2,3&render=json&poly=-93.92 41.45,-93.92 41.82,-93.38 41.82,-93.38 41.45,-93.92 41.45';
    const r2 = await fetch(jsonUrl, { headers: REDFIN_HEADERS, timeout: 15000 });
    const t2 = await r2.text();
    results.json = { status: r2.status, length: t2.length, preview: t2.substring(0, 300), isHTML: t2.includes('<!DOCTYPE') };
  } catch (e) { results.json = { error: e.message }; }

  // Test basic redfin access
  try {
    const r3 = await fetch('https://www.redfin.com/city/5415/IA/Des-Moines', { headers: REDFIN_HEADERS, timeout: 10000 });
    results.pageAccess = { status: r3.status, length: (await r3.text()).length };
  } catch (e) { results.pageAccess = { error: e.message }; }

  res.json(results);
});

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'House Hunter DSM - Redfin Proxy' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Redfin proxy running on port ${PORT}`));
