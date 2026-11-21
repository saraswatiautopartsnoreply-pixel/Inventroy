function parseRows(source) {
  const rows = []; let row = []; let field = ''; let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') { field += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[index + 1] === '\n') index += 1;
      row.push(field); if (row.some((value) => value.trim())) rows.push(row); row = []; field = '';
    } else field += char;
  }
  row.push(field); if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

export function parseProductCsv(source) {
  const rows = parseRows(source.replace(/^\uFEFF/, ''));
  if (rows.length < 2) throw new Error('The CSV needs a header row and at least one product row.');
  const headers = rows[0].map((header) => header.trim().toLowerCase().replaceAll(' ', ''));
  const index = (key) => headers.indexOf(key);
  const value = (row, key) => { const position = index(key); return position < 0 ? '' : String(row[position] || '').trim(); };
  if (index('sku') < 0 || index('name') < 0 || index('brand') < 0) throw new Error('CSV must include sku, name and brand columns.');
  const grouped = new Map();
  rows.slice(1).forEach((row, rowIndex) => {
    const sku = value(row, 'sku').toUpperCase();
    if (!sku) return;
    let rowFitments = [];
    try { const parsed = JSON.parse(value(row, 'fitments')); if (Array.isArray(parsed)) rowFitments = parsed; } catch { /* fall back to the single fitment columns */ }
    if (!rowFitments.length) {
      const fitment = { make: value(row, 'vehiclemake'), model: value(row, 'vehiclemodel'), yearFrom: Number(value(row, 'yearfrom')) || undefined, yearTo: Number(value(row, 'yearto')) || undefined, engine: value(row, 'engine') };
      if (fitment.make || fitment.model) rowFitments = [fitment];
    }
    let product = grouped.get(sku);
    if (!product) {
      product = {
        sku, name: value(row, 'name'), brand: value(row, 'brand'), category: value(row, 'category') || 'General', unit: (value(row, 'unit') || value(row, 'uom') || 'PCS').toUpperCase(),
        oe: value(row, 'oe').split(/[|;]/).map((item) => item.trim()).filter(Boolean), barcode: value(row, 'barcode'),
        price: Number(value(row, 'price')) || 0, priceIncludesGst: ['true', 'yes', '1'].includes(value(row, 'priceincludesgst').toLowerCase()), cost: Number(value(row, 'cost')) || 0, reorderPoint: Number(value(row, 'reorderpoint')) || 0,
        vehicleFitment: [], locations: [], row: rowIndex + 2, providedFields: headers,
      };
      grouped.set(sku, product);
    }
    for (const fitment of rowFitments) {
      const key = JSON.stringify([fitment.make, fitment.model, fitment.yearFrom, fitment.yearTo, fitment.engine]);
      if (!product.vehicleFitment.some((item) => JSON.stringify([item.make, item.model, item.yearFrom, item.yearTo, item.engine]) === key)) product.vehicleFitment.push(fitment);
    }
    const rowOe = value(row, 'oe').split(/[|;]/).map((item) => item.trim().toUpperCase()).filter(Boolean);
    product.oe = [...new Set([...product.oe, ...rowOe])];
    const warehouse = value(row, 'warehouse').toUpperCase(); const rack = value(row, 'rack');
    const rawQty = value(row, 'qty');
    const qty = rawQty === '' ? 0 : Number(rawQty);
    if (Number.isFinite(qty)) {
      const existingLocation = product.locations.find((location) => location.warehouse === warehouse && location.rack === rack);
      if (existingLocation) existingLocation.qty += qty;
      else product.locations.push({ warehouse, rack, qty });
    }
  });
  return [...grouped.values()];
}

export function makeCsv(rows) {
  const fields = rows.length ? Object.keys(rows[0]) : [];
  const quote = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  return [fields.map(quote).join(','), ...rows.map((row) => fields.map((field) => quote(row[field])).join(','))].join('\r\n');
}
