export const warehouses = [
  { code: 'KG', name: 'Kashmiri Gate' },
  { code: 'SPB', name: 'Samaypur Badli' },
  { code: 'BG', name: 'Bangalore' },
  { code: 'PB', name: 'Palika Bazaar' },
];

export const rackLetters = ['A', 'B', 'C', 'D', 'E'];
export const defaultRacks = Array.from({ length: 159 }, (_, i) =>
  rackLetters.map((letter) => `G-${i + 1}${letter}`),
).flat();

export const demoUsers = [
  { id: 'u-admin', name: 'Aarav Mehta', email: 'admin@stockroom.local', password: 'stockroom', role: 'Admin', approved: true },
  { id: 'u-manager', name: 'Riya Kapoor', email: 'manager@stockroom.local', password: 'stockroom', role: 'Store Manager', warehouse: 'KG', approved: true },
  { id: 'u-packer', name: 'Kabir Singh', email: 'packer@stockroom.local', password: 'stockroom', role: 'Packer', warehouse: 'KG', approved: true },
];

export const demoProducts = [
  { id: 'p1', name: 'Alternator assembly', sku: 'ALT-2048', brand: 'Bosch', oe: ['06H903023F'], price: 12450, barcode: '8905712340486', locations: [{ warehouse: 'KG', rack: 'G-14B', qty: 12 }, { warehouse: 'BG', rack: 'G-103A', qty: 5 }], updatedAt: 'Today, 10:42 AM' },
  { id: 'p2', name: 'Front brake pad set', sku: 'BRK-1180', brand: 'Brembo', oe: ['8K0698151'], price: 3850, barcode: '8905712118032', locations: [{ warehouse: 'SPB', rack: 'G-52C', qty: 0 }], updatedAt: 'Today, 9:18 AM' },
  { id: 'p3', name: 'Brake pad set, ceramic', sku: 'BRK-1184', brand: 'Bosch', oe: ['8K0698151'], price: 3420, barcode: '8905712118049', locations: [{ warehouse: 'KG', rack: 'G-21A', qty: 8 }], updatedAt: 'Yesterday, 4:06 PM' },
  { id: 'p4', name: 'Brake pad set, premium', sku: 'BRK-1191', brand: 'Textar', oe: ['8K0698151', '8K0698151A'], price: 4175, barcode: '8905712119114', locations: [{ warehouse: 'BG', rack: 'G-86D', qty: 4 }, { warehouse: 'SPB', rack: 'G-91B', qty: 3 }], updatedAt: 'Yesterday, 2:31 PM' },
  { id: 'p5', name: 'Oil filter', sku: 'OF-2201', brand: 'Mahle', oe: ['06L115562'], price: 680, barcode: '8905712220109', locations: [{ warehouse: 'BG', rack: 'G-103A', qty: 46 }, { warehouse: 'KG', rack: 'G-7E', qty: 18 }], updatedAt: 'Today, 11:03 AM' },
  { id: 'p6', name: 'Control arm, front left', sku: 'SUS-5310', brand: 'Lemförder', oe: ['8K0407151B'], price: 6950, barcode: '8905712531007', locations: [{ warehouse: 'KG', rack: 'G-159E', qty: 7 }], updatedAt: 'Today, 8:54 AM' },
  { id: 'p7', name: 'Air filter element', sku: 'AF-1045', brand: 'Mann-Filter', oe: ['8K0133843'], price: 890, barcode: '8905712104501', locations: [{ warehouse: 'SPB', rack: 'G-33D', qty: 2 }], updatedAt: 'Yesterday, 5:22 PM' },
  { id: 'p8', name: 'Water pump', sku: 'WP-4012', brand: 'INA', oe: ['06H121026DD'], price: 5420, barcode: '8905712401204', locations: [{ warehouse: 'BG', rack: 'G-128C', qty: 0 }], updatedAt: 'Nov 15, 2026' },
];

export const demoActivity = [
  { id: 'a1', user: 'Riya Kapoor', action: 'Updated stock', detail: 'ALT-2048 · +5 units at KG / G-14B', time: 'Today, 10:42 AM' },
  { id: 'a2', user: 'Kabir Singh', action: 'Looked up OE number', detail: '8K0698151 · 3 alternatives found', time: 'Today, 9:56 AM' },
  { id: 'a3', user: 'Aarav Mehta', action: 'Added product', detail: 'OF-2201 · Oil filter', time: 'Today, 9:11 AM' },
];

export function stockTotal(product) {
  return product.locations.reduce((sum, location) => sum + Number(location.qty || 0), 0);
}

export function barcodeFor(value = '') {
  const seed = String(value).split('').reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const widths = [2, 1, 2, 1, 1, 2, 1];
  for (let i = 0; i < 35; i += 1) widths.push(((seed * (i + 3) + i * 7) % 3) + 1);
  return widths;
}
