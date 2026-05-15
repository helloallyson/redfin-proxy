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

// Verified Redfin city IDs from redfin.com/city/{id}/IA/{City} URLs
const SUBURB_INFO = {
  'Des Moines':      { id: 5415 },
  'West Des Moines': { id: 20722 },
  'Ankeny':          { id: 572 },
  'Urbandale':       { id: 20085 },
  'Waukee':          { id: 20523 },
  'Johnston':        { id: 9587 },
  'Clive':           { id: 3522 },
  'Grimes':          { id: 7638 },
  'Norwalk':         { id: 13869 },
  'Altoona':         { id: 414 },
  'Pleasant Hill':   { id: 15286 },
  'Bondurant':       { id: 1978 },
  'Carlisle':        { id: 2774 },
  'Indianola':       { id: 8989 },
  'Adel':            { id: 149 },
  'Van Meter':       { id: 19407 },
  'Polk City':       { id: 15402 },
  'Windsor Heights': { id: 21191 },
  'Cumming':         { id: 4363 },
  'Mitchellville':   { id: 12457 }
};

// Resolve a suburb name to its Redfin region_id using location autocomplete
async function resolveRegionId(suburbName) {
  try {
    const url = `https://www.redfin.com/stingray/do/location-autocomplete?location=${encodeURIComponent(suburbName + ', IA')}&v=2`;
    const resp = await fetch(url, { headers: REDFIN_HEADERS, timeout: 10000 });
    const text = await resp.text();
    const json = JSON.parse(text.replace(/^{}&&/, ''));
    
    if (json.payload && json.payload.sections) {
      for (const section of json.payload.sections) {
        if (section.rows) {
          for (const row of section.rows) {
            if (row.type === 6 && row.subName && row.subName.includes('IA')) {
              console.log(`Resolved ${suburbName} -> region_id: ${row.id}`);
              return row.id;
            }
          }
        }
      }
    }
  } catch (err) {
    console.warn(`Could not resolve region for ${suburbName}:`, err.message);
  }
  return null;
}

// Search a single suburb via CSV download
async function searchSuburbCSV(suburbName, filters) {
  const info = SUBURB_INFO[suburbName];
  if (!info) {
    console.warn(`No info for ${suburbName}, skipping`);
    return [];
  }
  
  const regionId = info.id;

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
    region_id: regionId,
    region_type: 6  // city
  });

  if (filters.min_sqft) params.set('min_listing_approx_size', filters.min_sqft);
  if (filters.max_sqft) params.set('max_listing_approx_size', filters.max_sqft);

  const url = `https://www.redfin.com/stingray/api/gis-csv?${params}`;
  console.log(`Searching ${suburbName} (region ${regionId}): ${url}`);

  const resp = await fetch(url, { headers: REDFIN_HEADERS, timeout: 20000 });
  const text = await resp.text();
  
  if (!resp.ok || text.includes('<!DOCTYPE') || text.length < 100) {
    console.warn(`CSV failed for ${suburbName}: status=${resp.status} len=${text.length}`);
    return [];
  }

  console.log(`${suburbName}: got ${text.length} bytes CSV`);
  return parseCSV(text);
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
      : Object.keys(SUBURB_INFO);

    const filters = { min_price, max_price, min_beds, min_baths, min_sqft, max_sqft, home_type };
    const allListings = [];
    const suburbResults = {};

    // Search each suburb in parallel batches of 3 (be respectful to Redfin)
    const batchSize = 3;
    for (let i = 0; i < selectedSuburbs.length; i += batchSize) {
      const batch = selectedSuburbs.slice(i, i + batchSize);
      
      const results = await Promise.all(
        batch.map(async (suburb) => {
          try {
            const listings = await searchSuburbCSV(suburb, filters);
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

      // Small delay between batches
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

    // Sort by price
    unique.sort((a, b) => a.price - b.price);

    console.log(`Total: ${unique.length} unique listings from ${selectedSuburbs.length} suburbs`);
    console.log('Per suburb:', suburbResults);

    res.json({
      success: unique.length > 0,
      count: unique.length,
      method: 'per-suburb-csv',
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
    if (c === '"') { if (inQ && line[i+1] === '"') { current += '"'; i++; } else { inQ = !inQ; } }
    else if (c === ',' && !inQ) { result.push(current); current = ''; }
    else { current += c; }
  }
  result.push(current);
  return result;
}

// Debug endpoint - resolves all suburb IDs
app.get('/api/debug', async (req, res) => {
  const results = {};
  
  // Just test 3 suburbs to keep it fast
  const testSuburbs = ['Ankeny', 'Grimes', 'Des Moines'];
  for (const name of testSuburbs) {
    try {
      const url = `https://www.redfin.com/stingray/do/location-autocomplete?location=${encodeURIComponent(name + ', IA')}&v=2`;
      const resp = await fetch(url, { headers: REDFIN_HEADERS, timeout: 10000 });
      const text = await resp.text();
      results[name] = { 
        configured: SUBURB_INFO[name]?.id,
        rawLength: text.length,
        rawPreview: text.substring(0, 500)
      };
    } catch (e) {
      results[name] = { error: e.message };
    }
    await new Promise(r => setTimeout(r, 300));
  }

  // Also test a direct CSV search with Des Moines
  try {
    const params = new URLSearchParams({
      al: 1, status: 1, min_price: 300000, max_price: 450000,
      num_beds: 3, min_num_baths: 1, num_homes: 5,
      page_number: 1, sp: true, v: 8, uipt: '1,2,3',
      region_id: 5415, region_type: 6
    });
    const url = `https://www.redfin.com/stingray/api/gis-csv?${params}`;
    const r = await fetch(url, { headers: REDFIN_HEADERS, timeout: 15000 });
    const t = await r.text();
    results['CSV_test_type6'] = { status: r.status, length: t.length, preview: t.substring(0, 200) };
  } catch (e) { results['CSV_test_type6'] = { error: e.message }; }

  // Try with region_type 2 instead
  try {
    const params = new URLSearchParams({
      al: 1, status: 1, min_price: 300000, max_price: 450000,
      num_beds: 3, min_num_baths: 1, num_homes: 5,
      page_number: 1, sp: true, v: 8, uipt: '1,2,3',
      region_id: 5415, region_type: 2
    });
    const url = `https://www.redfin.com/stingray/api/gis-csv?${params}`;
    const r = await fetch(url, { headers: REDFIN_HEADERS, timeout: 15000 });
    const t = await r.text();
    results['CSV_test_type2'] = { status: r.status, length: t.length, preview: t.substring(0, 200) };
  } catch (e) { results['CSV_test_type2'] = { error: e.message }; }

  res.json(results);
});

// Location autocomplete endpoint
app.get('/api/location', async (req, res) => {
  try {
    const { query } = req.query;
    const url = `https://www.redfin.com/stingray/do/location-autocomplete?location=${encodeURIComponent(query)}&v=2`;
    const resp = await fetch(url, { headers: REDFIN_HEADERS });
    const text = await resp.text();
    const json = JSON.parse(text.replace(/^{}&&/, ''));
    res.json(json);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'House Hunter DSM - Redfin Proxy v3', suburbs: Object.keys(SUBURB_INFO) });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Redfin proxy v3 running on port ${PORT}`);
  console.log('Suburb IDs:', JSON.stringify(Object.fromEntries(Object.entries(SUBURB_INFO).map(([k,v]) => [k, v.id]))));
});
