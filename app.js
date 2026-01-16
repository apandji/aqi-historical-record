// Get today's date components for historical comparison
const today = new Date();
const month = today.getMonth() + 1; // 1-12
const day = today.getDate();
const year = today.getFullYear();

// Historical year to compare with
// 2013 works for Europe, but for US/global locations, 2023 is more reliable
// We'll try 2023 first (has full year coverage globally), fall back to 2013 if needed
const HISTORICAL_YEAR = 2023;
const FALLBACK_YEAR = 2013;

// Fetch and display air quality data for given coordinates
async function fetchAndDisplayAQ(latitude, longitude, locationName = null) {
    try {
        // Show loading, hide error
        document.getElementById('loading').style.display = 'block';
        document.getElementById('error').style.display = 'none';
        document.getElementById('content').style.display = 'none';
        
        // Get location name if not provided
        let geocodeResult = null;
        if (!locationName) {
            geocodeResult = await reverseGeocode(latitude, longitude);
            locationName = geocodeResult ? geocodeResult.displayName : null;
        } else if (typeof locationName === 'string') {
            // If locationName is a string (from search), we still need country info
            geocodeResult = await reverseGeocode(latitude, longitude);
        }
        document.getElementById('location-text').textContent = 
            `Location: ${locationName || `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`}`;
        
        // Get country info for national average
        const countryInfo = geocodeResult ? {
            name: geocodeResult.country,
            code: geocodeResult.countryCode
        } : await getCountryInfo(latitude, longitude);
        
        // Fetch current air quality data
        const currentAQ = await fetchAirQuality(latitude, longitude, 'current');
        
        // Try to fetch historical data, with fallback
        let historicalAQ = await fetchAirQuality(latitude, longitude, 'historical', HISTORICAL_YEAR);
        let actualYear = HISTORICAL_YEAR;
        
        // If historical data is all null/empty, try fallback year
        const historicalValues = Object.entries(historicalAQ || {})
            .filter(([key]) => key !== 'dataSource')
            .map(([, value]) => value);
        if (!historicalAQ || historicalValues.every(v => v === null)) {
            console.log(`No data for ${HISTORICAL_YEAR}, trying ${FALLBACK_YEAR}...`);
            historicalAQ = await fetchAirQuality(latitude, longitude, 'historical', FALLBACK_YEAR);
            const fallbackValues = Object.entries(historicalAQ || {})
                .filter(([key]) => key !== 'dataSource')
                .map(([, value]) => value);
            if (historicalAQ && fallbackValues.some(v => v !== null)) {
                actualYear = FALLBACK_YEAR;
            }
        }
        
        // Display comparison (pass data source from current data)
        displayComparison(currentAQ, historicalAQ, actualYear, currentAQ.dataSource);
        
        // Fetch national averages (in background, don't block on it)
        // Use the actualYear that was successfully fetched
        if (countryInfo) {
            getNationalAverage(countryInfo, actualYear).then(avgs => {
                if (avgs) {
                    // Update display with national averages (both current and historical)
                    // Pass location values so we can calculate deltas
                    displayNationalAverage(avgs.current, avgs.historical, countryInfo.name, currentAQ, historicalAQ);
                }
            }).catch(err => {
                console.warn('Failed to get national average:', err);
            });
        }
        
        // Show content, hide loading
        document.getElementById('loading').style.display = 'none';
        document.getElementById('content').style.display = 'block';
        
    } catch (error) {
        console.error('Error:', error);
        document.getElementById('loading').style.display = 'none';
        document.getElementById('error').style.display = 'block';
        document.getElementById('error-message').textContent = 
            `Error: ${error.message || 'Failed to fetch air quality data'}`;
    }
}

// Get user location and fetch air quality data
async function init() {
    try {
        const position = await getCurrentPosition();
        const { latitude, longitude } = position.coords;
        await fetchAndDisplayAQ(latitude, longitude);
    } catch (error) {
        console.error('Error:', error);
        document.getElementById('loading').style.display = 'none';
        document.getElementById('error').style.display = 'block';
        document.getElementById('error-message').textContent = 
            `Error: ${error.message || 'Failed to get location. Please search for a location instead.'}`;
    }
}

// Get user's current position
function getCurrentPosition() {
    return new Promise((resolve, reject) => {
        if (!navigator.geolocation) {
            reject(new Error('Geolocation is not supported by your browser'));
            return;
        }
        
        navigator.geolocation.getCurrentPosition(
            resolve,
            reject,
            { timeout: 10000, enableHighAccuracy: false }
        );
    });
}

// Search for location using Nominatim (forward geocoding)
async function searchLocation(query) {
    try {
        const response = await fetch(
            `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1&addressdetails=1`
        );
        const data = await response.json();
        if (data && data.length > 0) {
            const result = data[0];
            const lat = parseFloat(result.lat);
            const lon = parseFloat(result.lon);
            const name = result.display_name || query;
            return { latitude: lat, longitude: lon, name: name };
        }
    } catch (error) {
        console.error('Location search failed:', error);
        throw new Error('Failed to search location');
    }
    throw new Error('Location not found');
}

// Infer data source based on location and API response
function inferDataSource(latitude, longitude, apiResponse) {
    // Check if API response has any station or source information
    if (apiResponse && apiResponse.metadata && apiResponse.metadata.station) {
        return apiResponse.metadata.station;
    }
    
    // Determine source based on location
    // Rough geographic boundaries (using more inclusive ranges)
    // Europe: roughly 35°N to 71°N, 10°W to 40°E
    const isEurope = latitude >= 35 && latitude <= 71 && longitude >= -10 && longitude <= 40;
    
    // US: roughly 24°N to 72°N, 125°W to 66°W (includes Alaska and Hawaii)
    const isUS = (latitude >= 18 && latitude <= 72 && longitude >= -180 && longitude <= -66) ||
                 (latitude >= 18 && latitude <= 22 && longitude >= -161 && longitude <= -154); // Hawaii
    
    // Canada: roughly 41°N to 84°N, 141°W to 52°W
    const isCanada = latitude >= 41 && latitude <= 84 && longitude >= -141 && longitude <= -52;
    
    // Mexico: roughly 14°N to 33°N, 118°W to 86°W
    const isMexico = latitude >= 14 && latitude <= 33 && longitude >= -118 && longitude <= -86;
    
    if (isEurope) {
        return 'CAMS European Air Quality Reanalysis';
    } else if (isUS || isCanada || isMexico) {
        // For North America, OpenMeteo uses CAMS Global which may incorporate NOAA/Environment Canada data
        // but we can't get specific station info from the API
        return 'CAMS Global (may include NOAA/Environment Canada ground stations)';
    } else {
        return 'CAMS Global Reanalysis';
    }
}

// Reverse geocode to get location name using OpenStreetMap Nominatim
async function reverseGeocode(lat, lon) {
    try {
        const response = await fetch(
            `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=10&addressdetails=1`
        );
        const data = await response.json();
        if (data.address) {
            const city = data.address.city || data.address.town || data.address.village || '';
            const country = data.address.country || '';
            const countryCode = data.address.country_code?.toUpperCase() || '';
            if (city && country) {
                return { 
                    displayName: `${city}, ${country}`,
                    city: city,
                    country: country,
                    countryCode: countryCode
                };
            } else if (country) {
                return {
                    displayName: country,
                    city: '',
                    country: country,
                    countryCode: countryCode
                };
            }
        }
    } catch (error) {
        console.warn('Reverse geocoding failed:', error);
    }
    return null;
}

// Get country information from coordinates
async function getCountryInfo(lat, lon) {
    const geocodeResult = await reverseGeocode(lat, lon);
    if (geocodeResult) {
        return {
            name: geocodeResult.country,
            code: geocodeResult.countryCode
        };
    }
    return null;
}

// Get national average by sampling multiple locations across the country
// This is an approximation since OpenMeteo doesn't provide country-level averages
async function getNationalAverage(countryInfo, historicalYear = HISTORICAL_YEAR) {
    if (!countryInfo || !countryInfo.name) {
        return null;
    }
    
    // Sample locations: major cities or geographic centers
    // For now, we'll use a simplified approach: sample a few representative locations
    // Note: This is a rough approximation. For better accuracy, you'd want more samples
    const sampleLocations = getCountrySampleLocations(countryInfo.name, countryInfo.code);
    
    if (!sampleLocations || sampleLocations.length === 0) {
        return null;
    }
    
    // Fetch both current and historical data
    const currentSamples = [];
    const historicalSamples = [];
    
    for (const loc of sampleLocations.slice(0, 5)) { // Limit to 5 samples for performance
        try {
            // Fetch current data
            const currentAQ = await fetchAirQuality(loc.lat, loc.lon, 'current');
            if (currentAQ && (currentAQ.us_aqi || currentAQ.european_aqi || currentAQ.pm25 !== null)) {
                currentSamples.push(currentAQ);
            }
            
            // Fetch historical data
            let historicalAQ = await fetchAirQuality(loc.lat, loc.lon, 'historical', historicalYear);
            // If no data for primary year, try fallback
            if (!historicalAQ || Object.values(historicalAQ).filter((v, k) => k !== 'dataSource').every(v => v === null)) {
                historicalAQ = await fetchAirQuality(loc.lat, loc.lon, 'historical', FALLBACK_YEAR);
            }
            if (historicalAQ && (historicalAQ.us_aqi || historicalAQ.european_aqi || historicalAQ.pm25 !== null)) {
                historicalSamples.push(historicalAQ);
            }
        } catch (error) {
            console.warn(`Failed to fetch data for sample location ${loc.lat}, ${loc.lon}:`, error);
        }
    }
    
    // Calculate averages for current
    const currentAvg = currentSamples.length > 0 ? {
        pm25: average(currentSamples.map(s => s.pm25).filter(v => v !== null)),
        pm10: average(currentSamples.map(s => s.pm10).filter(v => v !== null)),
        carbon_monoxide: average(currentSamples.map(s => s.carbon_monoxide).filter(v => v !== null)),
        nitrogen_dioxide: average(currentSamples.map(s => s.nitrogen_dioxide).filter(v => v !== null)),
        ozone: average(currentSamples.map(s => s.ozone).filter(v => v !== null)),
        sulphur_dioxide: average(currentSamples.map(s => s.sulphur_dioxide).filter(v => v !== null)),
        us_aqi: average(currentSamples.map(s => s.us_aqi).filter(v => v !== null)),
        european_aqi: average(currentSamples.map(s => s.european_aqi).filter(v => v !== null)),
        dataSource: currentSamples[0]?.dataSource || 'Unknown'
    } : null;
    
    // Calculate averages for historical
    const historicalAvg = historicalSamples.length > 0 ? {
        pm25: average(historicalSamples.map(s => s.pm25).filter(v => v !== null)),
        pm10: average(historicalSamples.map(s => s.pm10).filter(v => v !== null)),
        carbon_monoxide: average(historicalSamples.map(s => s.carbon_monoxide).filter(v => v !== null)),
        nitrogen_dioxide: average(historicalSamples.map(s => s.nitrogen_dioxide).filter(v => v !== null)),
        ozone: average(historicalSamples.map(s => s.ozone).filter(v => v !== null)),
        sulphur_dioxide: average(historicalSamples.map(s => s.sulphur_dioxide).filter(v => v !== null)),
        us_aqi: average(historicalSamples.map(s => s.us_aqi).filter(v => v !== null)),
        european_aqi: average(historicalSamples.map(s => s.european_aqi).filter(v => v !== null)),
        dataSource: historicalSamples[0]?.dataSource || 'Unknown'
    } : null;
    
    return {
        current: currentAvg,
        historical: historicalAvg
    };
}

// Helper function to calculate average
function average(values) {
    if (!values || values.length === 0) return null;
    const sum = values.reduce((a, b) => a + b, 0);
    return sum / values.length;
}

// Get sample locations for a country (simplified - using major cities)
function getCountrySampleLocations(countryName, countryCode) {
    // This is a simplified mapping. For production, you'd want a more comprehensive database
    const countrySamples = {
        'United States': [
            { lat: 40.7128, lon: -74.0060, name: 'New York' },
            { lat: 34.0522, lon: -118.2437, name: 'Los Angeles' },
            { lat: 41.8781, lon: -87.6298, name: 'Chicago' },
            { lat: 29.7604, lon: -95.3698, name: 'Houston' },
            { lat: 38.9072, lon: -77.0369, name: 'Washington DC' }
        ],
        'Canada': [
            { lat: 43.6532, lon: -79.3832, name: 'Toronto' },
            { lat: 45.5017, lon: -73.5673, name: 'Montreal' },
            { lat: 49.2827, lon: -123.1207, name: 'Vancouver' },
            { lat: 51.0447, lon: -114.0719, name: 'Calgary' },
            { lat: 45.4247, lon: -75.6950, name: 'Ottawa' }
        ],
        'United Kingdom': [
            { lat: 51.5074, lon: -0.1278, name: 'London' },
            { lat: 53.4808, lon: -2.2426, name: 'Manchester' },
            { lat: 55.9533, lon: -3.1883, name: 'Edinburgh' },
            { lat: 52.4862, lon: -1.8904, name: 'Birmingham' },
            { lat: 53.8008, lon: -1.5491, name: 'Leeds' }
        ],
        'Germany': [
            { lat: 52.5200, lon: 13.4050, name: 'Berlin' },
            { lat: 48.1351, lon: 11.5820, name: 'Munich' },
            { lat: 50.9375, lon: 6.9603, name: 'Cologne' },
            { lat: 53.5511, lon: 9.9937, name: 'Hamburg' },
            { lat: 51.2277, lon: 6.7735, name: 'Düsseldorf' }
        ],
        'France': [
            { lat: 48.8566, lon: 2.3522, name: 'Paris' },
            { lat: 45.7640, lon: 4.8357, name: 'Lyon' },
            { lat: 43.2965, lon: 5.3698, name: 'Marseille' },
            { lat: 44.8378, lon: -0.5792, name: 'Bordeaux' },
            { lat: 43.7102, lon: 7.2620, name: 'Nice' }
        ],
        'China': [
            { lat: 39.9042, lon: 116.4074, name: 'Beijing' },
            { lat: 31.2304, lon: 121.4737, name: 'Shanghai' },
            { lat: 23.1291, lon: 113.2644, name: 'Guangzhou' },
            { lat: 30.5728, lon: 104.0668, name: 'Chengdu' },
            { lat: 34.3416, lon: 108.9398, name: 'Xi\'an' }
        ],
        'India': [
            { lat: 28.6139, lon: 77.2090, name: 'New Delhi' },
            { lat: 19.0760, lon: 72.8777, name: 'Mumbai' },
            { lat: 13.0827, lon: 80.2707, name: 'Chennai' },
            { lat: 12.9716, lon: 77.5946, name: 'Bangalore' },
            { lat: 22.5726, lon: 88.3639, name: 'Kolkata' }
        ],
        'Japan': [
            { lat: 35.6762, lon: 139.6503, name: 'Tokyo' },
            { lat: 34.6937, lon: 135.5023, name: 'Osaka' },
            { lat: 35.0116, lon: 135.7681, name: 'Kyoto' },
            { lat: 35.1815, lon: 136.9066, name: 'Nagoya' },
            { lat: 43.0642, lon: 141.3469, name: 'Sapporo' }
        ],
        'Australia': [
            { lat: -33.8688, lon: 151.2093, name: 'Sydney' },
            { lat: -37.8136, lon: 144.9631, name: 'Melbourne' },
            { lat: -27.4698, lon: 153.0251, name: 'Brisbane' },
            { lat: -31.9505, lon: 115.8605, name: 'Perth' },
            { lat: -34.9285, lon: 138.6007, name: 'Adelaide' }
        ],
        'Brazil': [
            { lat: -23.5505, lon: -46.6333, name: 'São Paulo' },
            { lat: -22.9068, lon: -43.1729, name: 'Rio de Janeiro' },
            { lat: -15.7942, lon: -47.8822, name: 'Brasília' },
            { lat: -12.9714, lon: -38.5014, name: 'Salvador' },
            { lat: -19.9167, lon: -43.9345, name: 'Belo Horizonte' }
        ]
    };
    
    // Try country name first, then country code
    return countrySamples[countryName] || countrySamples[countryCode] || null;
}

// Fetch air quality data from OpenMeteo
// mode: 'current' for today's data, 'historical' for past year
async function fetchAirQuality(latitude, longitude, mode = 'current', historicalYear = 2013) {
    let url;
    
    if (mode === 'historical') {
        // Format date as YYYY-MM-DD for historical query
        // Use the same month and day as today, but from the historical year
        const today = new Date();
        const histMonth = today.getMonth() + 1;
        const histDay = today.getDate();
        const historicalDate = `${historicalYear}-${String(histMonth).padStart(2, '0')}-${String(histDay).padStart(2, '0')}`;
        url = `https://air-quality-api.open-meteo.com/v1/air-quality?` +
            `latitude=${latitude}&longitude=${longitude}&` +
            `start_date=${historicalDate}&end_date=${historicalDate}&` +
            `hourly=pm10,pm2_5,carbon_monoxide,nitrogen_dioxide,ozone,sulphur_dioxide,european_aqi,us_aqi&` +
            `timezone=auto`;
    } else {
        // Current data
        url = `https://air-quality-api.open-meteo.com/v1/air-quality?` +
            `latitude=${latitude}&longitude=${longitude}&` +
            `current=pm10,pm2_5,carbon_monoxide,nitrogen_dioxide,ozone,sulphur_dioxide,european_aqi,us_aqi&` +
            `hourly=pm10,pm2_5,carbon_monoxide,nitrogen_dioxide,ozone,sulphur_dioxide,european_aqi,us_aqi&` +
            `timezone=auto`;
    }
    
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`API request failed: ${response.status}`);
    }
    
    const data = await response.json();
    
    // Debug: log the response structure
    console.log(`API Response (${mode}):`, data);
    
    // Extract data source information if available
    // OpenMeteo doesn't provide specific station info, but we can infer the source
    const dataSource = inferDataSource(latitude, longitude, data);
    console.log(`Inferred data source for ${latitude}, ${longitude}:`, dataSource);
    
    // Check if we have either current or hourly data
    if ((!data.current || Object.keys(data.current).length === 0) && 
        (!data.hourly || !data.hourly.time || data.hourly.time.length === 0)) {
        if (mode === 'historical') {
            // For historical, return null values instead of throwing
            console.warn(`No historical data available for ${historicalYear}`);
            const dataSource = inferDataSource(latitude, longitude, data);
            return {
                pm25: null, pm10: null, carbon_monoxide: null,
                nitrogen_dioxide: null, ozone: null, sulphur_dioxide: null,
                european_aqi: null, us_aqi: null,
                dataSource: dataSource
            };
        }
        throw new Error('No air quality data available');
    }
    
    // For historical data, get the first (and likely only) hour's data
    // For current data, prefer current values, otherwise use latest hourly
    let latestIndex = 0;
    if (data.hourly && data.hourly.time && data.hourly.time.length > 0) {
        latestIndex = mode === 'historical' ? 0 : data.hourly.time.length - 1;
    }
    
    // Prefer current values if available, otherwise use hourly
    const result = {
        pm25: data.current?.pm2_5 ?? data.hourly?.pm2_5?.[latestIndex] ?? null,
        pm10: data.current?.pm10 ?? data.hourly?.pm10?.[latestIndex] ?? null,
        carbon_monoxide: data.current?.carbon_monoxide ?? data.hourly?.carbon_monoxide?.[latestIndex] ?? null,
        nitrogen_dioxide: data.current?.nitrogen_dioxide ?? data.hourly?.nitrogen_dioxide?.[latestIndex] ?? null,
        ozone: data.current?.ozone ?? data.hourly?.ozone?.[latestIndex] ?? null,
        sulphur_dioxide: data.current?.sulphur_dioxide ?? data.hourly?.sulphur_dioxide?.[latestIndex] ?? null,
        european_aqi: data.current?.european_aqi ?? data.hourly?.european_aqi?.[latestIndex] ?? null,
        us_aqi: data.current?.us_aqi ?? data.hourly?.us_aqi?.[latestIndex] ?? null
    };
    
    console.log(`Parsed air quality data (${mode}):`, result);
    
    // Include data source in result (infer it here since we have lat/lon)
    result.dataSource = inferDataSource(latitude, longitude, data);
    
    return result;
}

// Calculate percentage change
// Returns null if historical is null/undefined
// Returns special object {wasZero: true, current} if historical is 0
// Returns number (percentage) otherwise
function calculateChange(current, historical) {
    if (historical === null || historical === undefined) return null;
    if (historical === 0) {
        // Historical was 0, return special indicator
        return { wasZero: true, current: current };
    }
    const change = ((current - historical) / historical) * 100;
    return change;
}

// Format date as "Jan 16, 2023"
function formatDate(date) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const month = months[date.getMonth()];
    const day = date.getDate();
    const year = date.getFullYear();
    return `${month} ${day}, ${year}`;
}

// Format change display
// For metrics where lower is better (like AQI), invert the color logic
function formatChange(change, lowerIsBetter = false) {
    if (change === null) return { text: 'N/A', className: 'neutral' };
    
    // Handle case where historical was 0
    if (typeof change === 'object' && change.wasZero) {
        const current = change.current;
        if (current === null || current === undefined || isNaN(current)) {
            return { text: 'N/A', className: 'neutral' };
        }
        if (current === 0) {
            return { text: '0%', className: 'neutral' };
        }
        // Historical was 0, current is non-zero: show as "New" or absolute change
        // For air quality, if current > 0 and historical was 0, that's bad (red for lowerIsBetter)
        const className = lowerIsBetter ? 'negative' : 'positive';
        return { text: 'New', className: className };
    }
    
    // Normal percentage change
    const sign = change > 0 ? '+' : '';
    let className;
    if (lowerIsBetter) {
        // For AQI: negative change (decrease) is good (green), positive change (increase) is bad (red)
        className = change > 0 ? 'negative' : change < 0 ? 'positive' : 'neutral';
    } else {
        // Default: positive is good (green), negative is bad (red)
        className = change > 0 ? 'positive' : change < 0 ? 'negative' : 'neutral';
    }
    return { text: `${sign}${change.toFixed(1)}%`, className };
}

// Calculate percentage delta vs average
// For air quality metrics, lower is better, so negative delta is good
function calculateDelta(locationValue, averageValue) {
    if (locationValue === null || averageValue === null || 
        locationValue === undefined || averageValue === undefined ||
        isNaN(locationValue) || isNaN(averageValue) || averageValue === 0) {
        return null;
    }
    return ((locationValue - averageValue) / averageValue) * 100;
}

// Format delta as text
function formatDelta(delta, label = 'national') {
    if (delta === null) return '';
    const sign = delta > 0 ? '+' : '';
    return `(${sign}${delta.toFixed(0)}% vs ${label})`;
}

// Get comparison class for national average
// For air quality, lower is better
// If national average is higher (worse) than location → red (worse)
// If national average is lower (better) than location → green (better)
function getNationalAvgClass(locationValue, nationalValue) {
    if (locationValue === null || nationalValue === null || 
        locationValue === undefined || nationalValue === undefined ||
        isNaN(locationValue) || isNaN(nationalValue)) {
        return 'neutral';
    }
    if (nationalValue > locationValue) {
        return 'worse'; // National is worse (higher) than location
    } else if (nationalValue < locationValue) {
        return 'better'; // National is better (lower) than location
    } else {
        return 'neutral';
    }
}

// Display national average data
function displayNationalAverage(currentAvg, historicalAvg, countryName, currentAQ, historicalAQ) {
    if (!countryName) return;
    
    // Update national label with country name
    const nationalLabels = document.querySelectorAll('.national-label');
    nationalLabels.forEach(el => {
        el.textContent = `${countryName} Avg`;
    });
    
    // Helper function to format value or show "—"
    function formatValue(value) {
        if (value === null || value === undefined) {
            return '—';
        }
        const numValue = Number(value);
        if (isNaN(numValue)) {
            return '—';
        }
        return Math.round(numValue);
    }
    
    // Display historical national averages (for 2023 column)
    if (historicalAvg && historicalAQ) {
        // AQI
        const aqiHistVal = formatValue(historicalAvg.us_aqi ?? historicalAvg.european_aqi);
        const aqiHistEl = document.getElementById('aqi-national-historical');
        const aqiHistLocation = historicalAQ.us_aqi ?? historicalAQ.european_aqi ?? null;
        const aqiHistNational = historicalAvg.us_aqi ?? historicalAvg.european_aqi ?? null;
        if (aqiHistEl) {
            aqiHistEl.textContent = aqiHistVal;
            aqiHistEl.className = `national-avg-value ${getNationalAvgClass(aqiHistLocation, aqiHistNational)}`;
        }
        const aqiHistDelta = calculateDelta(aqiHistLocation, aqiHistNational);
        const aqiHistDeltaEl = document.getElementById('aqi-delta-historical');
        if (aqiHistDeltaEl) aqiHistDeltaEl.textContent = formatDelta(aqiHistDelta);
        
        // PM2.5
        const pm25HistVal = formatValue(historicalAvg.pm25);
        const pm25HistEl = document.getElementById('pm25-national-historical');
        if (pm25HistEl) {
            pm25HistEl.textContent = pm25HistVal;
            pm25HistEl.className = `national-avg-value ${getNationalAvgClass(historicalAQ.pm25, historicalAvg.pm25)}`;
        }
        const pm25HistDelta = calculateDelta(historicalAQ.pm25, historicalAvg.pm25);
        const pm25HistDeltaEl = document.getElementById('pm25-delta-historical');
        if (pm25HistDeltaEl) pm25HistDeltaEl.textContent = formatDelta(pm25HistDelta);
        
        // PM10
        const pm10HistVal = formatValue(historicalAvg.pm10);
        const pm10HistEl = document.getElementById('pm10-national-historical');
        if (pm10HistEl) {
            pm10HistEl.textContent = pm10HistVal;
            pm10HistEl.className = `national-avg-value ${getNationalAvgClass(historicalAQ.pm10, historicalAvg.pm10)}`;
        }
        const pm10HistDelta = calculateDelta(historicalAQ.pm10, historicalAvg.pm10);
        const pm10HistDeltaEl = document.getElementById('pm10-delta-historical');
        if (pm10HistDeltaEl) pm10HistDeltaEl.textContent = formatDelta(pm10HistDelta);
        
        // CO
        const coHistVal = formatValue(historicalAvg.carbon_monoxide);
        const coHistEl = document.getElementById('co-national-historical');
        if (coHistEl) {
            coHistEl.textContent = coHistVal;
            coHistEl.className = `national-avg-value ${getNationalAvgClass(historicalAQ.carbon_monoxide, historicalAvg.carbon_monoxide)}`;
        }
        const coHistDelta = calculateDelta(historicalAQ.carbon_monoxide, historicalAvg.carbon_monoxide);
        const coHistDeltaEl = document.getElementById('co-delta-historical');
        if (coHistDeltaEl) coHistDeltaEl.textContent = formatDelta(coHistDelta);
        
        // NO2
        const no2HistVal = formatValue(historicalAvg.nitrogen_dioxide);
        const no2HistEl = document.getElementById('no2-national-historical');
        if (no2HistEl) {
            no2HistEl.textContent = no2HistVal;
            no2HistEl.className = `national-avg-value ${getNationalAvgClass(historicalAQ.nitrogen_dioxide, historicalAvg.nitrogen_dioxide)}`;
        }
        const no2HistDelta = calculateDelta(historicalAQ.nitrogen_dioxide, historicalAvg.nitrogen_dioxide);
        const no2HistDeltaEl = document.getElementById('no2-delta-historical');
        if (no2HistDeltaEl) no2HistDeltaEl.textContent = formatDelta(no2HistDelta);
        
        // O3
        const o3HistVal = formatValue(historicalAvg.ozone);
        const o3HistEl = document.getElementById('o3-national-historical');
        if (o3HistEl) {
            o3HistEl.textContent = o3HistVal;
            o3HistEl.className = `national-avg-value ${getNationalAvgClass(historicalAQ.ozone, historicalAvg.ozone)}`;
        }
        const o3HistDelta = calculateDelta(historicalAQ.ozone, historicalAvg.ozone);
        const o3HistDeltaEl = document.getElementById('o3-delta-historical');
        if (o3HistDeltaEl) o3HistDeltaEl.textContent = formatDelta(o3HistDelta);
        
        // SO2
        const so2HistVal = formatValue(historicalAvg.sulphur_dioxide);
        const so2HistEl = document.getElementById('so2-national-historical');
        if (so2HistEl) {
            so2HistEl.textContent = so2HistVal;
            so2HistEl.className = `national-avg-value ${getNationalAvgClass(historicalAQ.sulphur_dioxide, historicalAvg.sulphur_dioxide)}`;
        }
        const so2HistDelta = calculateDelta(historicalAQ.sulphur_dioxide, historicalAvg.sulphur_dioxide);
        const so2HistDeltaEl = document.getElementById('so2-delta-historical');
        if (so2HistDeltaEl) so2HistDeltaEl.textContent = formatDelta(so2HistDelta);
    }
    
    // Display current national averages (for Today column)
    if (currentAvg && currentAQ) {
        // AQI
        const aqiTodayVal = formatValue(currentAvg.us_aqi ?? currentAvg.european_aqi);
        const aqiTodayEl = document.getElementById('aqi-national-today');
        const aqiTodayLocation = currentAQ.us_aqi ?? currentAQ.european_aqi ?? null;
        const aqiTodayNational = currentAvg.us_aqi ?? currentAvg.european_aqi ?? null;
        if (aqiTodayEl) {
            aqiTodayEl.textContent = aqiTodayVal;
            aqiTodayEl.className = `national-avg-value ${getNationalAvgClass(aqiTodayLocation, aqiTodayNational)}`;
        }
        const aqiTodayDelta = calculateDelta(aqiTodayLocation, aqiTodayNational);
        const aqiTodayDeltaEl = document.getElementById('aqi-delta-today');
        if (aqiTodayDeltaEl) aqiTodayDeltaEl.textContent = formatDelta(aqiTodayDelta);
        
        // PM2.5
        const pm25TodayVal = formatValue(currentAvg.pm25);
        const pm25TodayEl = document.getElementById('pm25-national-today');
        if (pm25TodayEl) {
            pm25TodayEl.textContent = pm25TodayVal;
            pm25TodayEl.className = `national-avg-value ${getNationalAvgClass(currentAQ.pm25, currentAvg.pm25)}`;
        }
        const pm25TodayDelta = calculateDelta(currentAQ.pm25, currentAvg.pm25);
        const pm25TodayDeltaEl = document.getElementById('pm25-delta-today');
        if (pm25TodayDeltaEl) pm25TodayDeltaEl.textContent = formatDelta(pm25TodayDelta);
        
        // PM10
        const pm10TodayVal = formatValue(currentAvg.pm10);
        const pm10TodayEl = document.getElementById('pm10-national-today');
        if (pm10TodayEl) {
            pm10TodayEl.textContent = pm10TodayVal;
            pm10TodayEl.className = `national-avg-value ${getNationalAvgClass(currentAQ.pm10, currentAvg.pm10)}`;
        }
        const pm10TodayDelta = calculateDelta(currentAQ.pm10, currentAvg.pm10);
        const pm10TodayDeltaEl = document.getElementById('pm10-delta-today');
        if (pm10TodayDeltaEl) pm10TodayDeltaEl.textContent = formatDelta(pm10TodayDelta);
        
        // CO
        const coTodayVal = formatValue(currentAvg.carbon_monoxide);
        const coTodayEl = document.getElementById('co-national-today');
        if (coTodayEl) {
            coTodayEl.textContent = coTodayVal;
            coTodayEl.className = `national-avg-value ${getNationalAvgClass(currentAQ.carbon_monoxide, currentAvg.carbon_monoxide)}`;
        }
        const coTodayDelta = calculateDelta(currentAQ.carbon_monoxide, currentAvg.carbon_monoxide);
        const coTodayDeltaEl = document.getElementById('co-delta-today');
        if (coTodayDeltaEl) coTodayDeltaEl.textContent = formatDelta(coTodayDelta);
        
        // NO2
        const no2TodayVal = formatValue(currentAvg.nitrogen_dioxide);
        const no2TodayEl = document.getElementById('no2-national-today');
        if (no2TodayEl) {
            no2TodayEl.textContent = no2TodayVal;
            no2TodayEl.className = `national-avg-value ${getNationalAvgClass(currentAQ.nitrogen_dioxide, currentAvg.nitrogen_dioxide)}`;
        }
        const no2TodayDelta = calculateDelta(currentAQ.nitrogen_dioxide, currentAvg.nitrogen_dioxide);
        const no2TodayDeltaEl = document.getElementById('no2-delta-today');
        if (no2TodayDeltaEl) no2TodayDeltaEl.textContent = formatDelta(no2TodayDelta);
        
        // O3
        const o3TodayVal = formatValue(currentAvg.ozone);
        const o3TodayEl = document.getElementById('o3-national-today');
        if (o3TodayEl) {
            o3TodayEl.textContent = o3TodayVal;
            o3TodayEl.className = `national-avg-value ${getNationalAvgClass(currentAQ.ozone, currentAvg.ozone)}`;
        }
        const o3TodayDelta = calculateDelta(currentAQ.ozone, currentAvg.ozone);
        const o3TodayDeltaEl = document.getElementById('o3-delta-today');
        if (o3TodayDeltaEl) o3TodayDeltaEl.textContent = formatDelta(o3TodayDelta);
        
        // SO2
        const so2TodayVal = formatValue(currentAvg.sulphur_dioxide);
        const so2TodayEl = document.getElementById('so2-national-today');
        if (so2TodayEl) {
            so2TodayEl.textContent = so2TodayVal;
            so2TodayEl.className = `national-avg-value ${getNationalAvgClass(currentAQ.sulphur_dioxide, currentAvg.sulphur_dioxide)}`;
        }
        const so2TodayDelta = calculateDelta(currentAQ.sulphur_dioxide, currentAvg.sulphur_dioxide);
        const so2TodayDeltaEl = document.getElementById('so2-delta-today');
        if (so2TodayDeltaEl) so2TodayDeltaEl.textContent = formatDelta(so2TodayDelta);
    }
}

// Display comparison between today and historical year
function displayComparison(currentAQ, historicalAQ, actualYear = HISTORICAL_YEAR, dataSource = 'Unknown') {
    console.log('Displaying comparison for:', { current: currentAQ, historical: historicalAQ, year: actualYear, dataSource });
    
    // Display data source information
    const dataSourceEl = document.getElementById('data-source');
    if (dataSourceEl) {
        dataSourceEl.textContent = `Data source: ${dataSource}`;
    }
    
    // Helper function to format value or show "N/A"
    function formatValue(value) {
        if (value === null || value === undefined) {
            return 'N/A';
        }
        const numValue = Number(value);
        if (isNaN(numValue)) {
            return 'N/A';
        }
        return Math.round(numValue);
    }
    
    // Format dates
    const todayDate = new Date();
    const historicalDate = new Date(actualYear, todayDate.getMonth(), todayDate.getDate());
    const todayFormatted = formatDate(todayDate);
    const historicalFormatted = formatDate(historicalDate);
    
    // Update the displayed dates in the subtitle
    const historicalYearEl = document.getElementById('historical-year');
    if (historicalYearEl) {
        historicalYearEl.textContent = historicalFormatted;
    }
    const todayYearEl = document.getElementById('today-year');
    if (todayYearEl) {
        todayYearEl.textContent = todayFormatted;
    }
    
    // Update all historical date labels
    const historicalLabelEls = document.querySelectorAll('.historical-date-label, #historical-date-label');
    historicalLabelEls.forEach(el => {
        el.textContent = historicalFormatted;
    });
    
    // Update all today date labels
    const todayLabelEls = document.querySelectorAll('.today-date-label, #today-date-label');
    todayLabelEls.forEach(el => {
        el.textContent = todayFormatted;
    });
    
    // AQI comparison (lower is better, so invert color logic)
    const aqiTodayValue = currentAQ.us_aqi ?? currentAQ.european_aqi ?? null;
    const aqiToday = aqiTodayValue !== null ? Math.round(aqiTodayValue) : 0;
    const aqiHistoricalValue = historicalAQ?.us_aqi ?? historicalAQ?.european_aqi ?? null;
    const aqiHistorical = aqiHistoricalValue !== null ? Math.round(aqiHistoricalValue) : null;
    const aqiChange = aqiHistorical !== null ? calculateChange(aqiToday, aqiHistorical) : null;
    const aqiChangeFormatted = formatChange(aqiChange, true); // true = lower is better
    
    document.getElementById('aqi-today').textContent = formatValue(aqiTodayValue);
    document.getElementById(`aqi-${actualYear}`).textContent = formatValue(aqiHistoricalValue);
    const aqiChangeEl = document.getElementById('aqi-change');
    if (aqiChange !== null && aqiTodayValue !== null) {
        aqiChangeEl.textContent = aqiChangeFormatted.text;
        aqiChangeEl.className = `change ${aqiChangeFormatted.className}`;
    } else {
        aqiChangeEl.textContent = 'N/A';
        aqiChangeEl.className = 'change neutral';
    }
    
    // PM2.5 comparison (lower is better)
    const pm25TodayValue = currentAQ.pm25;
    const pm25Today = pm25TodayValue !== null ? Math.round(pm25TodayValue) : 0;
    const pm25HistoricalValue = historicalAQ?.pm25 ?? null;
    const pm25Historical = pm25HistoricalValue !== null ? Math.round(pm25HistoricalValue) : null;
    const pm25Change = pm25Historical !== null ? calculateChange(pm25Today, pm25Historical) : null;
    const pm25ChangeFormatted = formatChange(pm25Change, true); // true = lower is better
    
    document.getElementById('pm25-today').textContent = formatValue(pm25TodayValue);
    document.getElementById(`pm25-${actualYear}`).textContent = formatValue(pm25HistoricalValue);
    const pm25ChangeEl = document.getElementById('pm25-change');
    if (pm25Change !== null && pm25TodayValue !== null) {
        pm25ChangeEl.textContent = pm25ChangeFormatted.text;
        pm25ChangeEl.className = `change ${pm25ChangeFormatted.className}`;
    } else {
        pm25ChangeEl.textContent = 'N/A';
        pm25ChangeEl.className = 'change neutral';
    }
    
    // PM10 comparison (lower is better)
    const pm10TodayValue = currentAQ.pm10;
    const pm10Today = pm10TodayValue !== null ? Math.round(pm10TodayValue) : 0;
    const pm10HistoricalValue = historicalAQ?.pm10 ?? null;
    const pm10Historical = pm10HistoricalValue !== null ? Math.round(pm10HistoricalValue) : null;
    const pm10Change = pm10Historical !== null ? calculateChange(pm10Today, pm10Historical) : null;
    const pm10ChangeFormatted = formatChange(pm10Change, true); // true = lower is better
    
    document.getElementById('pm10-today').textContent = formatValue(pm10TodayValue);
    document.getElementById(`pm10-${actualYear}`).textContent = formatValue(pm10HistoricalValue);
    const pm10ChangeEl = document.getElementById('pm10-change');
    if (pm10Change !== null && pm10TodayValue !== null) {
        pm10ChangeEl.textContent = pm10ChangeFormatted.text;
        pm10ChangeEl.className = `change ${pm10ChangeFormatted.className}`;
    } else {
        pm10ChangeEl.textContent = 'N/A';
        pm10ChangeEl.className = 'change neutral';
    }
    
    // CO comparison (lower is better)
    const coTodayValue = currentAQ.carbon_monoxide;
    const coToday = coTodayValue !== null ? Math.round(coTodayValue) : 0;
    const coHistoricalValue = historicalAQ?.carbon_monoxide ?? null;
    const coHistorical = coHistoricalValue !== null ? Math.round(coHistoricalValue) : null;
    const coChange = coHistorical !== null ? calculateChange(coToday, coHistorical) : null;
    const coChangeFormatted = formatChange(coChange, true); // true = lower is better
    
    document.getElementById('co-today').textContent = formatValue(coTodayValue);
    document.getElementById(`co-${actualYear}`).textContent = formatValue(coHistoricalValue);
    const coChangeEl = document.getElementById('co-change');
    if (coChange !== null && coTodayValue !== null) {
        coChangeEl.textContent = coChangeFormatted.text;
        coChangeEl.className = `change ${coChangeFormatted.className}`;
    } else {
        coChangeEl.textContent = 'N/A';
        coChangeEl.className = 'change neutral';
    }
    
    // NO2 comparison (lower is better)
    const no2TodayValue = currentAQ.nitrogen_dioxide;
    const no2Today = no2TodayValue !== null ? Math.round(no2TodayValue) : 0;
    const no2HistoricalValue = historicalAQ?.nitrogen_dioxide ?? null;
    const no2Historical = no2HistoricalValue !== null ? Math.round(no2HistoricalValue) : null;
    const no2Change = no2Historical !== null ? calculateChange(no2Today, no2Historical) : null;
    const no2ChangeFormatted = formatChange(no2Change, true); // true = lower is better
    
    document.getElementById('no2-today').textContent = formatValue(no2TodayValue);
    document.getElementById(`no2-${actualYear}`).textContent = formatValue(no2HistoricalValue);
    const no2ChangeEl = document.getElementById('no2-change');
    if (no2Change !== null && no2TodayValue !== null) {
        no2ChangeEl.textContent = no2ChangeFormatted.text;
        no2ChangeEl.className = `change ${no2ChangeFormatted.className}`;
    } else {
        no2ChangeEl.textContent = 'N/A';
        no2ChangeEl.className = 'change neutral';
    }
    
    // O3 comparison (lower is better)
    const o3TodayValue = currentAQ.ozone;
    const o3Today = o3TodayValue !== null ? Math.round(o3TodayValue) : 0;
    const o3HistoricalValue = historicalAQ?.ozone ?? null;
    const o3Historical = o3HistoricalValue !== null ? Math.round(o3HistoricalValue) : null;
    const o3Change = o3Historical !== null ? calculateChange(o3Today, o3Historical) : null;
    const o3ChangeFormatted = formatChange(o3Change, true); // true = lower is better
    
    document.getElementById('o3-today').textContent = formatValue(o3TodayValue);
    document.getElementById(`o3-${actualYear}`).textContent = formatValue(o3HistoricalValue);
    const o3ChangeEl = document.getElementById('o3-change');
    if (o3Change !== null && o3TodayValue !== null) {
        o3ChangeEl.textContent = o3ChangeFormatted.text;
        o3ChangeEl.className = `change ${o3ChangeFormatted.className}`;
    } else {
        o3ChangeEl.textContent = 'N/A';
        o3ChangeEl.className = 'change neutral';
    }
    
    // SO2 comparison (lower is better)
    const so2TodayValue = currentAQ.sulphur_dioxide;
    const so2Today = so2TodayValue !== null ? Math.round(so2TodayValue) : 0;
    const so2HistoricalValue = historicalAQ?.sulphur_dioxide ?? null;
    const so2Historical = so2HistoricalValue !== null ? Math.round(so2HistoricalValue) : null;
    const so2Change = so2Historical !== null ? calculateChange(so2Today, so2Historical) : null;
    const so2ChangeFormatted = formatChange(so2Change, true); // true = lower is better
    
    document.getElementById('so2-today').textContent = formatValue(so2TodayValue);
    document.getElementById(`so2-${actualYear}`).textContent = formatValue(so2HistoricalValue);
    const so2ChangeEl = document.getElementById('so2-change');
    if (so2Change !== null && so2TodayValue !== null) {
        so2ChangeEl.textContent = so2ChangeFormatted.text;
        so2ChangeEl.className = `change ${so2ChangeFormatted.className}`;
    } else {
        so2ChangeEl.textContent = 'N/A';
        so2ChangeEl.className = 'change neutral';
    }
}

// Set up search functionality
function setupSearchHandlers() {
    const searchInput = document.getElementById('location-search');
    const searchButton = document.getElementById('search-button');
    const useLocationButton = document.getElementById('use-location-button');
    
    if (!searchInput || !searchButton || !useLocationButton) {
        console.error('Search elements not found', { searchInput, searchButton, useLocationButton });
        return;
    }
    
    console.log('Setting up search handlers');
    
    // Search on button click
    searchButton.addEventListener('click', async () => {
        const query = searchInput.value.trim();
        if (!query) {
            alert('Please enter a location');
            return;
        }
        
        console.log('Searching for:', query);
        try {
            const location = await searchLocation(query);
            console.log('Found location:', location);
            // Pass location name as string - fetchAndDisplayAQ will handle geocoding for country info
            await fetchAndDisplayAQ(location.latitude, location.longitude, location.name);
        } catch (error) {
            console.error('Search error:', error);
            alert(error.message || 'Failed to find location');
        }
    });
    
    // Search on Enter key
    searchInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            searchButton.click();
        }
    });
    
    // Use current location
    useLocationButton.addEventListener('click', async () => {
        try {
            const position = await getCurrentPosition();
            const { latitude, longitude } = position.coords;
            await fetchAndDisplayAQ(latitude, longitude);
        } catch (error) {
            alert(error.message || 'Failed to get your location');
        }
    });
}

// Initialize app when page loads
// Since script is at end of body, DOM should be ready, but handle both cases
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        setupSearchHandlers();
        init();
    });
} else {
    // DOM is already loaded
    setupSearchHandlers();
    init();
}
