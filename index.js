const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

// Redfin Stingray API headers to mimic a browser
const REDFIN_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.redfin.com/',
  'Origin': 'https://www.redfin.com'
};

// Des Moines metro area zip codes mapped to suburbs
const SUBURB_ZIPS = {
  'Des Moines': ['50309', '50310', '50311', '50312', '50313', '50314', '50315', '50316', '50317', '50320', '50321'],
  'West Des Moines': ['50265', '50266'],
  'Ankeny': ['50021', '50023'],
  'Urbandale': ['50322', '50323'],
  'Waukee': ['50263'],
  'Johnston': ['50131'],
  'Clive': ['50325'],
  'Grimes': ['50111'],
  'Norwalk': ['50211'],
  'Altoona': ['50009'],
  'Pleasant Hill': ['50327'],
  'Bondurant': ['50035'],
  'Carlisle': ['50047'],
  'Indianola': ['50125'],
  'Adel': ['50003'],
  'Van Meter': ['50261'],
  'Polk City': ['50226'],
  'Windsor Heights': ['50324'],
  'Cumming': ['50061'],
  'Mitchellville': ['50169']
};

// Use the Redfin CSV download endpoint which is the most reliable
// We'll search by the broader Des Moines metro bounding box
app.get('/api/search', async (req, res) => {
  try {
    const {
      min_price = 200000,
      max_price = 500000,
      min_beds = 3,
      min_baths = 1,
      min_sqft,
      max_sqft,
      home_type,
      suburbs // comma-separated suburb names
    } = req.query;

    // Build zip code list from selected suburbs
    let zipCodes = [];
    if (suburbs) {
      const selectedSuburbs = suburbs.split(',').map(s => s.trim());
      selectedSuburbs.forEach(suburb => {
        if (SUBURB_ZIPS[suburb]) {
          zipCodes.push(...SUBURB_ZIPS[suburb]);
        }
      });
    } else {
      // All zips
      Object.values(SUBURB_ZIPS).forEach(zips => zipCodes.push(...zips));
    }

    // Search using the gis-csv endpoint with region-based search
    // We'll use the broader Polk County / Dallas County approach
    // region_type: 5 = county, 6 = zip, 2 = city
    // status: 1 = active/for sale, 9 = all
    
    // Build params for the stingray GIS search
    const params = new URLSearchParams({
      al: 1,
      status: 1, // Active/For Sale ONLY
      min_price: min_price,
      max_price: max_price,
      num_beds: min_beds,
      min_num_baths: min_baths,
      region_type: 6, // zip code
      num_homes: 350,
      page_number: 1,
      sp: true,
      v: 8,
      uipt: '1,2,3', // 1=house, 2=condo, 3=townhouse
      render: 'csv'
    });

    if (min_sqft) params.set('min_listing_approx_size', min_sqft);
    if (max_sqft) params.set('max_listing_approx_size', max_sqft);

    // Property type filter
    if (home_type === 'single family') params.set('uipt', '1');
    else if (home_type === 'townhouse') params.set('uipt', '3');
    else if (home_type === 'condo') params.set('uipt', '2');

    // We'll make requests per zip code cluster and merge results
    // Group zips into batches to reduce API calls
    const allListings = [];
    const errors = [];

    // Process zips in parallel batches of 5
    const batchSize = 5;
    for (let i = 0; i < zipCodes.length; i += batchSize) {
      const batch = zipCodes.slice(i, i + batchSize);
      const batchPromises = batch.map(async (zip) => {
        try {
          const zipParams = new URLSearchParams(params);
          zipParams.set('region_id', zip);
          zipParams.set('region_type', 2); // Use type 2 for zip-based search
          
          const url = `https://www.redfin.com/stingray/api/gis-csv?${zipParams.toString()}`;
          console.log(`Fetching zip ${zip}...`);
          
          const response = await fetch(url, {
            headers: REDFIN_HEADERS,
            timeout: 15000
          });

          if (!response.ok) {
            console.warn(`Zip ${zip} returned ${response.status}`);
            return [];
          }

          const csvText = await response.text();
          if (!csvText || csvText.includes('<!DOCTYPE') || csvText.length < 50) {
            return [];
          }

          return parseCSV(csvText, zip);
        } catch (err) {
          console.warn(`Error fetching zip ${zip}:`, err.message);
          return [];
        }
      });

      const batchResults = await Promise.all(batchPromises);
      batchResults.forEach(listings => allListings.push(...listings));
      
      // Small delay between batches to be respectful
      if (i + batchSize < zipCodes.length) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    // If zip-based search didn't work, try the bounding box approach
    if (allListings.length === 0) {
      console.log('Zip search returned 0 results, trying bounding box...');
      try {
        // Des Moines metro bounding box (roughly)
        const bboxParams = new URLSearchParams(params);
        bboxParams.delete('region_id');
        bboxParams.delete('region_type');
        // lat/lng bounding box for Des Moines metro
        bboxParams.set('poly', '-93.85 41.45,-93.85 41.75,-93.4 41.75,-93.4 41.45');
        bboxParams.set('render', 'csv');
        
        const url = `https://www.redfin.com/stingray/api/gis-csv?${bboxParams.toString()}`;
        console.log('Trying bounding box search...');
        
        const response = await fetch(url, {
          headers: REDFIN_HEADERS,
          timeout: 20000
        });

        if (response.ok) {
          const csvText = await response.text();
          if (csvText && !csvText.includes('<!DOCTYPE') && csvText.length > 50) {
            const parsed = parseCSV(csvText);
            allListings.push(...parsed);
          }
        }
      } catch (err) {
        errors.push('Bounding box fallback failed: ' + err.message);
      }
    }

    // Deduplicate by address
    const seen = new Set();
    const unique = allListings.filter(l => {
      if (seen.has(l.address)) return false;
      seen.add(l.address);
      return true;
    });

    // Filter by selected suburbs if specified
    let filtered = unique;
    if (suburbs) {
      const selectedSuburbs = suburbs.split(',').map(s => s.trim().toLowerCase());
      filtered = unique.filter(l => {
        const city = (l.suburb || '').toLowerCase();
        return selectedSuburbs.some(s => city.includes(s.toLowerCase()) || s.toLowerCase().includes(city));
      });
      // If suburb filtering removed too many, include all
      if (filtered.length === 0) filtered = unique;
    }

    // Sort by price
    filtered.sort((a, b) => a.price - b.price);

    res.json({
      success: true,
      count: filtered.length,
      listings: filtered.slice(0, 100),
      debug: {
        zipsSearched: zipCodes.length,
        totalBeforeDedup: allListings.length,
        totalAfterDedup: unique.length,
        errors: errors
      }
    });

  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Also support the Redfin location search to resolve region IDs
app.get('/api/location', async (req, res) => {
  try {
    const { query } = req.query;
    const url = `https://www.redfin.com/stingray/do/location-autocomplete?location=${encodeURIComponent(query)}&v=2`;
    
    const response = await fetch(url, { headers: REDFIN_HEADERS });
    const text = await response.text();
    // Redfin prepends "{}&&" to JSONP responses
    const json = JSON.parse(text.replace(/^{}&&/, ''));
    res.json(json);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'House Hunter DSM - Redfin Proxy' });
});

// Parse Redfin CSV response into listing objects
function parseCSV(csvText, zipHint) {
  const lines = csvText.split('\n');
  if (lines.length < 2) return [];
  
  // Parse header
  const headers = parseCSVLine(lines[0]);
  const listings = [];
  
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    
    const values = parseCSVLine(lines[i]);
    const row = {};
    headers.forEach((h, idx) => {
      row[h.trim()] = (values[idx] || '').trim();
    });
    
    // Map to our listing format
    const address = row['ADDRESS'] || row['STREET ADDRESS'] || '';
    const city = row['CITY'] || '';
    const state = row['STATE OR PROVINCE'] || row['STATE'] || 'IA';
    const zip = row['ZIP OR POSTAL CODE'] || row['ZIP'] || '';
    const price = parseInt(row['PRICE'] || row['LIST PRICE'] || '0');
    const beds = parseInt(row['BEDS'] || row['BEDROOMS'] || '0');
    const baths = parseFloat(row['BATHS'] || row['BATHROOMS'] || '0');
    const sqft = parseInt(row['SQUARE FEET'] || row['SQFT'] || '0');
    const yearBuilt = parseInt(row['YEAR BUILT'] || '0') || null;
    const lot = row['LOT SIZE'] || '';
    const daysOnMarket = row['DAYS ON MARKET'] || '';
    const redfUrl = row['URL (SEE https://www.redfin.com/buy-a-home/comparative-market-analysis FOR INFO ON PRICING)'] 
                    || row['URL'] || '';
    const status = row['STATUS'] || row['SALE TYPE'] || '';
    const lat = parseFloat(row['LATITUDE'] || '0');
    const lng = parseFloat(row['LONGITUDE'] || '0');
    const mlsNum = row['MLS#'] || row['MLS NUMBER'] || '';
    const hoa = row['HOA/MONTH'] || '';
    
    if (!address || !price) continue;
    
    // Only include active listings
    const statusLower = status.toLowerCase();
    if (statusLower.includes('sold') || statusLower.includes('pending') || statusLower.includes('contingent')) {
      continue;
    }
    
    const fullAddress = [address, city, state, zip].filter(Boolean).join(', ');
    
    listings.push({
      address: fullAddress,
      suburb: city || 'Unknown',
      price,
      beds,
      baths,
      sqft: sqft || null,
      yearBuilt,
      url: redfUrl.startsWith('http') ? redfUrl : (redfUrl ? `https://www.redfin.com${redfUrl}` : ''),
      source: 'Redfin',
      daysOnMarket: daysOnMarket ? parseInt(daysOnMarket) : null,
      lot: lot || null,
      hoa: hoa || null,
      mlsNumber: mlsNum || null,
      lat: lat || null,
      lng: lng || null,
      status: status || 'Active'
    });
  }
  
  return listings;
}

// Proper CSV line parser that handles quoted fields
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Redfin proxy running on port ${PORT}`);
});
