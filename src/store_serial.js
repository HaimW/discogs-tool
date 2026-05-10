// ============ Store — Country Codes & Serial Utilities ============

var COUNTRY_CODES = {
    'Afghanistan': 'AF', 'Albania': 'AL', 'Algeria': 'DZ', 'Andorra': 'AD',
    'Angola': 'AO', 'Argentina': 'AR', 'Armenia': 'AM', 'Australia': 'AU',
    'Austria': 'AT', 'Azerbaijan': 'AZ', 'Belgium': 'BE', 'Bolivia': 'BO',
    'Bosnia': 'BA', 'Bosnia and Herzegovina': 'BA', 'Brazil': 'BR',
    'Bulgaria': 'BG', 'Canada': 'CA', 'Chile': 'CL', 'China': 'CN',
    'Colombia': 'CO', 'Costa Rica': 'CR', 'Croatia': 'HR', 'Cuba': 'CU',
    'Cyprus': 'CY', 'Czech Republic': 'CZ', 'Czechoslovakia': 'CS',
    'Denmark': 'DK', 'Ecuador': 'EC', 'Egypt': 'EG', 'Estonia': 'EE',
    'Europe': 'EU', 'Finland': 'FI', 'France': 'FR', 'Germany': 'DE',
    'East Germany': 'DD', 'West Germany': 'DE', 'Ghana': 'GH',
    'Greece': 'GR', 'Guatemala': 'GT', 'Hong Kong': 'HK', 'Hungary': 'HU',
    'Iceland': 'IS', 'India': 'IN', 'Indonesia': 'ID', 'Iran': 'IR',
    'Iraq': 'IQ', 'Ireland': 'IE', 'Israel': 'IL', 'Italy': 'IT',
    'Jamaica': 'JM', 'Japan': 'JP', 'Jordan': 'JO', 'Kenya': 'KE',
    'Latvia': 'LV', 'Lebanon': 'LB', 'Lithuania': 'LT', 'Luxembourg': 'LU',
    'Malaysia': 'MY', 'Malta': 'MT', 'Mexico': 'MX', 'Morocco': 'MA',
    'Netherlands': 'NL', 'New Zealand': 'NZ', 'Nigeria': 'NG', 'Norway': 'NO',
    'Pakistan': 'PK', 'Panama': 'PA', 'Peru': 'PE', 'Philippines': 'PH',
    'Poland': 'PL', 'Portugal': 'PT', 'Romania': 'RO', 'Russia': 'RU',
    'Saudi Arabia': 'SA', 'Serbia': 'RS', 'Singapore': 'SG', 'Slovakia': 'SK',
    'Slovenia': 'SI', 'South Africa': 'ZA', 'South Korea': 'KR',
    'Korea': 'KR', 'Spain': 'ES', 'Sri Lanka': 'LK', 'Sweden': 'SE',
    'Switzerland': 'CH', 'Taiwan': 'TW', 'Thailand': 'TH', 'Tunisia': 'TN',
    'Turkey': 'TR', 'Ukraine': 'UA', 'UK': 'UK', 'United Kingdom': 'UK',
    'Great Britain': 'UK', 'Uruguay': 'UY', 'US': 'US', 'USA': 'US',
    'United States': 'US', 'USSR': 'SU', 'Soviet Union': 'SU',
    'Venezuela': 'VE', 'Vietnam': 'VN', 'Worldwide': 'WW',
    'Yugoslavia': 'YU', 'Zimbabwe': 'ZW'
};

function countryToCode(name) {
    if (!name) return 'XX';
    var trimmed = name.trim();
    if (!trimmed) return 'XX';
    if (COUNTRY_CODES[trimmed]) return COUNTRY_CODES[trimmed];
    var upper = trimmed.toUpperCase();
    for (var k in COUNTRY_CODES) {
        if (k.toUpperCase() === upper) return COUNTRY_CODES[k];
    }
    if (/^[A-Z]{2}$/i.test(trimmed)) return trimmed.toUpperCase();
    return 'XX';
}

function getSerialPrefix(countryStr) {
    if (!countryStr || !countryStr.trim()) return 'XX';
    var parts = countryStr.split(/[\/,]/).map(function (p) { return p.trim(); }).filter(Boolean);
    if (!parts.length) return 'XX';
    var codes = parts.map(countryToCode);
    codes = codes.filter(function (c, i, arr) { return arr.indexOf(c) === i; });
    codes.sort();
    return codes.slice(0, 2).join('-');
}

function getNextSerial(prefix, existingItems) {
    var prefixUpper = prefix.toUpperCase() + '-';
    var max = 0;
    existingItems.forEach(function (item) {
        if (!item.serial) return;
        var s = item.serial.toUpperCase();
        if (s.indexOf(prefixUpper) === 0) {
            var num = parseInt(s.slice(prefixUpper.length), 10);
            if (!isNaN(num) && num > max) max = num;
        }
    });
    return prefix + '-' + String(max + 1).padStart(3, '0');
}

function isSerialTaken(serial, existingItems, excludeId) {
    var norm = serial.toUpperCase().trim();
    return existingItems.some(function (item) {
        if (item.id === excludeId) return false;
        return (item.serial || '').toUpperCase().trim() === norm;
    });
}

async function runSerialization(releasesToSerialize) {
    var existingItems = await dbGetAll('store_items');

    for (var i = 0; i < releasesToSerialize.length; i++) {
        var rel = releasesToSerialize[i];
        var alreadyIn = existingItems.some(function (s) { return s.id === rel.id; });
        if (alreadyIn) continue;

        var prefix = getSerialPrefix(rel.country);
        var serial = getNextSerial(prefix, existingItems);
        var newItem = {
            id: rel.id,
            serial: serial,
            manual_serial: false,
            store_status: 'active',
            sold_date: null,
            sold_price: null,
            batch_id: null,
            median_price: null,
            median_price_currency: null,
            median_price_updated_at: null,
            added_at: new Date().toISOString()
        };
        await dbPut('store_items', newItem);
        existingItems.push(newItem);
    }
}
