import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, ArrowDownUp, ArrowRight, Box, Check, ChevronDown, ChevronLeft,
  ChevronRight, Clock3, LayoutDashboard, Link2, LogOut, MapPin, Menu, Plus,
  Search, Settings2, Shield, SlidersHorizontal, Users, Warehouse, X,
  ScanLine, Trash2, AlertTriangle, ClipboardList, PackageCheck, ShoppingCart,
  BarChart3, FileSpreadsheet, PlugZap, Printer, FileUp, FileDown, UserRound, CarFront,
} from 'lucide-react';
import { demoActivity, demoProducts, demoUsers, defaultRacks, stockTotal, warehouses } from './data';
import { parseProductCsv } from './csv';
import JsBarcode from 'jsbarcode';

const NAV = [
  { id: 'Overview', icon: LayoutDashboard }, { id: 'Inventory', icon: Box, section: 'Stock' },
  { id: 'OE mapping', icon: Link2, section: 'Stock' }, { id: 'Locations', icon: Warehouse, section: 'Stock' },
  { id: 'Import / export', icon: FileSpreadsheet, section: 'Stock' },
  { id: 'Orders', icon: ClipboardList, section: 'Sales' }, { id: 'Packing', icon: PackageCheck, section: 'Sales' },
  { id: 'Sales history', icon: ShoppingCart, section: 'Sales' }, { id: 'WooCommerce', icon: PlugZap, section: 'Sales' }, { id: 'Website Orders', icon: ClipboardList, section: 'Sales', parent: 'WooCommerce' }, { id: 'Car Check', icon: CarFront, section: 'Sales', parent: 'WooCommerce' },
  { id: 'Reports', icon: BarChart3, section: 'Admin' }, { id: 'Team', icon: Users, section: 'Admin' }, { id: 'Activity', icon: Clock3, section: 'Admin' },
];
const pageSlug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const pageFromHash = () => NAV.find(({ id }) => pageSlug(id) === window.location.hash.slice(1))?.id || 'Overview';
const allowedPageFor = (page, user) => user?.role === 'Packer'
  ? ['Orders', 'Packing'].includes(page) ? page : 'Packing'
  : user?.role !== 'Admin' && ['Team'].includes(page) ? 'Overview' : page;
const ROLE_PERMISSIONS = {
  Admin: { edit: true, team: true }, 'Store Manager': { edit: true, team: false }, Packer: { edit: false, team: false },
};
const PRODUCT_PAGE_SIZE = 25;
const fmt = (value) => `₹${Number(value || 0).toLocaleString('en-IN')}`;
const GST_RATE = 18;
const roundMoney = (amount) => Math.round((Number(amount || 0) + Number.EPSILON) * 100) / 100;
const gstBase = (amount, includesGst) => Number(amount || 0) / (includesGst ? 1 + GST_RATE / 100 : 1);
const gstCharge = (amount, includesGst) => gstBase(amount, includesGst) * GST_RATE / 100;
const gstTotal = (amount, includesGst) => includesGst ? Number(amount || 0) : Number(amount || 0) * (1 + GST_RATE / 100);
const totalForWarehouse = (product, code) => product.locations.filter((loc) => loc.warehouse === code).reduce((sum, loc) => sum + Number(loc.qty || 0), 0);
const availableFor = (product, code = 'all') => product.locations.filter((loc) => code === 'all' || loc.warehouse === code).reduce((sum, loc) => sum + Math.max(0, Number(loc.qty || 0) - Number(loc.reserved || 0)), 0);
async function api(path, options = {}) {
  const headers = { Accept: 'application/json', ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) };
  const response = await fetch(`/api${path}`, { credentials: 'same-origin', ...options, headers });
  if (response.status === 204) return null;
  const contentType = response.headers.get('content-type') || '';
  const result = contentType.includes('application/json') ? await response.json() : await response.blob();
  if (!response.ok) throw new Error(result?.error || `Request failed (${response.status})`);
  return result;
}
const readStore = (key, fallback) => {
  try { const value = localStorage.getItem(`stockroom:${key}`); return value ? JSON.parse(value) : fallback; } catch { return fallback; }
};

function BarcodeMark({ value, compact = false }) {
  const barcodeRef = useRef(null);
  useEffect(() => { if (barcodeRef.current && value) JsBarcode(barcodeRef.current, value, { format: 'CODE128', displayValue: false, width: compact ? 1 : 1.25, height: compact ? 22 : 29, margin: 3, lineColor: '#1d252b' }); }, [value, compact]);
  return <div className={`barcode ${compact ? 'barcode-compact' : ''}`} aria-label={`Code 128 barcode ${value}`}><svg ref={barcodeRef} role="img" aria-label={`Code 128 barcode ${value}`} /><span>{value}</span></div>;
}

function Modal({ title, onClose, children, wide = false }) {
  useEffect(() => { const close = (event) => event.key === 'Escape' && onClose(); window.addEventListener('keydown', close); return () => window.removeEventListener('keydown', close); }, [onClose]);
  return <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}><section className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}><header className="modal-header"><div><h2>{title}</h2></div><button className="icon-button" onClick={onClose} aria-label="Close"><X size={19} /></button></header>{children}</section></div>;
}

function ProductForm({ product, racks, onClose, onSave }) {
  const [form, setForm] = useState(() => product ? { unit: 'PCS', ...structuredClone(product) } : { name: '', sku: '', brand: '', category: 'General', unit: 'PCS', oe: [], price: '', priceIncludesGst: false, cost: '', reorderPoint: 0, barcode: '', vehicleFitment: [], locations: [{ warehouse: 'KG', rack: 'G-1A', qty: 0 }] });
  const [oeText, setOeText] = useState((product?.oe || []).join(', '));
  const [fitmentText, setFitmentText] = useState((product?.vehicleFitment || []).map((fitment) => [fitment.make, fitment.model, fitment.yearFrom, fitment.yearTo, fitment.engine].filter(Boolean).join('|')).join('; '));
  const [error, setError] = useState('');
  const update = (key, value) => setForm((old) => ({ ...old, [key]: value }));
  const updateLoc = (i, key, value) => setForm((old) => ({ ...old, locations: old.locations.map((loc, n) => n === i ? { ...loc, [key]: value } : loc) }));
  const submit = (event) => {
    event.preventDefault();
    if (!form.name.trim() || !form.sku.trim() || !form.brand.trim()) return setError('Add a product name, SKU and brand.');
    const normalizedSku = form.sku.trim().toUpperCase();
    if (!form.barcode.trim()) form.barcode = `890571${normalizedSku.replace(/\D/g, '').padStart(7, '0').slice(-7)}`;
    const vehicleFitment = fitmentText.split(/[;\n]/).map((line) => { const [make, model, yearFrom, yearTo, engine] = line.split('|').map((value) => value.trim()); return { make, model, yearFrom: Number(yearFrom) || undefined, yearTo: Number(yearTo) || undefined, engine }; }).filter((fitment) => fitment.make || fitment.model);
    onSave({ ...form, sku: normalizedSku, price: Number(form.price || 0), priceIncludesGst: Boolean(form.priceIncludesGst), cost: Number(form.cost || 0), reorderPoint: Number(form.reorderPoint || 0), oe: oeText.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean), vehicleFitment, locations: form.locations.map((x) => ({ ...x, qty: Math.max(0, Number(x.qty || 0)) })) });
  };
  return <Modal title={product ? 'Edit product' : 'Add product'} onClose={onClose} wide>
    <form className="product-form" onSubmit={submit}>
      <div className="form-grid">
        <label className="field"><span>Product name</span><input autoFocus value={form.name} onChange={(e) => update('name', e.target.value)} placeholder="e.g. Front brake pad set" /></label>
        <label className="field"><span>SKU</span><input value={form.sku} onChange={(e) => update('sku', e.target.value)} placeholder="e.g. BRK-1180" /></label>
        <label className="field"><span>Brand</span><input value={form.brand} onChange={(e) => update('brand', e.target.value)} placeholder="e.g. Bosch" /></label>
        <label className="field"><span>Sell unit</span><select value={form.unit || 'PCS'} onChange={(e) => update('unit', e.target.value)}>{[...new Set(['PCS', 'SET', 'KIT', 'PAIR', 'LTR', 'MTR', 'CYL', form.unit].filter(Boolean))].map((unit) => <option value={unit} key={unit}>{unit}</option>)}</select><small>Used for stock, sales and packing quantities.</small></label>
        <label className="field"><span>Price (₹)</span><input type="number" min="0" step="0.01" value={form.price} onChange={(e) => update('price', e.target.value)} placeholder="0" /></label>
        <label className="field"><span>Category</span><input value={form.category || ''} onChange={(e) => update('category', e.target.value)} placeholder="e.g. Brakes, Engine, Suspension" /></label>
        <div className="field gst-checkbox-field"><span>GST treatment</span><label className="gst-checkbox-control"><input type="checkbox" checked={Boolean(form.priceIncludesGst)} onChange={(e) => update('priceIncludesGst', e.target.checked)} /><span><strong>Price includes 18% GST</strong><small>Checked: entered price is final. Unchecked: 18% is added at sale.</small></span></label></div>
        <label className="field"><span>Reorder point</span><input type="number" min="0" value={form.reorderPoint || 0} onChange={(e) => update('reorderPoint', e.target.value)} placeholder="0" /></label>
        <label className="field form-span"><span>OE number(s) <small>Separate alternatives with commas</small></span><input value={oeText} onChange={(e) => setOeText(e.target.value)} placeholder="e.g. 8K0698151, 8K0698151A" /></label>
        <label className="field form-span"><span>Vehicle fitment <small>One per line: make|model|year from|year to|engine</small></span><textarea rows="2" value={fitmentText} onChange={(e) => setFitmentText(e.target.value)} placeholder={'Audi|A4|2012|2016|2.0 TFSI'} /></label>
        <label className="field form-span"><span>Barcode number</span><input value={form.barcode} onChange={(e) => update('barcode', e.target.value)} placeholder="Generated from SKU if left blank" /></label>
      </div>
      <div className="location-editor-head"><div><h3>Stock locations</h3><p>Set warehouse, rack and quantity for each shelf.</p></div><button type="button" className="text-button" onClick={() => setForm((old) => ({ ...old, locations: [...old.locations, { warehouse: 'KG', rack: 'G-1A', qty: 0 }] }))}><Plus size={15} /> Add location</button></div>
      <div className="allocation-list">{form.locations.map((loc, i) => <div className="allocation-row" key={i}>
        <select aria-label="Warehouse" value={loc.warehouse} onChange={(e) => updateLoc(i, 'warehouse', e.target.value)}>{warehouses.map((w) => <option key={w.code} value={w.code}>{w.code} · {w.name}</option>)}</select>
        <select aria-label="Rack location" value={loc.rack} onChange={(e) => updateLoc(i, 'rack', e.target.value)}>{racks.map((rack) => <option key={rack} value={rack}>{rack}</option>)}</select>
        <input aria-label="Quantity" type="number" min="0" value={loc.qty} onChange={(e) => updateLoc(i, 'qty', e.target.value)} />
        <button type="button" className="icon-button remove-allocation" disabled={form.locations.length === 1} onClick={() => setForm((old) => ({ ...old, locations: old.locations.filter((_, n) => n !== i) }))} aria-label="Remove location"><Trash2 size={16} /></button>
      </div>)}</div>
      {error && <div className="form-error">{error}</div>}
      <footer className="modal-actions"><button type="button" className="button button-quiet" onClick={onClose}>Cancel</button><button className="button button-primary"><Check size={16} /> Save product</button></footer>
    </form>
  </Modal>;
}

function AlternativesModal({ product, products, onClose }) {
  const alternatives = products.filter((item) => item.id !== product.id && item.oe.some((number) => product.oe.includes(number)));
  return <Modal title="OE number alternatives" onClose={onClose} wide>
    <div className="oe-modal-intro"><div className="oe-symbol"><Link2 size={19} /></div><div><strong>{product.name}</strong><p>Matching OE number{product.oe.length === 1 ? '' : 's'}: {product.oe.join(' · ') || 'None added'}</p></div></div>
    <div className="alternatives-list">{alternatives.length ? alternatives.map((alt) => <div className="alternative-row" key={alt.id}><div className="alternative-main"><strong>{alt.name}</strong><span>{alt.brand} <i>·</i> {alt.sku}</span></div><div className="alternative-stock"><strong className={availableFor(alt) ? 'stock-good' : 'stock-zero'}>{availableFor(alt)} units</strong><span>{alt.locations.map((loc) => `${loc.warehouse} · ${loc.rack}`).join(', ')}</span></div><div className="alternative-price">{fmt(alt.price)}<small>{alt.priceIncludesGst ? 'GST included' : 'plus 18% GST'}</small></div></div>) : <div className="empty-state"><Link2 size={22} /><strong>No alternatives yet</strong><span>Add the same OE number to another product to link them.</span></div>}</div>
    <footer className="modal-actions"><span className="helper-text">Prices and availability update with inventory.</span><button className="button button-primary" onClick={onClose}>Done</button></footer>
  </Modal>;
}

function Login({ onLogin, onRegister }) {
  const [registering, setRegistering] = useState(false);
  const [email, setEmail] = useState('admin@stockroom.local');
  const [password, setPassword] = useState('stockroom');
  const [name, setName] = useState(''); const [phone, setPhone] = useState('');
  const [role, setRole] = useState('Packer'); const [warehouse, setWarehouse] = useState('KG');
  const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const submit = async (event) => { event.preventDefault(); setError(''); setNotice(''); try { if (registering) { const result = await onRegister({ name, phone, email: email.trim(), password, role, warehouse }); setNotice(result.message); setRegistering(false); setPassword(''); } else await onLogin(email.trim(), password); } catch (failure) { setError(failure.message); } };
  const quickLogin = async (demoRole) => { const demo = { Admin: ['admin@stockroom.local', 'stockroom'], 'Store Manager': ['manager@stockroom.local', 'stockroom'], Packer: ['packer@stockroom.local', 'stockroom'] }[demoRole]; setEmail(demo[0]); setPassword(demo[1]); setError(''); try { await onLogin(...demo); } catch (failure) { setError(failure.message); } };
  return <main className="login-screen"><section className="login-aside"><div className="brand-lockup"><span className="brand-icon"><Box size={22} /></span><strong>Saraswati Inventory System</strong></div><div className="login-aside-copy"><h1>Every part,<br />right where it<br />should be.</h1><p>One clear view of your stock across KG, SPB, BG and PB.</p></div><div className="login-footer">Inventory, kept in order.</div></section><section className="login-content"><div className="login-box"><div className="login-mobile-brand"><Box size={21} /> Saraswati Inventory</div><div className="login-heading"><h2>{registering ? 'Create your account' : 'Welcome back'}</h2><p>{registering ? 'Register as a packer or store manager. An admin must approve your account before you can sign in.' : 'Sign in to your inventory workspace.'}</p></div><form className="login-form" onSubmit={submit}>
    {registering && <><label className="field"><span>Full name</span><input required minLength="2" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" /></label><label className="field"><span>Phone number</span><input required type="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91 98765 43210" /></label><label className="field"><span>Account type</span><select value={role} onChange={(e) => setRole(e.target.value)}><option>Packer</option><option>Store Manager</option></select></label><label className="field"><span>Warehouse</span><select value={warehouse} onChange={(e) => setWarehouse(e.target.value)}>{warehouses.map((item) => <option key={item.code} value={item.code}>{item.code} · {item.name}</option>)}</select></label></>}
    <label className="field"><span>Work email</span><input required type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" /></label><label className="field"><span>Password {registering && <small>At least 12 characters</small>}</span><input required minLength={registering ? 12 : undefined} type="password" autoComplete={registering ? 'new-password' : 'current-password'} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Enter your password" /></label>{error && <div className="form-error">{error}</div>}{notice && <div className="approval-notice" role="status">{notice}</div>}<button className="button button-primary login-submit">{registering ? 'Submit for approval' : 'Sign in'} <ArrowRight size={16} /></button></form><button className="login-mode-toggle" onClick={() => { setRegistering((value) => !value); setError(''); setNotice(''); }}>{registering ? 'Already registered? Sign in' : 'New to the system? Register'}</button>{!registering && <div className="demo-access"><div><Shield size={15} /><span>Demo workspace</span></div><div className="demo-role-buttons">{['Admin', 'Store Manager', 'Packer'].map((demoRole) => <button key={demoRole} onClick={() => quickLogin(demoRole)}>Enter as {demoRole} <ArrowRight size={14} /></button>)}</div><small>Demo password: stockroom</small></div>}</div></section></main>;
}

function App() {
  const [products, setProducts] = useState(() => readStore('products', demoProducts));
  const [productPage, setProductPage] = useState(1);
  const [productTotal, setProductTotal] = useState(demoProducts.length);
  const [productSummary, setProductSummary] = useState(null);
  const [users, setUsers] = useState(() => readStore('users', demoUsers));
  const [activity, setActivity] = useState(() => readStore('activity', demoActivity));
  const [auditActivity, setAuditActivity] = useState({ events: [], sessions: [], retentionDays: 210 });
  const [auditLoading, setAuditLoading] = useState(false);
  const [customRacks, setCustomRacks] = useState([]);
  const [currentUser, setCurrentUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [orders, setOrders] = useState([]);
  const [salesReport, setSalesReport] = useState(null);
  const [wooStatus, setWooStatus] = useState(null);
  const [page, setPage] = useState(pageFromHash);
  const [query, setQuery] = useState('');
  const [searchResponse, setSearchResponse] = useState(null);
  const [searchPending, setSearchPending] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [warehouseFilter, setWarehouseFilter] = useState('all');
  const [stockFilter, setStockFilter] = useState('all');
  const [modalProduct, setModalProduct] = useState(null);
  const [editingProduct, setEditingProduct] = useState(null);
  const [altProduct, setAltProduct] = useState(null);
  const [toast, setToast] = useState('');
  const [rackWarehouse, setRackWarehouse] = useState('KG');
  const [newRack, setNewRack] = useState('');
  const [teamDraft, setTeamDraft] = useState(null);
  const [teamError, setTeamError] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [orderModalOpen, setOrderModalOpen] = useState(false);
  const [quickSellProduct, setQuickSellProduct] = useState(null);
  const [packers, setPackers] = useState([]);
  const [packerLoading, setPackerLoading] = useState(false);
  const packerRequestRef = useRef(0);
  const [invoiceOrder, setInvoiceOrder] = useState(null);
  const [photoOrder, setPhotoOrder] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dataError, setDataError] = useState('');
  const searchInputRef = useRef(null);
  const canEdit = ROLE_PERMISSIONS[currentUser?.role]?.edit;
  const canManageTeam = ROLE_PERMISSIONS[currentUser?.role]?.team;
  const racks = useMemo(() => [...new Set([...defaultRacks, ...customRacks, ...products.flatMap((product) => product.locations.map((location) => location.rack))])].sort(), [customRacks, products]);

  useEffect(() => { localStorage.setItem('stockroom:activity', JSON.stringify(activity)); }, [activity]);
  useEffect(() => { api('/auth/me').then((result) => { setCurrentUser(result.user); setPage((current) => allowedPageFor(current, result.user)); }).catch(() => setCurrentUser(null)).finally(() => setAuthLoading(false)); }, []);
  useEffect(() => {
    if (!currentUser) return undefined;
    const route = `#${pageSlug(page)}`;
    if (window.location.hash !== route) window.history.pushState({ inventoryPage: page }, '', `${window.location.pathname}${window.location.search}${route}`);
    return undefined;
  }, [page, currentUser]);
  useEffect(() => {
    const restorePage = () => {
      setPage(allowedPageFor(pageFromHash(), currentUser));
    };
    window.addEventListener('popstate', restorePage);
    return () => window.removeEventListener('popstate', restorePage);
  }, [currentUser]);
  useEffect(() => {
    if (!currentUser) return undefined;
    const heartbeat = () => api('/auth/heartbeat').catch(() => {});
    heartbeat(); const timer = window.setInterval(heartbeat, 60_000);
    return () => window.clearInterval(timer);
  }, [currentUser]);
  useEffect(() => {
    if (!currentUser) return undefined;
    let active = true;
    const loadWorkspace = async () => {
      try {
        if (currentUser.role === 'Packer') { const orderResult = await api('/orders'); if (active) setOrders(orderResult.items); return; }
        const [productResult, orderResult, rackResult, summaryResult] = await Promise.all([api(`/products?page=${productPage}&limit=${PRODUCT_PAGE_SIZE}`), api('/orders'), api('/racks'), api('/products/summary')]);
        if (active) { setProducts(productResult.items); setProductTotal(productResult.total); setProductSummary(summaryResult); setOrders(orderResult.items); setCustomRacks([...new Set(rackResult.items.map((item) => item.rack))]); }
        if (currentUser.role === 'Admin') {
          try { const userResult = await api('/users'); if (active) setUsers(userResult.items); } catch { /* restricted user list */ }
        }
      } catch (failure) { if (active) setToast(failure.message); }
    };
    loadWorkspace();
    return () => { active = false; };
  }, [currentUser]);
  useEffect(() => {
    if (!currentUser || currentUser.role === 'Packer' || query.trim().length >= 2) return undefined;
    let active = true;
    api(`/products?page=${productPage}&limit=${PRODUCT_PAGE_SIZE}`).then((result) => { if (active) { setProducts(result.items); setProductTotal(result.total); } }).catch(() => {});
    return () => { active = false; };
  }, [currentUser, productPage, query]);
  useEffect(() => {
    if (page !== 'Team' || currentUser?.role !== 'Admin') return undefined;
    let active = true;
    const refreshUsers = async () => { try { const result = await api('/users'); if (active) setUsers(result.items); } catch { /* team list retries while open */ } };
    refreshUsers(); const timer = window.setInterval(refreshUsers, 10_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [page, currentUser]);
  useEffect(() => {
    if (page !== 'Activity' || !currentUser || currentUser.role === 'Packer') return undefined;
    let active = true; setAuditLoading(true);
    const refresh = async () => { try { const result = await api('/activity'); if (active) setAuditActivity(result); } catch (failure) { if (active) setToast(failure.message); } finally { if (active) setAuditLoading(false); } };
    refresh(); const timer = window.setInterval(refresh, 30_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [page, currentUser]);
  useEffect(() => {
    if (!currentUser) return undefined;
    const timer = window.setInterval(async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        if (currentUser.role === 'Packer') { const orderResult = await api('/orders'); setOrders(orderResult.items); return; }
        const [productResult, orderResult] = await Promise.all([api(`/products?page=${productPage}&limit=${PRODUCT_PAGE_SIZE}`), api('/orders')]);
        setProducts(productResult.items); setProductTotal(productResult.total); setOrders(orderResult.items);
      } catch { /* the next poll retries transient connection failures */ }
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [currentUser, productPage]);
  useEffect(() => { setProductPage(1); }, [query, warehouseFilter]);
  useEffect(() => {
    const searchTerm = query.trim();
    if (currentUser?.role === 'Packer' || searchTerm.length < 2) {
      setSearchResponse(null); setSearchPending(false); setSearchError('');
      return undefined;
    }
    const controller = new AbortController();
    setSearchResponse(null); setSearchPending(true); setSearchError('');
    const timer = window.setTimeout(async () => {
      try {
        const parameters = new URLSearchParams({ q: searchTerm, warehouse: warehouseFilter, page: String(productPage) });
        const response = await fetch(`/api/products/search?${parameters}`, { signal: controller.signal, credentials: 'same-origin', headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error(`Search API returned ${response.status}`);
        setSearchResponse(await response.json());
      } catch (error) {
        if (error.name !== 'AbortError') { setSearchResponse(null); setSearchError('Search service unavailable · showing locally saved products.'); }
      } finally {
        if (!controller.signal.aborted) setSearchPending(false);
      }
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query, warehouseFilter, currentUser, productPage]);
  useEffect(() => {
    const shortcut = (event) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' || event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) { event.preventDefault(); window.setTimeout(() => searchInputRef.current?.focus(), 0); } };
    window.addEventListener('keydown', shortcut); return () => window.removeEventListener('keydown', shortcut);
  }, []);
  useEffect(() => { if (!toast) return undefined; const timer = setTimeout(() => setToast(''), 3000); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => { window.scrollTo(0, 0); }, [page]);

  const addActivity = (action, detail) => setActivity((old) => [{ id: `a-${Date.now()}`, user: currentUser?.name || 'You', action, detail, time: new Date().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) }, ...old]);
  const handleLogin = async (email, password) => { const result = await api('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }); setCurrentUser(result.user); setPage(result.user.role === 'Packer' ? 'Packing' : 'Overview'); };
  const handleRegister = async (payload) => api('/auth/register', { method: 'POST', body: JSON.stringify(payload) });
  const handleLogout = async () => { try { await api('/auth/logout', { method: 'POST' }); } finally { setCurrentUser(null); setOrders([]); setPage('Overview'); } };
  const saveProduct = async (payload) => {
    try {
      const result = await api(payload.id ? `/products/${encodeURIComponent(payload.id)}` : '/products', { method: payload.id ? 'PUT' : 'POST', body: JSON.stringify(payload) });
      const saved = result.product;
      setProducts((old) => payload.id ? old.map((item) => item.id === saved.id ? saved : item) : [saved, ...old].slice(0, PRODUCT_PAGE_SIZE));
      if (!payload.id) setProductTotal((count) => count + 1);
      addActivity(payload.id ? 'Updated product' : 'Added product', `${saved.sku} · ${saved.name}`);
      setModalProduct(null); setToast(payload.id ? 'Product updated' : 'Product added');
    } catch (failure) { setToast(failure.message); }
  };
  const deleteProduct = async (product) => {
    const onHand = stockTotal(product);
    const detail = onHand ? ` This removes ${onHand} units across its warehouse locations as well.` : '';
    if (!window.confirm(`Permanently delete ${product.name} (${product.sku})?${detail} This cannot be undone.`)) return;
    try {
      await api(`/products/${encodeURIComponent(product.id)}`, { method: 'DELETE' });
      setProducts((old) => old.filter((item) => item.id !== product.id));
      setProductTotal((count) => Math.max(0, count - 1));
      addActivity('Deleted product', `${product.sku} · ${product.name}`);
      if (editingProduct?.id === product.id) { setEditingProduct(null); setModalProduct(null); }
      setToast(`${product.sku} deleted`);
    } catch (failure) { setToast(failure.message); }
  };
  const localQueryProducts = products.filter((p) => {
    const text = `${p.name} ${p.sku} ${p.brand} ${p.oe.join(' ')} ${p.barcode}`.toLowerCase();
    return !query.trim() || text.includes(query.trim().toLowerCase());
  });
  const searchProducts = query.trim().length < 2 || searchError || !searchResponse
    ? localQueryProducts
    : searchResponse.source === 'demo'
      ? [...new Map([...searchResponse.items, ...localQueryProducts].map((item) => [item.sku, item])).values()]
      : searchResponse.items;
  const filteredProducts = searchProducts.filter((p) => {
    const warehouseMatch = warehouseFilter === 'all' || p.locations.some((loc) => loc.warehouse === warehouseFilter);
    const quantity = availableFor(p, warehouseFilter);
    const stockMatch = stockFilter === 'all' || (stockFilter === 'in' && quantity > 0) || (stockFilter === 'out' && quantity === 0) || (stockFilter === 'low' && quantity > 0 && quantity <= 5);
    return warehouseMatch && stockMatch;
  }).slice(0, PRODUCT_PAGE_SIZE);
  const openEdit = (product) => { if (canEdit) { setEditingProduct(product); setModalProduct(product); } };
  const showAlternatives = (product, matches = products) => setAltProduct({ product, products: matches });
  const navClick = (name) => { if (currentUser?.role === 'Packer' && !['Orders', 'Packing'].includes(name)) return; setPage(name); setMenuOpen(false); setQuery(''); };
  const addNewProduct = () => { setEditingProduct(null); setModalProduct({}); };
  const loadPackers = async (warehouse) => { const requestId = ++packerRequestRef.current; setPackerLoading(true); setPackers([]); try { const result = await api(`/users/packers?warehouse=${encodeURIComponent(warehouse)}`); if (requestId === packerRequestRef.current) setPackers(result.items); return result.items; } catch (failure) { if (requestId === packerRequestRef.current) { setPackers([]); setToast(failure.message); } return []; } finally { if (requestId === packerRequestRef.current) setPackerLoading(false); } };
  const openQuickSell = async (product) => { const firstLocation = product.locations.find((location) => availableFor(product, location.warehouse) > 0); const warehouse = firstLocation?.warehouse || currentUser.warehouse || 'KG'; setQuickSellProduct(product); await loadPackers(warehouse); };
  const openNewOrder = async () => { setOrderModalOpen(true); await loadPackers(currentUser.warehouse || 'KG'); };
  const addRack = async () => {
    const label = newRack.trim().toUpperCase();
    if (!/^G-\d+[A-E]$/.test(label)) { setToast('Use a rack format like G-160A.'); return; }
    try { await api('/racks', { method: 'POST', body: JSON.stringify({ warehouse: rackWarehouse, rack: label }) }); setCustomRacks((old) => [...new Set([...old, label])]); setNewRack(''); addActivity('Added rack location', `${rackWarehouse} · ${label}`); setToast(`${label} added to ${rackWarehouse}`); }
    catch (failure) { setToast(failure.message); }
  };

  const reloadOrders = async () => { const result = await api('/orders'); setOrders(result.items); };
  const createOrder = async (payload) => { const result = await api('/orders', { method: 'POST', body: JSON.stringify(payload) }); setOrders((old) => [result.order, ...old]); setOrderModalOpen(false); setToast(result.order.assignedName ? `Order assigned to ${result.order.assignedName} for packing.` : `Order ${result.order.orderNumber} created and queued for packing.`); };
  const createQuickSale = async (payload) => {
    const result = await api('/orders', { method: 'POST', body: JSON.stringify(payload) });
    setOrders((old) => [result.order, ...old]);
    try { const productResult = await api(`/products?page=${productPage}&limit=${PRODUCT_PAGE_SIZE}`); setProducts(productResult.items); setProductTotal(productResult.total); } catch { /* the ten-second refresh will reconcile stock */ }
    setQuickSellProduct(null); setInvoiceOrder(result.order);
    setToast(`${result.order.items[0].sku} sold and assigned to ${result.order.assignedName}.`);
  };
  const addTeamMember = async (user) => { try { const result = await api('/users', { method: 'POST', body: JSON.stringify(user) }); setUsers((old) => [...old, result.user]); setTeamDraft(null); setTeamError(''); setToast(`Team member added · temporary password: ${result.temporaryPassword}`); } catch (failure) { setTeamError(failure.message); } };
  const changeTeamRole = async (id, role) => { try { const result = await api(`/users/${encodeURIComponent(id)}/role`, { method: 'PATCH', body: JSON.stringify({ role }) }); setUsers((old) => old.map((user) => user.id === id ? result.user : user)); setToast(`Role updated for ${result.user.name}`); } catch (failure) { setToast(failure.message); } };
  const changeTeamWarehouse = async (id, warehouse) => { try { const result = await api(`/users/${encodeURIComponent(id)}/warehouse`, { method: 'PATCH', body: JSON.stringify({ warehouse }) }); setUsers((old) => old.map((user) => user.id === id ? result.user : user)); setToast(`Warehouse updated for ${result.user.name}`); } catch (failure) { setToast(failure.message); } };
  const approveUser = async (id) => { try { const result = await api(`/users/${encodeURIComponent(id)}/approval`, { method: 'PATCH', body: JSON.stringify({ approved: true }) }); setUsers((old) => old.map((user) => user.id === id ? result.user : user)); setToast(`Approved account for ${result.user.name}`); } catch (failure) { setToast(failure.message); } };
  const deleteTeamMember = async (user) => {
    if (!window.confirm(`Permanently delete ${user.name}'s account? They will no longer be able to sign in. Their historical activity records will be retained.`)) return;
    try { await api(`/users/${encodeURIComponent(user.id)}`, { method: 'DELETE' }); setUsers((old) => old.filter((item) => item.id !== user.id)); setToast(`${user.name}'s account was deleted.`); }
    catch (failure) { setToast(failure.message); }
  };
  const acceptOrder = async (order) => { try { const result = await api(`/orders/${encodeURIComponent(order.id)}/accept`, { method: 'POST' }); setOrders((old) => old.map((item) => item.id === order.id ? result.order : item)); if (currentUser?.role !== 'Packer') await api('/products').then((data) => setProducts(data.items)); setToast(`${order.orderNumber} accepted for packing`); } catch (failure) { setToast(failure.message); } };
  const changeOrderStatus = async (order, status) => { try { const result = await api(`/orders/${encodeURIComponent(order.id)}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }); setOrders((old) => old.map((item) => item.id === order.id ? result.order : item)); if (currentUser?.role !== 'Packer') await api('/products').then((data) => setProducts(data.items)); setToast(`${order.orderNumber} marked ${status.replaceAll('_', ' ')}`); } catch (failure) { setToast(failure.message); } };
  const loadReports = async () => { try { setSalesReport(await api('/reports/sales')); } catch (failure) { setToast(failure.message); } };
  const loadWooStatus = async () => {
    try {
      const status = await api('/integrations/woocommerce/status');
      if (!status.configured) { setWooStatus(status); return; }
      try { setWooStatus({ ...status, ...(await api('/integrations/woocommerce/test', { method: 'POST' })) }); }
      catch (failure) { setWooStatus({ ...status, connected: false, connectionError: failure.message }); }
    } catch (failure) { setToast(failure.message); }
  };
  useEffect(() => { if (['Overview', 'Reports', 'Sales history'].includes(page) && currentUser) loadReports(); if (['WooCommerce', 'Website Orders', 'Car Check'].includes(page) && ['Admin', 'Store Manager'].includes(currentUser?.role)) loadWooStatus(); }, [page, currentUser]);
  const runWooAction = async (action, payload) => { setBusy(true); try { const result = await api(`/integrations/woocommerce/${action}`, { method: 'POST', ...(payload ? { body: JSON.stringify(payload) } : {}) }); setToast(result.message); if (action.includes('pull')) { const [p, o] = await Promise.all([api('/products'), api('/orders')]); setProducts(p.items); setOrders(o.items); } return result; } catch (failure) { setToast(failure.message); return null; } finally { setBusy(false); } };
  const assignWebsiteOrder = async (orderId, warehouse, packerId) => {
    setBusy(true);
    try {
      const result = await api(`/orders/${encodeURIComponent(orderId)}/assign`, { method: 'POST', body: JSON.stringify({ warehouse, packerId }) });
      setOrders((old) => old.map((order) => order.id === orderId ? result.order : order));
      setToast(result.message);
      return result;
    } catch (failure) { setToast(failure.message); return null; }
    finally { setBusy(false); }
  };
  const importWebsiteOrders = async () => {
    const result = await runWooAction('orders/pull');
    if (result) navClick('Website Orders');
  };
  const handleImport = async (file, warehouse, updateMatchingOnly) => {
    setBusy(true); setDataError('');
    let completed = 0; let inserted = 0; let updated = 0; let skipped = 0; let failed = 0; let firstError = '';
    try {
      const text = await file.text(); const parsed = parseProductCsv(text);
      for (let start = 0; start < parsed.length; start += 1000) {
        const batch = parsed.slice(start, start + 1000);
        setDataError(`Importing ${Math.min(start + batch.length, parsed.length).toLocaleString()} of ${parsed.length.toLocaleString()} products…`);
        let result;
        try { result = await api('/products/import', { method: 'POST', body: JSON.stringify({ warehouse, mode: updateMatchingOnly ? 'update-matching' : 'add-and-update', products: batch }) }); }
        catch (failure) { throw new Error(`Import stopped after ${completed.toLocaleString()} of ${parsed.length.toLocaleString()} products. ${failure.message}`); }
        completed += batch.length; inserted += result.inserted; updated += result.updated; skipped += result.skipped || 0; failed += result.failed;
        if (!firstError && result.errors?.length) firstError = `${result.errors[0].sku || `row ${result.errors[0].row}`}: ${result.errors[0].error}`;
      }
      const [productResult, summaryResult] = await Promise.all([api(`/products?page=${productPage}&limit=${PRODUCT_PAGE_SIZE}`), api('/products/summary')]);
      setProducts(productResult.items); setProductTotal(productResult.total); setProductSummary(summaryResult);
      setDataError(`${warehouse} import complete: ${inserted.toLocaleString()} added, ${updated.toLocaleString()} matched products updated, ${skipped.toLocaleString()} unmatched SKUs skipped, ${failed.toLocaleString()} failed. Other warehouse stock and user accounts were not changed.${firstError ? ` First issue: ${firstError}` : ''}`);
    }
    catch (failure) { setDataError(failure.message); }
    finally { setBusy(false); }
  };
  const exportProducts = (warehouse, filterBy = '', filterValue = '') => { const params = new URLSearchParams({ warehouse }); if (filterBy) { params.set('filterBy', filterBy); params.set('filterValue', filterValue.trim()); } const anchor = document.createElement('a'); anchor.href = `/api/products/export?${params.toString()}`; document.body.appendChild(anchor); anchor.click(); anchor.remove(); setToast(`${warehouse} ${filterBy ? `${filterBy} filtered` : 'full warehouse'} export started`); };

  if (authLoading) return <div className="auth-loading"><span className="live-dot" /> Checking your secure session…</div>;
  if (!currentUser) return <Login onLogin={handleLogin} onRegister={handleRegister} />;

  const totalUnits = productSummary?.totalUnits ?? products.reduce((sum, p) => sum + stockTotal(p), 0);
  const lowStock = productSummary?.lowStock ?? products.filter((p) => availableFor(p) <= Number(p.reorderPoint || 5)).length;
  const pageTitle = page;

  return <div className="app-shell">
    <aside className={`sidebar ${menuOpen ? 'sidebar-open' : ''}`}>
      <div className="brand-lockup"><span className="brand-icon"><Box size={22} /></span><strong>Saraswati Inventory</strong></div>
      <nav className="side-nav" aria-label="Main navigation">{NAV.filter(({ id }) => currentUser.role === 'Packer' ? ['Orders', 'Packing'].includes(id) : (id !== 'Team' || currentUser.role === 'Admin')).map(({ id, icon: Icon, section, parent }, index, items) => <Fragment key={id}>{section && (index === 0 || items[index - 1].section !== section) && <span className="nav-section-label">{section}</span>}<button className={`nav-item ${parent ? 'nav-sub-item' : ''} ${page === id ? 'nav-active' : ''}`} onClick={() => navClick(id)}><Icon size={parent ? 16 : 19} strokeWidth={1.8} /><span>{id}</span>{id === 'Inventory' && <span className="nav-count">{productTotal.toLocaleString('en-IN')}</span>}{id === 'Orders' && <span className="nav-count">{orders.length}</span>}{id === 'Website Orders' && <span className="nav-count">{orders.filter((order) => order.source === 'woocommerce' && !order.assignedTo && order.status === 'ready_to_pack').length}</span>}</button></Fragment>)}</nav>
      <div className="sidebar-bottom"><div className="warehouse-status"><span className="live-dot" /><div><strong>Inventory service</strong><small>Connected</small></div><span className="sync-pulse" /></div><button className="user-menu" onClick={handleLogout}><span className="avatar">{currentUser.name.split(' ').map((n) => n[0]).join('').slice(0, 2)}</span><span className="user-info"><strong>{currentUser.name}</strong><small>{currentUser.role}</small></span><LogOut size={16} /></button></div>
    </aside>
    {menuOpen && <button className="mobile-scrim" onClick={() => setMenuOpen(false)} aria-label="Close navigation" />}
    <main className="main-content">
      <header className="topbar"><button className="mobile-menu icon-button" onClick={() => setMenuOpen(true)} aria-label="Open navigation"><Menu size={20} /></button>{currentUser.role !== 'Packer' && <label className="global-search"><Search size={19} /><input ref={searchInputRef} value={query} onChange={(event) => { setQuery(event.target.value); if (page !== 'Inventory') setPage('Inventory'); }} placeholder="Search part number, OE number, brand or vehicle" aria-label="Search inventory" /><kbd>/</kbd></label>}<div className="topbar-right"><span className="topbar-date">{new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</span><span className="topbar-avatar">{currentUser.name.slice(0, 1)}</span></div></header>
      <div className="page-wrap" key={page}>
        {page === 'Inventory' && <>
          <section className="page-heading"><div><h1>Inventory</h1><p>Track parts across every warehouse.</p></div>{canEdit && <button className="button button-primary" onClick={addNewProduct}><Plus size={17} /> Add product</button>}</section>
          <section className="toolbar" aria-label="Inventory filters"><label className="search-field"><Search size={18} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search SKU, brand or OE number…" /><kbd>⌘ K</kbd></label><label className="select-field"><MapPin size={16} /><select value={warehouseFilter} onChange={(e) => setWarehouseFilter(e.target.value)}><option value="all">All warehouses</option>{warehouses.map((w) => <option key={w.code} value={w.code}>{w.code} · {w.name}</option>)}</select><ChevronDown size={15} /></label><label className="select-field stock-select"><SlidersHorizontal size={16} /><select value={stockFilter} onChange={(e) => setStockFilter(e.target.value)}><option value="all">All stock</option><option value="in">In stock</option><option value="low">Low stock</option><option value="out">Out of stock</option></select><ChevronDown size={15} /></label></section>
          {searchPending && <p className="search-feedback" role="status">Searching products…</p>}
          {!searchPending && searchError && <p className="search-feedback search-fallback" role="status">{searchError}</p>}
          {!searchPending && searchResponse && query.trim().length >= 2 && <p className="search-feedback" role="status">{searchResponse.total} match{searchResponse.total === 1 ? '' : 'es'} · {searchResponse.source === 'mongodb' ? 'MongoDB' : 'demo search'}{searchResponse.cached ? ' · Redis cache' : ''}</p>}
          <section className="summary-strip"><div><span>Total SKUs</span><strong>{productTotal.toLocaleString('en-IN')}</strong></div><div><span>Units on hand</span><strong>{totalUnits.toLocaleString('en-IN')}</strong></div><div><span>Low stock</span><strong className="summary-green">{lowStock}</strong></div><div><span>Warehouses</span><strong className="summary-green">{warehouses.length}</strong></div></section>
          <InventoryTable products={filteredProducts} allProducts={searchProducts} warehouseFilter={warehouseFilter} canEdit={canEdit} page={productPage} pageSize={PRODUCT_PAGE_SIZE} total={query.trim().length >= 2 && searchResponse ? searchResponse.total : productTotal} onPageChange={setProductPage} searching={query.trim().length >= 2} onEdit={openEdit} onAlternatives={showAlternatives} onSell={openQuickSell} onDelete={deleteProduct} />
        </>}
        {page === 'Overview' && <Overview products={products} totalSkus={productTotal} productSummary={productSummary} activity={activity} orders={orders} report={salesReport} totalUnits={totalUnits} lowStock={lowStock} canEdit={canEdit} onInventory={() => navClick('Inventory')} onImport={() => navClick('Import / export')} onAddProduct={addNewProduct} onSell={openQuickSell} onPacking={() => navClick('Packing')} onActivity={() => navClick('Activity')} onSalesHistory={() => navClick('Sales history')} onOpenProduct={(product) => { setQuery(product.sku); setPage('Inventory'); }} />}
        {page === 'OE mapping' && <OEMapping onAlternatives={showAlternatives} onSearch={(oe) => { setQuery(oe); setPage('Inventory'); }} />}
        {page === 'Locations' && <Locations products={products} racks={racks} rackWarehouse={rackWarehouse} setRackWarehouse={setRackWarehouse} newRack={newRack} setNewRack={setNewRack} onAddRack={addRack} />}
        {page === 'Team' && currentUser.role === 'Admin' && <Team users={users} currentUserId={currentUser.id} canManage={canManageTeam} onRoleChange={changeTeamRole} onWarehouseChange={changeTeamWarehouse} onApprove={approveUser} onDelete={deleteTeamMember} onInvite={() => { setTeamError(''); setTeamDraft({ name: '', phone: '', email: '', role: 'Packer', warehouse: 'KG' }); }} />}
        {page === 'Activity' && currentUser.role !== 'Packer' && <ActivityPage events={auditActivity.events} sessions={auditActivity.sessions} retentionDays={auditActivity.retentionDays} loading={auditLoading} />}
        {page === 'Orders' && <OrdersPage orders={orders} canCreate={canEdit} onCreate={openNewOrder} onAccept={acceptOrder} onStatus={changeOrderStatus} onInvoice={setInvoiceOrder} onPhotos={setPhotoOrder} user={currentUser} />}
        {page === 'Packing' && <><PackerAlerts user={currentUser} /><OrdersPage orders={orders.filter((order) => ['ready_to_pack', 'accepted', 'packing'].includes(order.status))} canCreate={false} packingOnly user={currentUser} onAccept={acceptOrder} onStatus={changeOrderStatus} onInvoice={setInvoiceOrder} onPhotos={setPhotoOrder} /></>}
        {page === 'Sales history' && <SalesHistoryPage orders={orders} onInvoice={setInvoiceOrder} report={salesReport} />}
        {page === 'Website Orders' && ['Admin', 'Store Manager'].includes(currentUser.role) && <WebsiteOrdersPage orders={orders.filter((order) => order.source === 'woocommerce')} busy={busy} connected={wooStatus?.connected} onImport={() => runWooAction('orders/pull')} onAssign={assignWebsiteOrder} />}
        {page === 'Car Check' && ['Admin', 'Store Manager'].includes(currentUser.role) && <CarCheckPage connected={wooStatus?.connected} />}
        {page === 'Reports' && <ReportsPage report={salesReport} onRefresh={loadReports} />}
        {page === 'Import / export' && <ImportExportPage canManage={canEdit} busy={busy} error={dataError} onImport={handleImport} onExport={exportProducts} />}
        {page === 'WooCommerce' && ['Admin', 'Store Manager'].includes(currentUser.role) && <WooCommercePage status={wooStatus} busy={busy} canImportCatalog={currentUser.role === 'Admin'} onRefresh={loadWooStatus} onAction={runWooAction} onImportOrders={importWebsiteOrders} />}
      </div>
    </main>
    {modalProduct && <ProductForm key={editingProduct?.id || 'new-product'} product={editingProduct || null} racks={racks} onClose={() => setModalProduct(null)} onSave={saveProduct} />}
    {altProduct && <AlternativesModal product={altProduct.product} products={altProduct.products} onClose={() => setAltProduct(null)} />}
    {orderModalOpen && <CreateOrderModal products={products} packers={packers} loading={packerLoading} initialWarehouse={currentUser.warehouse || 'KG'} onWarehouseChange={loadPackers} onClose={() => setOrderModalOpen(false)} onSave={createOrder} />}
    {quickSellProduct && <QuickSaleModal key={quickSellProduct.id} product={quickSellProduct} packers={packers} loading={packerLoading} onWarehouseChange={loadPackers} onClose={() => setQuickSellProduct(null)} onSave={createQuickSale} />}
    {invoiceOrder && <InvoiceModal order={invoiceOrder} onClose={() => setInvoiceOrder(null)} />}
    {photoOrder && <PackingPhotosModal order={photoOrder} user={currentUser} onClose={() => setPhotoOrder(null)} />}
    {teamDraft && <Modal title="Add team member" onClose={() => { setTeamDraft(null); setTeamError(''); }}><TeamForm user={teamDraft} error={teamError} onCancel={() => { setTeamDraft(null); setTeamError(''); }} onSave={addTeamMember} /></Modal>}
    {toast && <div className="toast"><Check size={16} />{toast}</div>}
  </div>;
}

function InventoryTable({ products, allProducts, warehouseFilter, canEdit, page, pageSize, total, onPageChange, searching, onEdit, onAlternatives, onSell, onDelete }) {
  return <section className="table-region"><div className="table-scroll"><table className="inventory-table"><thead><tr><th>Product</th><th>SKU</th><th>Brand</th><th>OE number</th><th>Available</th><th>Location</th><th>Barcode</th><th>Actions</th></tr></thead><tbody>{products.map((product) => { const qty = availableFor(product, warehouseFilter); return <tr key={product.id}>
    <td className="product-cell"><button className="product-name" onClick={() => canEdit && onEdit(product)}>{product.name}</button>{allProducts.some((other) => other.id !== product.id && other.oe.some((oe) => product.oe.includes(oe))) && <button className="alt-link" onClick={() => onAlternatives(product, allProducts)}>{allProducts.filter((p) => p.id !== product.id && p.oe.some((oe) => product.oe.includes(oe))).length} alternatives <ChevronRight size={13} /></button>}</td>
    <td className="mono">{product.sku}</td><td>{product.brand}</td><td className="mono oe-value">{product.oe.join(', ') || '—'}</td><td><span className={`quantity ${qty === 0 ? 'qty-zero' : qty <= 5 ? 'qty-low' : 'qty-good'}`}>{qty} {product.unit || 'PCS'}</span>{qty > 0 && qty <= 5 && <span className="low-note">Low stock</span>}</td><td className="location-cell">{product.locations.filter((loc) => warehouseFilter === 'all' || loc.warehouse === warehouseFilter).map((loc) => <span key={`${loc.warehouse}-${loc.rack}`}>{loc.warehouse ? <><b>{loc.warehouse}</b>{loc.rack && <> ? {loc.rack}</>}</> : loc.rack}</span>)}</td><td><BarcodeMark value={product.barcode} compact /></td><td className="inventory-actions">{canEdit && <button className="row-action sell-action" onClick={() => onSell(product)} title={`Sell ${product.name}`}><ShoppingCart size={15} /><span>Sell</span></button>}<button className="row-action icon-button" onClick={() => onAlternatives(product, allProducts)} title="View OE alternatives" aria-label={`Compare alternatives for ${product.name}`}><ArrowDownUp size={15} /></button>{canEdit && <button className="row-action delete-action" onClick={() => onDelete(product)} title={`Delete ${product.name}`} aria-label={`Delete ${product.name}`}><Trash2 size={15} /></button>}</td>
  </tr>; })}{!products.length && <tr><td className="no-results" colSpan="8"><Search size={20} /><strong>No matching products</strong><span>Try a different SKU, OE number, barcode or warehouse filter.</span></td></tr>}</tbody></table></div><footer className="table-footer"><span>Showing <strong>{total ? `${((page - 1) * pageSize + 1).toLocaleString('en-IN')} to ${Math.min(page * pageSize, total).toLocaleString('en-IN')}` : '0'}</strong> of <strong>{total.toLocaleString('en-IN')}</strong> products{searching ? ' matching search' : ''}</span><div className="pagination"><button className="page-arrow" disabled={page <= 1} aria-label="Previous page" onClick={() => onPageChange((value) => Math.max(1, value - 1))}><ChevronLeft size={17} /></button><button className="page-current">{page}</button><button className="page-arrow" disabled={page * pageSize >= total} aria-label="Next page" onClick={() => onPageChange((value) => value + 1)}><ChevronRight size={17} /></button></div></footer></section>;
}

function Overview({ products, totalSkus, productSummary, activity, orders, report, totalUnits, lowStock, canEdit, onInventory, onImport, onAddProduct, onSell, onPacking, onActivity, onSalesHistory, onOpenProduct }) {
  const [warehouse, setWarehouse] = useState('all');
  const low = products.filter((product) => (warehouse === 'all' || product.locations.some((location) => location.warehouse === warehouse)) && availableFor(product, warehouse) <= Number(product.reorderPoint || 5))
    .sort((a, b) => availableFor(a, warehouse) - availableFor(b, warehouse)).slice(0, 4);
  const queue = orders.filter((order) => ['ready_to_pack', 'accepted', 'packing'].includes(order.status)).slice(0, 4);
  const todayKey = new Date().toLocaleDateString('en-CA');
  const todayOrders = orders.filter((order) => new Date(order.createdAt).toLocaleDateString('en-CA') === todayKey && order.status !== 'cancelled');
  const todaySales = todayOrders.reduce((sum, order) => sum + Number(order.total || 0), 0);
  const bestSellers = report?.bestSellers || [];
  const maxUnits = Math.max(1, ...bestSellers.map((item) => item.units));
  const warehouseName = (code) => warehouses.find((item) => item.code === code)?.name || code;
  return <>
    <section className="page-heading dashboard-heading"><div><h1>Overview</h1><p>Stock across Kashmiri Gate, Samaypur Badli, Bangalore and Palika Bazaar.</p></div><div className="dashboard-actions">{canEdit && <button className="button button-quiet" onClick={onImport}><FileUp size={16} /> Import stock</button>}{canEdit && <button className="button button-primary" onClick={onAddProduct}><Plus size={16} /> Add product</button>}</div></section>
    <section className="dashboard-kpis"><article><span>Total SKUs</span><strong>{totalSkus.toLocaleString('en-IN')}</strong><small>Across all warehouses</small></article><article><span>Units on hand</span><strong>{totalUnits.toLocaleString('en-IN')}</strong><small>Physical stock</small></article><article className="kpi-alert"><span>Low or out of stock</span><strong>{lowStock.toLocaleString('en-IN')}</strong><small>Needs a stock check</small></article><article><span>Orders to pack</span><strong>{orders.filter((order) => ['ready_to_pack', 'accepted', 'packing'].includes(order.status)).length}</strong><small>Waiting or in progress</small></article><article><span>Sales today</span><strong>{fmt(todaySales)}</strong><small>{todayOrders.length} {todayOrders.length === 1 ? 'order' : 'orders'}</small></article></section>
    <div className="dashboard-feature-grid">
      <section className="dashboard-panel">
        <header className="dashboard-panel-header"><div><h2>Top selling products</h2><p>Units sold, last 30 days</p></div><button className="text-button" onClick={onSalesHistory}>Sales history <ArrowRight size={14} /></button></header>
        {bestSellers.length ? <div className="dashboard-best-list">{bestSellers.slice(0, 4).map((item, index) => <button className="dashboard-best-row" key={item.sku} onClick={() => onOpenProduct(products.find((product) => product.sku === item.sku) || { sku: item.sku })}><span className="best-rank">{String(index + 1).padStart(2, '0')}</span><span className="best-product"><strong>{item.name}</strong><small>{item.sku}</small><i><b style={{ width: `${item.units / maxUnits * 100}%` }} /></i></span><span className="best-stats"><strong>{item.units} units</strong><small>{fmt(item.revenue)}</small></span></button>)}</div> : <div className="dashboard-empty">Sales rankings appear after orders are packed.</div>}
      </section>
      <section className="dashboard-panel">
        <header className="dashboard-panel-header"><div><h2>Ready to pack</h2><p>Orders assigned to your packing team</p></div><button className="text-button" onClick={onPacking}>Open packing <ArrowRight size={14} /></button></header>
        {queue.length ? <div className="dashboard-queue-list">{queue.map((order) => <div className="dashboard-queue-row" key={order.id}><span className="queue-order">{order.orderNumber}</span><div><strong>{order.customer.name}</strong><small>{order.items.length} {order.items.length === 1 ? 'item' : 'items'} · {order.assignedName || 'Waiting for assignment'}</small></div><span className={`order-status status-${order.status}`}>{order.status === 'ready_to_pack' ? 'Unassigned' : order.status.replaceAll('_', ' ')}</span></div>)}</div> : <div className="dashboard-empty">No orders are waiting to be packed.</div>}
      </section>
    </div>
    <div className="dashboard-lower-grid">
      <section className="dashboard-panel dashboard-reorder">
        <header className="dashboard-panel-header"><div><h2>Reorder list</h2><p>Parts at or below their reorder point</p></div><div className="dashboard-warehouse-tabs"><button className={warehouse === 'all' ? 'active' : ''} onClick={() => setWarehouse('all')}>All</button>{warehouses.map((item) => <button key={item.code} className={warehouse === item.code ? 'active' : ''} onClick={() => setWarehouse(item.code)}>{item.code}</button>)}</div></header>
        <div className="dashboard-table-wrap"><table className="dashboard-table"><thead><tr><th>Part</th><th>Part no.</th><th>Warehouse</th><th>Available</th><th>Min</th><th /></tr></thead><tbody>{low.map((product) => { const location = product.locations.find((entry) => (warehouse === 'all' || entry.warehouse === warehouse) && Number(entry.qty || 0) - Number(entry.reserved || 0) > 0) || product.locations.find((entry) => warehouse === 'all' || entry.warehouse === warehouse); const available = availableFor(product, warehouse); return <tr key={product.id}><td><button className="dashboard-product-link" onClick={() => onOpenProduct(product)}>{product.name}<small>{product.brand}</small></button></td><td className="mono">{product.sku}</td><td>{location ? warehouseName(location.warehouse) : '—'}</td><td><span className={`quantity ${available === 0 ? 'qty-zero' : 'qty-low'}`}>{available}</span></td><td>{product.reorderPoint || 5}</td><td>{canEdit && <button className="button button-quiet button-small" disabled={available === 0} onClick={() => onSell(product)}>Sell</button>}</td></tr>; })}{!low.length && <tr><td colSpan="6"><div className="dashboard-empty">No products need attention in this warehouse.</div></td></tr>}</tbody></table></div>
      </section>
      <section className="dashboard-panel dashboard-activity"><header className="dashboard-panel-header"><div><h2>Recent activity</h2><p>Latest changes from your team</p></div><button className="text-button" onClick={onActivity}>View all <ArrowRight size={14} /></button></header><div className="dashboard-activity-list">{activity.slice(0, 4).map((item) => <article className="dashboard-activity-row" key={item.id}><span className="activity-dot" /><div><strong>{item.action}</strong><p>{item.detail}</p><small>{item.user} · {item.time}</small></div></article>)}{!activity.length && <div className="dashboard-empty">Inventory updates will appear here.</div>}</div></section>
    </div>
    <section className="dashboard-panel dashboard-warehouses"><header className="dashboard-panel-header"><div><h2>Warehouse stock</h2><p>Units held at each location</p></div><button className="text-button" onClick={() => onInventory()}>Manage stock <ArrowRight size={14} /></button></header><div className="dashboard-warehouse-grid">{warehouses.map((item) => { const qty = productSummary?.warehouses?.[item.code] ?? products.reduce((sum, product) => sum + totalForWarehouse(product, item.code), 0); const share = totalUnits ? qty / totalUnits * 100 : 0; const lowCount = products.filter((product) => availableFor(product, item.code) <= Number(product.reorderPoint || 5)).length; return <article key={item.code}><div><span className="warehouse-code">{item.code}</span><small>{item.name}</small></div><strong>{qty.toLocaleString('en-IN')} <small>units</small></strong><i><b style={{ width: `${Math.max(2, share)}%` }} /></i><footer><span>{Math.round(share)}% of stock</span><span>{lowCount} low</span></footer></article>; })}</div></section>
  </>;
}

function OEMapping({ onAlternatives, onSearch }) {
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ groups: [], total: 0, page: 1, pageSize: 30 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    api(`/products/oe-mappings?page=${page}&limit=30`).then((result) => { if (active) setData(result); }).catch((failure) => { if (active) setError(failure.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [page]);
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  return <><section className="page-heading"><div><h1>OE mapping</h1><p>Compare compatible parts by original equipment number.</p></div></section><div className="oe-intro"><Link2 size={20} /><p>Parts sharing an OE number appear together, with live quantity and price across KG, SPB, BG and PB.</p><span>{data.total.toLocaleString('en-IN')} OE numbers</span></div>{error && <p className="search-feedback search-fallback">{error}</p>}{loading && !data.groups.length && <p className="search-feedback">Loading OE mappings?</p>}<section className="mapping-list">{data.groups.map(({ oe, products: matches }) => <article className="mapping-group" key={oe}><header><button className="mapping-number" onClick={() => onSearch(oe)}>{oe}</button><span>{matches.length} matching {matches.length === 1 ? 'part' : 'parts'}</span><button className="text-button" onClick={() => matches[0] && onAlternatives(matches[0], matches)}>Compare prices <ArrowRight size={15} /></button></header><div className="mapping-products">{matches.map((product) => <div className="mapping-product" key={product.id}><div className="mapping-product-name"><strong>{product.name}</strong><small>{product.brand} ? {product.sku}</small></div><div className="mapping-availability"><b className={stockTotal(product) ? 'stock-good' : 'stock-zero'}>{stockTotal(product)} units</b><small>{product.locations.map((location) => [location.warehouse, location.rack].filter(Boolean).join(' ? ')).filter(Boolean).join(', ') || 'Location not entered'}</small></div><div className="mapping-price">{fmt(product.price)}<small>{product.priceIncludesGst ? 'incl. GST' : '+ 18% GST'}</small></div><BarcodeMark value={product.barcode} compact /></div>)}</div></article>)}{!loading && !error && !data.groups.length && <div className="empty-state">No OE numbers have been added to your products yet.</div>}</section><footer className="table-footer"><span>Showing <strong>{data.total ? `${((page - 1) * data.pageSize + 1).toLocaleString('en-IN')} to ${Math.min(page * data.pageSize, data.total).toLocaleString('en-IN')}` : '0'}</strong> of <strong>{data.total.toLocaleString('en-IN')}</strong> OE numbers</span><div className="pagination"><button className="page-arrow" disabled={page <= 1 || loading} aria-label="Previous page" onClick={() => setPage((value) => Math.max(1, value - 1))}><ChevronLeft size={17} /></button><button className="page-current">{page}</button><button className="page-arrow" disabled={page >= pages || loading} aria-label="Next page" onClick={() => setPage((value) => value + 1)}><ChevronRight size={17} /></button></div></footer></>;
}

function Locations({ products, racks, rackWarehouse, setRackWarehouse, newRack, setNewRack, onAddRack }) {
  const [search, setSearch] = useState('');
  const locations = products.flatMap((product) => product.locations.map((loc) => ({ ...loc, product }))).filter((item) => item.warehouse === rackWarehouse && (!search || `${item.rack} ${item.product.name} ${item.product.sku}`.toLowerCase().includes(search.toLowerCase()))).sort((a, b) => a.rack.localeCompare(b.rack, undefined, { numeric: true }));
  const usedRacks = new Set(products.flatMap((p) => p.locations.filter((l) => l.warehouse === rackWarehouse).map((l) => l.rack)));
  return <><section className="page-heading"><div><h1>Locations</h1><p>Find stock by warehouse and rack.</p></div></section><div className="location-controls"><div className="warehouse-tabs">{warehouses.map((w) => <button key={w.code} className={rackWarehouse === w.code ? 'warehouse-tab active' : 'warehouse-tab'} onClick={() => setRackWarehouse(w.code)}><b>{w.code}</b><span>{w.name}</span></button>)}</div><div className="rack-add-row"><div className="rack-capacity"><MapPin size={17} /><span><strong>{usedRacks.size}</strong> racks in use</span></div><div className="rack-add-form"><input value={newRack} onChange={(e) => setNewRack(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && onAddRack()} placeholder="New rack e.g. G-160A" /><button className="button button-primary" onClick={onAddRack}><Plus size={16} /> Add rack</button></div></div></div><div className="location-search"><Search size={17} /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search rack, product or SKU…" /><span>{racks.length.toLocaleString('en-IN')} rack labels</span></div><section className="location-table table-scroll"><table className="inventory-table"><thead><tr><th>Rack</th><th>Product</th><th>SKU</th><th>Brand</th><th>Quantity</th><th>OE number</th></tr></thead><tbody>{locations.map((item, i) => <tr key={`${item.product.id}-${item.rack}-${i}`}><td><span className="rack-tag"><MapPin size={14} />{item.rack}</span></td><td className="product-name-plain">{item.product.name}</td><td className="mono">{item.product.sku}</td><td>{item.product.brand}</td><td><span className={`quantity ${item.qty === 0 ? 'qty-zero' : item.qty <= 5 ? 'qty-low' : 'qty-good'}`}>{item.qty} units</span></td><td className="mono">{item.product.oe.join(', ') || '—'}</td></tr>)}{!locations.length && <tr><td className="no-results" colSpan="6"><MapPin size={20} /><strong>No stock found here</strong><span>Try another search or add stock to this warehouse.</span></td></tr>}</tbody></table></section></>;
}

function Team({ users, currentUserId, canManage, onRoleChange, onWarehouseChange, onApprove, onDelete, onInvite }) {
  return <><section className="page-heading"><div><h1>Team</h1><p>Approve registrations and manage warehouse access.</p></div>{canManage && <button className="button button-primary" onClick={onInvite}><Plus size={17} /> Add team member</button>}</section><section className="role-key"><div><Shield size={17} /><strong>Admin</strong><span>Full access and registration approvals</span></div><div><Settings2 size={17} /><strong>Store Manager</strong><span>Manage products, stock and orders</span></div><div><PackageCheck size={17} /><strong>Packer</strong><span>Orders and packing at their warehouse</span></div></section><section className="team-table table-scroll"><table className="inventory-table"><thead><tr><th>Team member</th><th>Email / phone</th><th>Role</th><th>Warehouse</th><th>Access</th><th>Approval</th><th>Actions</th></tr></thead><tbody>{users.map((user) => <tr key={user.id}><td><div className="team-person"><span className="avatar">{user.name.split(' ').map((n) => n[0]).join('').slice(0, 2)}</span><strong>{user.name}</strong>{user.id === currentUserId && <span className="you-label">You</span>}</div></td><td>{user.email}<small className="assigned-label">{user.phone || '—'}</small></td><td><select className="role-select" value={user.role} onChange={(e) => onRoleChange(user.id, e.target.value)}><option>Admin</option><option>Store Manager</option><option>Packer</option></select></td><td><select className="role-select" value={user.warehouse || 'KG'} onChange={(e) => onWarehouseChange(user.id, e.target.value)}>{warehouses.map((location) => <option key={location.code} value={location.code}>{location.code} · {location.name}</option>)}</select></td><td><span className="access-state"><span className={`live-dot ${user.active === false ? 'inactive-dot' : ''}`} />{user.active === false ? 'Inactive' : 'Active'}</span></td><td>{user.approved === false ? <button className="button button-primary button-small" onClick={() => onApprove(user.id)}>Approve</button> : <span className="role-label">Approved</span>}</td><td>{user.id !== currentUserId && <button className="button button-danger button-small team-delete-button" onClick={() => onDelete(user)}><Trash2 size={13} /> Delete</button>}</td></tr>)}</tbody></table></section></>;
}
function TeamForm({ user, error, onSave, onCancel }) {
  const [form, setForm] = useState(user);
  return <form className="team-form" onSubmit={(e) => { e.preventDefault(); onSave(form); }}><label className="field"><span>Full name</span><input required autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Name" /></label><label className="field"><span>Phone number</span><input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="Optional" /></label><label className="field"><span>Work email</span><input required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="you@company.com" /></label><label className="field"><span>Role</span><select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}><option>Packer</option><option>Store Manager</option><option>Admin</option></select></label><label className="field"><span>Warehouse</span><select value={form.warehouse} onChange={(e) => setForm({ ...form, warehouse: e.target.value })}>{warehouses.map((location) => <option key={location.code} value={location.code}>{location.code} · {location.name}</option>)}</select></label><label className="field"><span>Temporary password <small>At least 12 characters</small></span><input required minLength="12" type="password" value={form.password || ''} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>{error && <div className="form-error">{error}</div>}<p className="helper-text">This admin-created account is approved immediately.</p><footer className="modal-actions"><button type="button" className="button button-quiet" onClick={onCancel}>Cancel</button><button className="button button-primary"><Plus size={16} /> Add member</button></footer></form>;
}

function formatDuration(seconds) {
  const totalMinutes = Math.max(0, Math.floor(Number(seconds || 0) / 60));
  const days = Math.floor(totalMinutes / 1440); const hours = Math.floor((totalMinutes % 1440) / 60); const minutes = totalMinutes % 60;
  return [days ? `${days}d` : '', hours ? `${hours}h` : '', `${minutes}m`].filter(Boolean).join(' ');
}

function dateTime(value) { return value ? new Date(value).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—'; }

function ActivityPage({ events, sessions, retentionDays, loading }) {
  const sales = events.filter((event) => event.type === 'sale_created');
  const packing = events.filter((event) => event.type === 'order_packed');
  const elapsed = (session) => session.active ? Math.max(0, Math.floor((Date.now() - new Date(session.loginAt).getTime()) / 1000)) : session.durationSeconds;
  const sessionEndLabel = (session) => session.endReason === 'logout' ? 'Logged out' : session.endReason === 'admin_removed' ? 'Account removed' : 'Connection lost';
  return <><section className="page-heading"><div><h1>Activity</h1><p>Sales, packing history, and team sign-in time. Records are retained for at least six months.</p></div><span className="audit-retention">{retentionDays} day retention</span></section>
    {loading && !events.length && !sessions.length && <p className="photo-feedback">Loading activity…</p>}
    <section className="audit-panel"><header><div><h2>Sales activity</h2><p>Product, party, seller, and selling price for each sale.</p></div><strong>{sales.length}</strong></header><div className="audit-table-wrap"><table className="audit-table"><thead><tr><th>Sold at</th><th>Order / party</th><th>Product</th><th>Qty</th><th>Unit price</th><th>Line total</th><th>Sold by</th><th>Warehouse</th></tr></thead><tbody>{sales.flatMap((event) => event.items.map((item, index) => <tr key={`${event.eventKey || event._id}-${item.sku}-${index}`}><td>{dateTime(event.occurredAt)}</td><td><strong>{event.orderNumber}</strong><small>{event.customerName || 'Walk-in customer'}</small></td><td><strong>{item.name}</strong><small>{item.sku}{event.source === 'woocommerce' ? ' · WooCommerce' : ''}</small></td><td>{item.quantity} {item.unit || 'PCS'}</td><td>{fmt(item.unitPrice)}</td><td>{fmt(item.lineTotal)}</td><td>{event.actorName}<small>{event.actorRole}</small></td><td>{event.warehouse}</td></tr>))}{!sales.length && <tr><td colSpan="8">{loading ? 'Loading sales records…' : 'No sales have been recorded yet.'}</td></tr>}</tbody></table></div></section>
    <section className="audit-panel"><header><div><h2>Packing history</h2><p>Products completed by Packers, including packing time and item prices.</p></div><strong>{packing.length}</strong></header><div className="audit-table-wrap"><table className="audit-table"><thead><tr><th>Packed at</th><th>Order / party</th><th>Product</th><th>Qty</th><th>Unit price</th><th>Line total</th><th>Packer</th><th>Warehouse</th></tr></thead><tbody>{packing.flatMap((event) => event.items.map((item, index) => <tr key={`${event.eventKey || event._id}-${item.sku}-${index}`}><td>{dateTime(event.occurredAt)}</td><td><strong>{event.orderNumber}</strong><small>{event.customerName || 'Walk-in customer'}</small></td><td><strong>{item.name}</strong><small>{item.sku} | {item.gstRate === 18 ? (item.gstIncluded ? 'GST included' : 'GST added at 18%') : 'GST details unavailable'}</small></td><td>{item.quantity} {item.unit || 'PCS'}</td><td>{fmt(item.unitPrice)}</td><td>{fmt(item.lineTotal)}</td><td>{event.actorName}<small>{event.actorRole}</small></td><td>{event.warehouse}</td></tr>))}{!packing.length && <tr><td colSpan="8">{loading ? 'Loading packing records…' : 'No completed packing history yet.'}</td></tr>}</tbody></table></div></section>
    <section className="audit-panel"><header><div><h2>User sessions</h2><p>Login, last confirmed activity, total duration, and how each session ended.</p></div><strong>{sessions.length}</strong></header><div className="audit-table-wrap"><table className="audit-table"><thead><tr><th>Team member</th><th>Role / warehouse</th><th>Login time</th><th>Last seen</th><th>Duration</th><th>Session ended</th><th>Status</th></tr></thead><tbody>{sessions.map((session) => <tr key={session.id}><td><strong>{session.userName}</strong><small>{session.userEmail}</small></td><td>{session.userRole}<small>{session.warehouse || 'All warehouses'}</small></td><td>{dateTime(session.loginAt)}</td><td>{dateTime(session.lastSeenAt)}</td><td>{formatDuration(elapsed(session))}</td><td>{session.endedAt ? `${dateTime(session.endedAt)} · ${sessionEndLabel(session)}` : '—'}</td><td><span className={`session-pill ${session.active ? 'session-active' : ''}`}>{session.active ? 'Active' : sessionEndLabel(session)}</span></td></tr>)}{!sessions.length && <tr><td colSpan="7">{loading ? 'Loading sign-in records…' : 'No sign-in records yet.'}</td></tr>}</tbody></table></div></section>
  </>;
}

function PackerAlerts({ user }) {
  const [state, setState] = useState('checking');
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    if (!window.isSecureContext) { setState('insecure'); return undefined; }
    if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) { setState('unsupported'); return undefined; }
    navigator.serviceWorker.register('/sw.js').then(async (registration) => {
      const subscription = await registration.pushManager.getSubscription();
      if (!active) return;
      if (subscription && Notification.permission === 'granted') {
        const config = await api('/push/public-key');
        if (config.configured) await api('/push/subscribe', { method: 'POST', body: JSON.stringify(subscription) });
        if (active) setState(config.configured ? 'enabled' : 'unconfigured');
      } else setState(Notification.permission === 'denied' ? 'denied' : 'off');
    }).catch(() => { if (active) setState('unsupported'); });
    return () => { active = false; };
  }, [user?.id]);
  const enable = async () => {
    setError('');
    try {
      if (!window.isSecureContext) { setState('insecure'); return; }
      const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
      if (permission !== 'granted') { setState('denied'); return; }
      const result = await api('/push/public-key');
      if (!result.configured || !result.publicKey) { setState('unconfigured'); return; }
      const registration = await navigator.serviceWorker.ready;
      const keyBase64 = result.publicKey.replace(/-/g, '+').replace(/_/g, '/');
      const applicationServerKey = Uint8Array.from(atob(keyBase64.padEnd(Math.ceil(keyBase64.length / 4) * 4, '=')), (character) => character.charCodeAt(0));
      const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
      await api('/push/subscribe', { method: 'POST', body: JSON.stringify(subscription) });
      setState('enabled');
    } catch (failure) { setError(failure.message || 'Could not enable alerts on this device.'); setState('off'); }
  };
  if (state === 'enabled') return <div className="packer-alert-banner alert-enabled"><span className="alert-status-dot" /><div><strong>Order alerts are on</strong><small>This phone will notify you when a new order is assigned.</small></div></div>;
  return <div className="packer-alert-banner"><span className="alert-bell">♢</span><div><strong>{state === 'insecure' ? 'Chrome needs a secure HTTPS address' : state === 'denied' ? 'Notifications are blocked' : state === 'unsupported' ? 'Push alerts unavailable' : state === 'unconfigured' ? 'Push alerts need server setup' : 'Get new order alerts on this phone'}</strong><small>{state === 'insecure' ? 'This app is open over HTTP on a local network IP. Chrome will not show the permission prompt until you open the app on HTTPS with a trusted certificate. A setting change cannot override this browser security rule.' : state === 'denied' ? 'Allow notifications for this site in Chrome site settings.' : state === 'unsupported' ? 'Use Chrome on a secure HTTPS site with web push support.' : state === 'unconfigured' ? 'Ask your administrator to configure the push notification keys.' : 'Tap Enable alerts to allow assigned orders to notify you, even when the app is closed.'}</small>{error && <small className="alert-error">{error}</small>}</div>{['off', 'checking'].includes(state) && <button className="button button-primary button-small" disabled={state === 'checking'} onClick={enable}>Enable alerts</button>}{state === 'unconfigured' && <button className="button button-quiet button-small" onClick={enable}>Try again</button>}</div>;
}

function compressPhoto(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read this photo.'));
    reader.onload = () => {
      const image = new Image(); image.onerror = () => reject(new Error('This file is not a supported image.'));
      image.onload = () => { const scale = Math.min(1, 1440 / Math.max(image.width, image.height)); const canvas = document.createElement('canvas'); canvas.width = Math.round(image.width * scale); canvas.height = Math.round(image.height * scale); canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height); resolve(canvas.toDataURL('image/jpeg', 0.78)); };
      image.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

function PackingPhotosModal({ order, user, onClose }) {
  const canManage = user?.role === 'Admin' || user?.role === 'Store Manager';
  const canUpload = user?.role === 'Packer' && ['accepted', 'packing'].includes(order.status);
  const maxPhotosPerProduct = 10;
  const [photos, setPhotos] = useState([]); const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [working, setWorking] = useState('');
  const refresh = async () => { try { const result = await api(`/orders/${encodeURIComponent(order.id)}/photos`); setPhotos(result.items); } catch (failure) { setError(failure.message); } finally { setLoading(false); } };
  useEffect(() => { refresh(); }, [order.id]);
  const upload = async (sku, file, slot) => {
    const workId = `${sku}-${slot}`; setWorking(workId); setError('');
    try { const imageData = await compressPhoto(file); const result = await api(`/orders/${encodeURIComponent(order.id)}/photos`, { method: 'POST', body: JSON.stringify({ sku, imageData }) }); setPhotos((old) => [result.photo, ...old]); }
    catch (failure) { setError(failure.message); }
    finally { setWorking(''); }
  };
  const keepProduct = async (photo) => { setWorking(photo.productId); setError(''); try { const result = await api(`/products/${encodeURIComponent(photo.productId)}/packing-photos/keep`, { method: 'PATCH' }); await refresh(); setError(result.kept ? `${photo.sku}: all ${result.kept} packing photo(s) kept.` : `${photo.sku}: no photos to keep.`); } catch (failure) { setError(failure.message); } finally { setWorking(''); } };
  const deletePhoto = async (photo) => { setWorking(photo.id); setError(''); try { await api(`/packing-photos/${encodeURIComponent(photo.id)}`, { method: 'DELETE' }); setPhotos((old) => old.filter((entry) => entry.id !== photo.id)); } catch (failure) { setError(failure.message); } finally { setWorking(''); } };
  return <Modal title={`Packing photos · ${order.orderNumber}`} onClose={onClose} wide><div className="packing-photo-content">
    {canUpload && <div className="photo-upload-products">{order.items.map((item) => {
      const productPhotos = photos.filter((photo) => photo.sku === item.sku);
      const slotCount = Math.max(6, Math.min(maxPhotosPerProduct, productPhotos.length));
      return <section className="photo-product-slots" key={item.sku}><header><div><strong>{item.name}</strong><small>{item.sku} · {productPhotos.length}/{maxPhotosPerProduct} photos uploaded</small></div></header><div className="photo-slot-grid">{Array.from({ length: slotCount }, (_, index) => {
        const savedPhoto = productPhotos[index]; const workId = `${item.sku}-${index}`;
        return savedPhoto
          ? <div className="photo-slot photo-slot-filled" key={`${item.sku}-${index}`}><Check size={17} /><span>Photo {index + 1}</span><small>Uploaded</small></div>
          : <label className="photo-slot" key={`${item.sku}-${index}`}><input type="file" accept="image/*" capture="environment" disabled={Boolean(working) || productPhotos.length >= maxPhotosPerProduct} onChange={(event) => { const file = event.target.files?.[0]; if (file) upload(item.sku, file, index); event.target.value = ''; }} /><Plus size={17} /><span>{working === workId ? 'Uploading…' : `Photo ${index + 1}`}</span><small>{working === workId ? 'Please wait' : 'Take photo'}</small></label>;
      })}</div></section>;
    })}</div>}
    {error && <p className="photo-feedback" role="status">{error}</p>}
    {loading ? <p className="photo-feedback">Loading photos…</p> : photos.length ? <div className="packing-photo-grid">{photos.map((photo) => <article className="packing-photo-card" key={photo.id}><a href={photo.imageUrl} target="_blank" rel="noreferrer"><img src={photo.imageUrl} alt={`${photo.productName} packed by ${photo.packerName}`} loading="lazy" /></a><div className="packing-photo-details"><strong>{photo.productName}</strong><small>{photo.sku} · {photo.packerName}</small><small>{photo.keep ? 'Kept permanently' : `Auto-deletes ${new Date(photo.expiresAt).toLocaleDateString('en-IN')}`}</small>{canManage && <div className="photo-management-actions">{!photo.keep && <button className="text-button" disabled={Boolean(working)} onClick={() => keepProduct(photo)}>Keep all {photo.sku} photos</button>}<button className="text-button photo-delete" disabled={Boolean(working)} onClick={() => deletePhoto(photo)}>Delete photo</button></div>}</div></article>)}</div> : <div className="photo-empty"><PackageCheck size={24} /><strong>No packing photos yet</strong><span>{canUpload ? 'Use the six photo slots above to capture the packed product.' : 'Photos uploaded by the packer will appear here.'}</span></div>}
  </div><footer className="modal-actions photo-modal-footer"><span className="helper-text">Up to 10 photos per product · photos delete after 7 days unless kept.</span><button className="button button-quiet" onClick={onClose}>Done</button></footer></Modal>;
}

const STATUS_LABELS = { ready_to_pack: 'Ready to pack', accepted: 'Accepted', packing: 'Packing', packed: 'Packed', shipped: 'Shipped', completed: 'Completed', cancelled: 'Cancelled' };
const NEXT_STATUS = { accepted: ['packing', 'Start packing'], packing: ['packed', 'Mark packed'], packed: ['shipped', 'Mark shipped'], shipped: ['completed', 'Complete order'] };

function OrdersPage({ orders, canCreate, packingOnly = false, user, onCreate, onAccept, onStatus, onInvoice, onPhotos }) {
  const [filter, setFilter] = useState('all');
  const visibleOrders = orders.filter((order) => filter === 'all' || order.status === filter);
  const readyCount = orders.filter((order) => order.status === 'ready_to_pack').length;
  return <><section className="page-heading"><div><h1>{packingOnly ? 'Packing queue' : 'Sales orders'}</h1><p>{packingOnly ? 'Pick your assigned parts, then confirm packing and dispatch.' : 'Create an order and follow it from payment through dispatch.'}</p></div>{canCreate && !packingOnly && <button className="button button-primary" onClick={onCreate}><Plus size={17} /> New sale</button>}</section><div className="order-summary"><div><span>Orders</span><strong>{orders.length}</strong></div><div><span>Ready to pack</span><strong className={readyCount ? 'summary-green' : ''}>{readyCount}</strong></div><div><span>Being packed</span><strong>{orders.filter((order) => ['accepted', 'packing'].includes(order.status)).length}</strong></div><div><span>Fulfilled</span><strong>{orders.filter((order) => ['packed', 'shipped', 'completed'].includes(order.status)).length}</strong></div></div><div className="orders-toolbar"><div className="orders-filter-tabs">{['all', 'ready_to_pack', 'accepted', 'packing', 'packed', 'shipped', 'completed'].map((status) => <button key={status} className={filter === status ? 'active' : ''} onClick={() => setFilter(status)}>{status === 'all' ? 'All orders' : STATUS_LABELS[status]}</button>)}</div><span>{visibleOrders.length} shown</span></div><section className="orders-table-wrap"><table className="orders-table"><thead><tr><th>Order</th><th>Customer</th><th>Items</th><th>Total</th><th>Payment</th><th>Warehouse</th><th>Status</th><th>Created</th><th>Actions</th></tr></thead><tbody>{visibleOrders.map((order) => { const transition = NEXT_STATUS[order.status]; const assigned = !user || !order.assignedTo || order.assignedTo === user.id || canCreate; const unreservedSkus = order.items.filter((item) => !item.allocations?.length).map((item) => item.sku); return <tr key={order.id}><td><strong>{order.orderNumber}</strong><small>{order.invoiceNumber}{order.source === 'woocommerce' && <em>Website order</em>}</small></td><td><strong>{order.customer.name}</strong><small>{order.customer.phone || order.customer.email || 'In-store sale'}</small></td><td>{order.items.map((item) => `${item.sku} × ${item.quantity}`).join(', ')}{order.source === 'woocommerce' && unreservedSkus.length > 0 && <small className="order-stock-warning">Stock not reserved: {unreservedSkus.join(', ')}</small>}</td><td className="order-total">{fmt(order.total)}</td><td><span className={`payment-state payment-${order.paymentStatus || 'unpaid'}`}>{order.paymentStatus || 'unpaid'}</span><small className="assigned-label">{order.paymentMethod?.replaceAll('_', ' ')}</small></td><td>{order.warehouse}</td><td><span className={`order-status status-${order.status}`}>{STATUS_LABELS[order.status] || order.status}</span>{order.assignedName && <small className="assigned-label">with {order.assignedName}</small>}</td><td>{new Date(order.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}</td><td className="order-actions"><button className="text-button invoice-action" onClick={() => onInvoice(order)}>Invoice</button>{onPhotos && <button className="text-button invoice-action" onClick={() => onPhotos(order)}>Photos</button>}{order.status === 'ready_to_pack' && user?.role === 'Packer' && <button className="button button-primary button-small" onClick={() => onAccept(order)}><Check size={13} /> Accept</button>}{transition && assigned && (canCreate || user?.role === 'Packer') && <button className="button button-quiet button-small" onClick={() => onStatus(order, transition[0])}>{transition[1]}</button>}{canCreate && ['ready_to_pack', 'accepted', 'packing'].includes(order.status) && <button className="cancel-order" onClick={() => onStatus(order, 'cancelled')}>Cancel</button>}</td></tr>; })}{!visibleOrders.length && <tr><td colSpan="9"><div className="empty-state"><ClipboardList size={22} /><strong>{packingOnly ? 'Nothing assigned to pack' : 'No sales orders yet'}</strong><span>{packingOnly ? 'Orders assigned to your warehouse will appear here.' : canCreate ? 'Create an in-store sale or import orders from WooCommerce.' : 'Orders will appear here when they are ready.'}</span></div></td></tr>}</tbody></table></section></>;
}

function QuickSaleModal({ product, packers, loading, onWarehouseChange, onClose, onSave }) {
  const stockLocations = product.locations.filter((location) => Number(location.qty || 0) - Number(location.reserved || 0) > 0);
  const [warehouse, setWarehouse] = useState(stockLocations[0]?.warehouse || 'KG');
  const [quantity, setQuantity] = useState(1);
  const [customerName, setCustomerName] = useState('Walk-in customer');
  const [packerId, setPackerId] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [freeSale, setFreeSale] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (!packerId && packers[0]) setPackerId(packers[0].id); }, [packers, packerId]);
  const available = availableFor(product, warehouse);
  const salePrice = freeSale ? 0 : Number(product.price || 0);
  const total = gstTotal(salePrice * Number(quantity || 0), Boolean(product.priceIncludesGst));
  const taxAmount = gstCharge(salePrice * Number(quantity || 0), Boolean(product.priceIncludesGst));
  const unassignedStock = product.locations.filter((location) => !location.warehouse).reduce((sum, location) => sum + Math.max(0, Number(location.qty || 0) - Number(location.reserved || 0)), 0);
  const submit = async (event) => {
    event.preventDefault(); setError(''); setSaving(true);
    try { await onSave({ warehouse, customer: { name: customerName.trim() }, items: [{ sku: product.sku, quantity: Number(quantity), unitPrice: salePrice }], paymentMethod, amountPaid: paymentMethod === 'credit' ? 0 : total, packerId }); }
    catch (failure) { setError(failure.message); }
    finally { setSaving(false); }
  };
  return <Modal title="Quick sale" onClose={onClose}>
    <form className="quick-sale-form" onSubmit={submit}>
      <div className="quick-sale-product"><span className="quick-sale-icon"><ShoppingCart size={20} /></span><div><strong>{product.name}</strong><small>{product.brand} · {product.sku} · {product.priceIncludesGst ? 'GST included' : 'plus 18% GST'}</small></div><b>{fmt(salePrice)}</b></div>
      <label className="field"><span>Customer</span><input autoFocus value={customerName} onChange={(event) => setCustomerName(event.target.value)} required /></label>
      <label className="gst-checkbox-control"><input type="checkbox" checked={freeSale} onChange={(event) => setFreeSale(event.target.checked)} /><span><strong>Sell for ₹0</strong><small>Record this as a complimentary sale.</small></span></label>
      <div className="quick-sale-grid"><label className="field"><span>Pick from</span><select value={warehouse} onChange={(event) => { const selected = event.target.value; setWarehouse(selected); setPackerId(''); setQuantity(Math.min(quantity, availableFor(product, selected) || 1)); onWarehouseChange(selected); }}>{warehouses.map((location) => <option key={location.code} value={location.code} disabled={!stockLocations.some((entry) => entry.warehouse === location.code)}>{location.code} · {location.name} ({availableFor(product, location.code)} available)</option>)}</select></label><label className="field"><span>Quantity ({product.unit || 'PCS'})</span><input type="number" min="1" max={available} value={quantity} onChange={(event) => setQuantity(Math.min(available || 1, Math.max(1, Number(event.target.value) || 1)))} /></label></div>
      <label className="field"><span>Packer ID</span><select required value={packerId} disabled={loading || !packers.length} onChange={(event) => setPackerId(event.target.value)}><option value="">{loading ? 'Loading packers…' : 'Select a packer'}</option>{packers.map((packer) => <option key={packer.id} value={packer.id}>{packer.name} · {packer.id}</option>)}</select></label>
      <label className="field"><span>Payment</span><select value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value)}><option value="cash">Cash</option><option value="card">Card</option><option value="upi">UPI</option><option value="bank_transfer">Bank transfer</option><option value="credit">Credit / pay later</option></select></label>
      <div className="quick-sale-total"><span>GST (18%)</span><small>{fmt(taxAmount)} · {available} available at {warehouse}</small><strong>Total due {fmt(total)}</strong></div>
      {!packers.length && !loading && <p className="form-error">No approved packers are assigned to {warehouse}. Ask an admin to approve a packer at this warehouse.</p>}
      {available < 1 && <p className="form-error">{unassignedStock > 0 ? `${unassignedStock} units have no warehouse assigned. Assign them to a warehouse before selling.` : 'This product has no available stock at the selected warehouse.'}</p>}
      {error && <p className="form-error">{error}</p>}
      <footer className="modal-actions"><button type="button" className="button button-quiet" onClick={onClose}>Cancel</button><button className="button button-primary" disabled={saving || loading || !packers.length || available < 1 || quantity > available || !packerId}>{saving ? 'Creating sale…' : 'Sell & assign to packer'} <ArrowRight size={15} /></button></footer>
    </form>
  </Modal>;
}

function CreateOrderModal({ products, packers, loading, initialWarehouse, onWarehouseChange, onClose, onSave }) {
  const [warehouse, setWarehouse] = useState(initialWarehouse); const [packerId, setPackerId] = useState(''); const [customer, setCustomer] = useState({ name: '', email: '', phone: '', address: '', gstin: '' });
  const [items, setItems] = useState([{ sku: '', quantity: 1, unitPrice: 0, priceIncludesGst: false }]); const [discountAmount, setDiscountAmount] = useState(0); const [shippingAmount, setShippingAmount] = useState(0); const [paymentMethod, setPaymentMethod] = useState('cash'); const [amountPaid, setAmountPaid] = useState(''); const [error, setError] = useState(''); const [saving, setSaving] = useState(false);
  const changeItem = (index, key, value) => setItems((old) => old.map((item, position) => position === index ? { ...item, [key]: value } : item));
  const chooseProduct = (index, sku) => { const product = products.find((entry) => entry.sku === sku); setItems((old) => old.map((item, position) => position === index ? { ...item, sku, unitPrice: product?.price || 0, priceIncludesGst: Boolean(product?.priceIncludesGst) } : item)); };
  const subtotal = roundMoney(items.reduce((sum, item) => sum + gstBase(Number(item.quantity || 0) * Number(item.unitPrice || 0), item.priceIncludesGst), 0));
  const taxable = Math.max(0, subtotal - Number(discountAmount || 0));
  const taxAmount = roundMoney(taxable * GST_RATE / 100);
  const total = roundMoney(taxable + taxAmount + Number(shippingAmount || 0));
  const submit = async (event) => { event.preventDefault(); setError(''); setSaving(true); try { await onSave({ warehouse, packerId, customer, items: items.map((item) => ({ ...item, quantity: Number(item.quantity), unitPrice: Number(item.unitPrice) })), taxRate: GST_RATE, discountAmount: Number(discountAmount), shippingAmount: Number(shippingAmount), paymentMethod, amountPaid: amountPaid === '' ? undefined : Number(amountPaid) }); } catch (failure) { setError(failure.message); } finally { setSaving(false); } };
  return <Modal title="New sale" onClose={onClose} wide><form className="product-form order-form" onSubmit={submit}><div className="form-grid"><label className="field"><span>Customer name</span><input autoFocus required value={customer.name} onChange={(e) => setCustomer({ ...customer, name: e.target.value })} placeholder="Customer or company" /></label><label className="field"><span>Warehouse to pick from</span><select value={warehouse} onChange={(e) => { setWarehouse(e.target.value); setPackerId(''); onWarehouseChange(e.target.value); }}>{warehouses.map((location) => <option key={location.code} value={location.code}>{location.code} · {location.name}</option>)}</select></label><label className="field"><span>Packer ID</span><select required value={packerId} disabled={loading || !packers.length} onChange={(e) => setPackerId(e.target.value)}><option value="">{loading ? 'Loading packers…' : 'Select a packer'}</option>{packers.map((packer) => <option key={packer.id} value={packer.id}>{packer.name} · {packer.id}</option>)}</select></label><label className="field"><span>Phone</span><input value={customer.phone} onChange={(e) => setCustomer({ ...customer, phone: e.target.value })} placeholder="Optional" /></label><label className="field"><span>Email</span><input type="email" value={customer.email} onChange={(e) => setCustomer({ ...customer, email: e.target.value })} placeholder="Optional" /></label><label className="field form-span"><span>Billing / delivery address</span><input value={customer.address} onChange={(e) => setCustomer({ ...customer, address: e.target.value })} placeholder="Optional for counter sale" /></label><label className="field"><span>GSTIN</span><input value={customer.gstin} onChange={(e) => setCustomer({ ...customer, gstin: e.target.value.toUpperCase() })} placeholder="Optional" /></label><label className="field"><span>Discount (₹)</span><input type="number" min="0" value={discountAmount} onChange={(e) => setDiscountAmount(e.target.value)} /></label><label className="field"><span>Shipping (₹)</span><input type="number" min="0" value={shippingAmount} onChange={(e) => setShippingAmount(e.target.value)} /></label><label className="field"><span>Payment method</span><select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)}><option value="cash">Cash</option><option value="card">Card</option><option value="upi">UPI</option><option value="bank_transfer">Bank transfer</option><option value="credit">Credit / pay later</option></select></label><label className="field"><span>Amount paid (₹) <small>Leave blank for full payment</small></span><input type="number" min="0" value={amountPaid} onChange={(e) => setAmountPaid(e.target.value)} placeholder={paymentMethod === 'credit' ? '0 for unpaid' : fmt(total)} /></label></div>{!packers.length && !loading && <p className="form-error">No approved packers are assigned to {warehouse}. An admin must approve a packer for this warehouse before the sale can be created.</p>}<div className="location-editor-head"><div><h3>Sale items</h3><p>Available stock is reserved for the selected packer. GST is calculated at 18%.</p></div><button type="button" className="text-button" onClick={() => setItems((old) => [...old, { sku: '', quantity: 1, unitPrice: 0, priceIncludesGst: false }])}><Plus size={15} /> Add item</button></div><div className="sale-lines">{items.map((item, index) => <div className="sale-line" key={index}><select aria-label="Product SKU" required value={item.sku} onChange={(e) => chooseProduct(index, e.target.value)}><option value="">Choose product</option>{products.map((product) => <option key={product.sku} value={product.sku}>{product.sku} · {product.name} ({availableFor(product, warehouse)} available)</option>)}</select><input aria-label={`Quantity (${products.find((product) => product.sku === item.sku)?.unit || 'PCS'})`} type="number" min="1" value={item.quantity} onChange={(e) => changeItem(index, 'quantity', e.target.value)} /><input aria-label="Unit price" type="number" min="0" step="0.01" value={item.unitPrice} onChange={(e) => changeItem(index, 'unitPrice', e.target.value)} /><small className="sale-line-gst">{item.priceIncludesGst ? 'GST included' : 'Plus 18% GST'}</small><button type="button" className="icon-button" disabled={items.length === 1} onClick={() => setItems((old) => old.filter((_, position) => position !== index))} aria-label="Remove item"><Trash2 size={15} /></button></div>)}</div><div className="sale-totals"><span>Taxable subtotal</span><strong>{fmt(subtotal)}</strong><span>Discount</span><strong>−{fmt(discountAmount)}</strong><span>Shipping</span><strong>{fmt(shippingAmount)}</strong><span>GST (18%)</span><strong>{fmt(taxAmount)}</strong><b>Total</b><b>{fmt(total)}</b></div>{error && <div className="form-error">{error}</div>}<footer className="modal-actions"><button type="button" className="button button-quiet" onClick={onClose}>Cancel</button><button className="button button-primary" disabled={saving || loading || !packers.length || !packerId}>{saving ? 'Creating…' : 'Create order'} <ArrowRight size={15} /></button></footer></form></Modal>;
}

function InvoiceModal({ order, onClose }) {
  return <Modal title="Sales invoice" onClose={onClose} wide><div className="invoice-sheet"><header className="invoice-head"><div><div className="invoice-brand"><Box size={19} /> Saraswati Inventory System</div><span>Sales invoice</span></div><div className="invoice-number"><strong>{order.invoiceNumber}</strong><span>Order {order.orderNumber}</span><span>{new Date(order.createdAt).toLocaleDateString('en-IN')}</span></div></header><div className="invoice-parties"><div><small>BILL TO</small><strong>{order.customer.name}</strong>{order.customer.address && <span>{order.customer.address}</span>}{order.customer.phone && <span>{order.customer.phone}</span>}{order.customer.gstin && <span>GSTIN: {order.customer.gstin}</span>}</div><div><small>FULFILLED FROM</small><strong>{warehouses.find((location) => location.code === order.warehouse)?.name || order.warehouse}</strong><span>Order status: {STATUS_LABELS[order.status]}</span><span>Payment: {order.paymentStatus || 'unpaid'} via {order.paymentMethod?.replaceAll('_', ' ') || 'cash'}</span></div></div><table className="invoice-lines"><thead><tr><th>Part / SKU</th><th>Qty</th><th>Unit price</th><th>Line total</th></tr></thead><tbody>{order.items.map((item) => <tr key={item.sku}><td><strong>{item.name}</strong><small>{item.brand} | {item.sku} | {item.gstRate === 18 ? (item.gstIncluded ? 'GST included' : 'GST added at 18%') : 'GST details unavailable'}</small></td><td>{item.quantity} {item.unit || 'PCS'}</td><td>{fmt(item.unitPrice)}</td><td>{fmt(item.lineTotal)}</td></tr>)}</tbody></table><div className="invoice-total"><span>Subtotal</span><b>{fmt(order.subtotal)}</b>{order.discountAmount > 0 && <><span>Discount</span><b>−{fmt(order.discountAmount)}</b></>}{order.shippingAmount > 0 && <><span>Shipping</span><b>{fmt(order.shippingAmount)}</b></>}<span>Tax ({order.taxRate || 0}%)</span><b>{fmt(order.taxAmount)}</b><strong>Invoice total</strong><strong>{fmt(order.total)}</strong><span>Amount paid</span><b>{fmt(order.amountPaid || 0)}</b><strong>Balance due</strong><strong>{fmt(order.balanceDue || 0)}</strong></div><div className="invoice-note">Thank you for your purchase. Keep this invoice for your records.</div></div><footer className="modal-actions invoice-actions"><span className="helper-text">Print or save this invoice as PDF.</span><button className="button button-quiet" onClick={onClose}>Close</button><button className="button button-primary" onClick={() => window.print()}><Printer size={15} /> Print invoice</button></footer></Modal>;
}

function SalesHistoryPage({ orders, onInvoice, report }) {
  const [data, setData] = useState({ items: [], page: 1, pages: 1, count: 0, summary: {} });
  const [page, setPage] = useState(1); const [query, setQuery] = useState(''); const [loading, setLoading] = useState(true); const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      setLoading(true); setError('');
      api(`/sales/history?page=${page}&q=${encodeURIComponent(query.trim())}`).then((result) => { if (active) setData(result); }).catch((failure) => { if (active) setError(failure.message || 'Could not load sales history.'); }).finally(() => { if (active) setLoading(false); });
    }, query ? 250 : 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [page, query]);
  const legacyOrders = orders.filter((order) => !order.createdById && !data.items.some((event) => event.orderNumber === order.orderNumber));
  const summary = data.summary || {};
  return <><section className="page-heading"><div><h1>Sales history</h1><p>Every sold part with its customer, selling price, seller, and warehouse. Records are retained for {data.retentionDays || 210} days.</p></div></section>
    <div className="order-summary"><div><span>Sales orders</span><strong>{summary.orderCount || 0}</strong></div><div><span>Sales total</span><strong>{fmt(summary.salesTotal || 0)}</strong></div><div><span>Units sold</span><strong>{summary.unitsSold || 0}</strong></div><div><span>Best seller</span><strong className="best-seller-value">{report?.bestSellers?.[0]?.sku || '—'}</strong></div></div>
    <section className="audit-panel sales-history-panel"><header><div><h2>Product sales</h2><p>{data.count || 0} matching sale order{data.count === 1 ? '' : 's'} in the retention period</p></div><label className="sales-history-search"><Search size={16} /><input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="Search customer, order, part or seller" /></label></header>
      {error && <p className="form-error audit-error">{error}</p>}
      <div className="audit-table-wrap"><table className="audit-table"><thead><tr><th>Sold at</th><th>Order / party</th><th>Product</th><th>Qty</th><th>Unit price</th><th>Line total</th><th>Sold by</th><th>Warehouse</th><th>Total</th></tr></thead><tbody>{data.items.flatMap((event) => event.items.map((item, index) => <tr key={`${event.eventKey || event._id}-${item.sku}-${index}`}><td>{dateTime(event.occurredAt)}</td><td><strong>{event.orderNumber}</strong><small>{event.customerName || 'Walk-in customer'}</small></td><td><strong>{item.name}</strong><small>{item.sku} | {item.gstRate === 18 ? (item.gstIncluded ? 'GST included' : 'GST added at 18%') : 'GST details unavailable'}</small></td><td>{item.quantity} {item.unit || 'PCS'}</td><td>{fmt(item.unitPrice)}</td><td>{fmt(item.lineTotal)}</td><td>{event.actorName}<small>{event.actorRole}</small></td><td>{event.warehouse}</td><td><strong>{fmt(event.total)}</strong></td></tr>))}{!data.items.length && <tr><td colSpan="9">{loading ? 'Loading sales history…' : query ? 'No sales match this search.' : 'No sales have been recorded yet.'}</td></tr>}</tbody></table></div>
      <footer className="audit-pagination"><span>Page {data.page || page} of {data.pages || 1} · 100 orders per page</span><div><button className="button button-quiet button-small" disabled={page <= 1 || loading} onClick={() => setPage((value) => Math.max(1, value - 1))}>Previous</button><button className="button button-quiet button-small" disabled={page >= (data.pages || 1) || loading} onClick={() => setPage((value) => value + 1)}>Next</button></div></footer>
    </section>
    {legacyOrders.length > 0 && <section className="audit-panel"><header><div><h2>Earlier orders</h2><p>Orders from before structured sales history was enabled.</p></div><strong>{legacyOrders.length}</strong></header><div className="audit-table-wrap"><table className="audit-table"><thead><tr><th>Order date</th><th>Order / party</th><th>Products</th><th>Order total</th><th>Warehouse</th><th>Status</th><th>Invoice</th></tr></thead><tbody>{legacyOrders.map((order) => <tr key={order.id}><td>{dateTime(order.createdAt)}</td><td><strong>{order.orderNumber}</strong><small>{order.customer?.name || 'Walk-in customer'}</small></td><td>{order.items.map((item) => `${item.name} (${item.quantity})`).join(', ')}</td><td>{fmt(order.total)}</td><td>{order.warehouse}</td><td>{STATUS_LABELS[order.status] || order.status}</td><td><button className="text-button" onClick={() => onInvoice(order)}>View invoice</button></td></tr>)}</tbody></table></div></section>}
  </>;
}

function ReportsPage({ report, onRefresh }) {
  const maxUnits = Math.max(1, ...(report?.bestSellers || []).map((item) => item.units));
  return <><section className="page-heading"><div><h1>Sales reports</h1><p>Revenue and top moving car parts from the last 30 days.</p></div><button className="button button-quiet" onClick={onRefresh}><Activity size={15} /> Refresh report</button></section><div className="order-summary report-summary"><div><span>Sales revenue</span><strong>{fmt(report?.revenue || 0)}</strong></div><div><span>Fulfilled orders</span><strong>{report?.orderCount || 0}</strong></div><div><span>Units sold</span><strong>{report?.itemsSold || 0}</strong></div><div><span>Top SKU</span><strong className="best-seller-value">{report?.bestSellers?.[0]?.sku || '—'}</strong></div></div><section className="report-section"><div className="section-title"><div><h2>Best products in sales</h2><p>Ranked by units sold in fulfilled orders.</p></div></div>{report?.bestSellers?.length ? <div className="seller-list">{report.bestSellers.map((item, index) => <div className="seller-row" key={item.sku}><span className="seller-rank">{String(index + 1).padStart(2, '0')}</span><div className="seller-main"><strong>{item.name}</strong><small>{item.sku}</small><div className="seller-track"><i style={{ width: `${item.units / maxUnits * 100}%` }} /></div></div><div className="seller-units"><strong>{item.units}</strong><small>units</small></div><div className="seller-revenue">{fmt(item.revenue)}</div></div>)}</div> : <div className="empty-state"><BarChart3 size={22} /><strong>No sales data yet</strong><span>Reports populate after orders are packed and fulfilled.</span></div>}</section></>;
}

function ImportExportPage({ canManage, busy, error, onImport, onExport }) {
  const fileRef = useRef(null); const selectedWarehouse = useRef('KG'); const [updateMatchingOnly, setUpdateMatchingOnly] = useState(false);
  const warehouseList = [{ code: 'KG', name: 'Kashmiri Gate' }, { code: 'SPB', name: 'Samaypur Badli' }, { code: 'BG', name: 'Bangalore' }, { code: 'PB', name: 'Palika Bazaar' }];
  const [exportFilters, setExportFilters] = useState(() => Object.fromEntries(warehouseList.map(({ code }) => [code, { type: 'category', value: '' }])));
  const updateExportFilter = (code, key, value) => setExportFilters((current) => ({ ...current, [code]: { ...current[code], [key]: value } }));
  return <><section className="page-heading"><div><h1>Warehouse data</h1><p>Import and export each warehouse independently. Stock changes stay scoped to the selected location.</p></div></section>
    <input ref={fileRef} type="file" accept=".csv,text/csv" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) onImport(file, selectedWarehouse.current, updateMatchingOnly); event.target.value = ''; }} />
    <section className="import-mode-panel"><div><strong>When a SKU already exists</strong><span>Choose whether this import may add new catalog items.</span></div><label><input type="checkbox" checked={updateMatchingOnly} onChange={(event) => setUpdateMatchingOnly(event.target.checked)} disabled={busy} /><span><b>Update matching SKUs only</b><small>Update product fields present in the CSV and this warehouse’s stock. Skip SKUs that are not in inventory.</small></span></label></section>
    <div className="warehouse-import-grid">{warehouseList.map(({ code, name }) => <article className="warehouse-import-card" key={code}>
      <div className="warehouse-import-head"><span className="warehouse-import-code">{code}</span><div><h2>{name}</h2><p>Warehouse stock file</p></div></div>
      <div className="warehouse-import-detail"><strong>{updateMatchingOnly ? 'Update matching only' : 'Add new and update matching'}</strong><span>{updateMatchingOnly ? `Updates matching SKUs and skips unknown ones. Only ${code} stock locations are changed.` : `Adds new SKUs and updates matching ${code} stock locations.`} Other warehouse stock and user accounts stay unchanged.</span></div>
      <div className="warehouse-import-actions"><button className="button button-primary" disabled={!canManage || busy} onClick={() => { selectedWarehouse.current = code; fileRef.current?.click(); }}><FileUp size={15} /> Import {code} file</button><button className="button button-quiet" disabled={!canManage || busy} onClick={() => onExport(code)}><FileDown size={15} /> Export all {code}</button></div>
      <div className="warehouse-filter-export"><label><span>Filtered export</span><select value={exportFilters[code].type} disabled={!canManage || busy} onChange={(event) => updateExportFilter(code, 'type', event.target.value)}><option value="category">By category</option><option value="brand">By brand</option><option value="oe">By OE number</option></select></label><input aria-label={`${code} export filter value`} value={exportFilters[code].value} disabled={!canManage || busy} onChange={(event) => updateExportFilter(code, 'value', event.target.value)} placeholder={`Exact ${exportFilters[code].type === 'oe' ? 'OE number' : exportFilters[code].type}`} /><button className="button button-quiet" disabled={!canManage || busy || !exportFilters[code].value.trim()} onClick={() => onExport(code, exportFilters[code].type, exportFilters[code].value)}><FileDown size={14} /> Export filtered</button></div>
    </article>)}</div>
    <div className="warehouse-import-note"><Shield size={16} /><p>Full and filtered exports download as CSV, one row per SKU and rack. Category, brand, and OE filters match exact values and only include stock from the selected warehouse. Large exports stream from the server without loading the full stock file into the app.</p></div>
    {error && <div className={`import-result ${busy ? 'import-progress' : ''}`} role="status">{!busy && <Check size={16} />}{error}</div>}{!canManage && <p className="permission-note"><Shield size={15} /> Only Admins and Store Managers can import or export warehouse stock.</p>}</>;
}
function WooCommercePage({ status, busy, canImportCatalog, onRefresh, onAction, onImportOrders }) {
  const configured = status?.configured; const connected = status?.connected;
  const [storeProducts, setStoreProducts] = useState([]); const [managerLoaded, setManagerLoaded] = useState(false);
  const [managerPage, setManagerPage] = useState(1); const [managerSearch, setManagerSearch] = useState(''); const [managerHasMore, setManagerHasMore] = useState(false);
  const [managerLoading, setManagerLoading] = useState(false); const [managerError, setManagerError] = useState('');
  useEffect(() => {
    if (!managerLoaded || !connected) return undefined;
    let active = true; setManagerLoading(true); setManagerError('');
    const timer = window.setTimeout(() => {
      api(`/integrations/woocommerce/products?page=${managerPage}&search=${encodeURIComponent(managerSearch.trim())}`)
        .then((result) => { if (active) { setStoreProducts(result.items); setManagerHasMore(result.hasMore); } })
        .catch((failure) => { if (active) setManagerError(failure.message); })
        .finally(() => { if (active) setManagerLoading(false); });
    }, managerSearch ? 250 : 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [managerLoaded, connected, managerPage, managerSearch]);
  return <><section className="page-heading"><div><h1>WooCommerce</h1><p>Read your store catalog and send website orders to the warehouse packing queue.</p></div><button className="button button-quiet" onClick={onRefresh}><Activity size={15} /> Test connection</button></section>
    <section className="woo-connect-panel"><div className="woo-connection-mark"><PlugZap size={23} /></div><div className="woo-connection-copy"><h2>{connected ? 'WooCommerce connected' : configured ? 'Connection could not be verified' : 'Connect a WooCommerce store'}</h2><p>{configured ? status.storeUrl : 'Add your store URL and read-only REST API keys to the server environment. Credentials stay on the server.'}</p><span className={`connection-state ${connected ? 'connected' : 'not-connected'}`}><i /> {connected ? status.message || 'Connected and ready' : status?.connectionError || 'Not connected'}</span></div></section>
    <div className="woo-actions woo-read-actions">{canImportCatalog && <article><h3>Import catalog</h3><p>Read product names, SKUs, brands, OE numbers and prices into Saraswati Inventory System.</p><button className="button button-primary" disabled={!connected || busy} onClick={() => onAction('products/pull')}>{busy ? 'Syncing...' : 'Pull products from store'}</button></article>}<article><h3>Orders received from website</h3><p>Send processing website orders to a packer at the warehouse that will fulfil them.</p><button className="button button-quiet" disabled={!connected || busy} onClick={onImportOrders}>{busy ? 'Syncing...' : 'Import website orders'}</button></article></div>
    <section className="woo-product-manager"><header><div><h2>Store catalog</h2><p>Read-only product details, images, pricing, inventory status and available Year / Make / Model fitment data.</p></div><button className="button button-quiet" disabled={!connected || managerLoading} onClick={() => { setManagerLoaded(true); setManagerPage(1); }}><Activity size={14} /> {managerLoaded ? 'Refresh products' : 'View products'}</button></header>
      {managerLoaded && <><label className="woo-product-search"><Search size={15} /><input value={managerSearch} onChange={(event) => { setManagerSearch(event.target.value); setManagerPage(1); }} placeholder="Search store products by name or SKU" /></label>
        {managerError && <p className="form-error woo-manager-error">{managerError}</p>}
        <div className="woo-product-table-wrap"><table className="woo-product-table"><thead><tr><th>Image</th><th>Product / SKU</th><th>YMM / fitment</th><th>Price</th><th>Status</th><th>Stock</th><th>Store page</th></tr></thead><tbody>{storeProducts.map((product) => <tr key={product.id}><td><div className="woo-product-image">{product.image?.src ? <img src={product.image.src} alt={product.image.alt || product.name} loading="lazy" /> : <Box size={18} aria-label="No product image" />}</div></td><td><strong>{product.name}</strong><small>{product.sku || 'No SKU'} · ID {product.id}</small></td><td>{product.ymmDetails?.length ? <div className="woo-ymm-lines">{product.ymmDetails.map((detail, index) => <span key={`${detail}-${index}`}>{detail}</span>)}</div> : <span className="woo-no-ymm">No YMM data in WooCommerce</span>}</td><td>{fmt(product.regularPrice)}{product.salePrice > 0 && <small>Sale {fmt(product.salePrice)}</small>}</td><td><span className={`order-status ${product.status === 'publish' ? 'status-completed' : ''}`}>{product.status}</span></td><td>{product.manageStock ? `${product.stockQuantity ?? 0} units` : product.stockStatus}</td><td>{product.permalink && <a className="text-button woo-view-link" href={product.permalink} target="_blank" rel="noreferrer">View <ArrowRight size={13} /></a>}</td></tr>)}{!storeProducts.length && <tr><td colSpan="7">{managerLoading ? 'Loading WooCommerce products…' : 'No products found.'}</td></tr>}</tbody></table></div>
        <footer className="audit-pagination"><span>Page {managerPage} · 25 products per request</span><div><button className="button button-quiet button-small" disabled={managerPage <= 1 || managerLoading} onClick={() => setManagerPage((page) => Math.max(1, page - 1))}>Previous</button><button className="button button-quiet button-small" disabled={!managerHasMore || managerLoading} onClick={() => setManagerPage((page) => page + 1)}>Next</button></div></footer>
      </>}
    </section>
    <div className="integration-note"><Shield size={16} /><p>WooCommerce stays read-only. Processing website orders are copied into the Website Orders queue so you can choose the fulfilment warehouse and packer.</p></div>
  </>;
}

function WebsiteOrdersPage({ orders, busy, connected, onImport, onAssign }) {
  const pending = orders.filter((order) => order.status === 'ready_to_pack' && !order.assignedTo);
  const lines = pending.reduce((total, order) => total + order.items.reduce((sum, item) => sum + item.quantity, 0), 0);
  const value = pending.reduce((total, order) => total + order.total, 0);
  return <>
    <section className="page-heading"><div><h1>Website Orders</h1><p>Review orders received from WooCommerce, choose a fulfilment warehouse, then assign a local packer.</p></div><button className="button button-primary" disabled={busy || !connected} onClick={onImport}><Activity size={15} /> {busy ? 'Importing...' : 'Import website orders'}</button></section>
    <div className="summary-strip website-order-summary"><div><span>Waiting for assignment</span><strong>{pending.length}</strong></div><div><span>Items to pack</span><strong>{lines}</strong></div><div><span>Order value</span><strong>{fmt(value)}</strong></div><div><span>All website orders</span><strong>{orders.length}</strong></div></div>
    <section className="website-orders-panel"><header><div><h2>Website order queue</h2><p>Only WooCommerce orders with Processing status are imported. Importing reads the store and does not update it.</p></div><span className="website-pending-count">{pending.length} to assign</span></header>
      <div className="website-orders-table-wrap"><table className="website-orders-table"><thead><tr><th>Order</th><th>Customer</th><th>Products</th><th>Total</th><th>Received</th><th>Warehouse</th><th>Packer</th><th>Action / status</th></tr></thead><tbody>{orders.map((order) => <WebsiteOrderRow key={order.id} order={order} busy={busy} onAssign={onAssign} />)}{!orders.length && <tr><td colSpan="8"><div className="empty-state"><ClipboardList size={24} /><strong>No website orders in the queue</strong><span>Import Processing orders from WooCommerce. They will appear here for warehouse and packer assignment.</span><button className="button button-primary" disabled={busy || !connected} onClick={onImport}>Import website orders</button></div></td></tr>}</tbody></table></div>
    </section>
    <div className="integration-note"><Shield size={16} /><p>Items are sent to the packer even when their SKU is not in inventory. Matching stock is reserved when the packer accepts the order; unavailable or unmatched items are flagged.</p></div>
  </>;
}

function CarCheckPage({ connected }) {
  const [makes, setMakes] = useState([]); const [models, setModels] = useState([]); const [years, setYears] = useState([]);
  const [make, setMake] = useState(''); const [model, setModel] = useState(''); const [year, setYear] = useState('');
  const [results, setResults] = useState([]); const [total, setTotal] = useState(0); const [page, setPage] = useState(1);
  const [loadingOptions, setLoadingOptions] = useState(false); const [loadingResults, setLoadingResults] = useState(false);
  const [error, setError] = useState(''); const [searched, setSearched] = useState(false);
  useEffect(() => {
    if (!connected) return undefined;
    let active = true; setLoadingOptions(true); setError('');
    api('/integrations/woocommerce/fitments/options')
      .then((data) => { if (active) setMakes(data.makes || []); })
      .catch((failure) => { if (active) setError(failure.message); })
      .finally(() => { if (active) setLoadingOptions(false); });
    return () => { active = false; };
  }, [connected]);
  useEffect(() => {
    if (!connected || !make) { setModels([]); return undefined; }
    let active = true;
    api(`/integrations/woocommerce/fitments/options?make=${encodeURIComponent(make)}`)
      .then((data) => { if (active) setModels(data.models || []); })
      .catch((failure) => { if (active) setError(failure.message); });
    return () => { active = false; };
  }, [connected, make]);
  useEffect(() => {
    if (!connected || !make || !model) { setYears([]); return undefined; }
    let active = true;
    api(`/integrations/woocommerce/fitments/options?make=${encodeURIComponent(make)}&model=${encodeURIComponent(model)}`)
      .then((data) => { if (active) setYears(data.years || []); })
      .catch((failure) => { if (active) setError(failure.message); });
    return () => { active = false; };
  }, [connected, make, model]);
  useEffect(() => {
    if (!connected || !searched || !make || !model || !year) return undefined;
    let active = true; setLoadingResults(true); setError('');
    api(`/integrations/woocommerce/fitments/products?make=${encodeURIComponent(make)}&model=${encodeURIComponent(model)}&year=${encodeURIComponent(year)}&page=${page}`)
      .then((data) => { if (active) { setResults(data.items || []); setTotal(data.total || 0); } })
      .catch((failure) => { if (active) { setError(failure.message); setResults([]); setTotal(0); } })
      .finally(() => { if (active) setLoadingResults(false); });
    return () => { active = false; };
  }, [connected, searched, make, model, year, page]);
  const reset = () => { setMake(''); setModel(''); setYear(''); setModels([]); setYears([]); setResults([]); setTotal(0); setPage(1); setSearched(false); setError(''); };
  const findParts = (event) => { event.preventDefault(); setPage(1); setSearched(true); };
  return <>
    <section className="page-heading"><div><h1>Car Check</h1><p>Find WooCommerce spare parts that fit a specific make, model, and year.</p></div><span className={`connection-state ${connected ? 'connected' : 'not-connected'}`}><i /> {connected ? 'Store data connected' : 'Connecting to store...'}</span></section>
    <form className="car-check-panel" onSubmit={findParts}>
      <div className="car-check-title"><span><CarFront size={22} /></span><div><small>VEHICLE FITMENT</small><h2>Find parts for your vehicle</h2><p>Select a vehicle to see compatible parts from your store.</p></div></div>
      <div className="car-check-fields">
        <label className="field"><span>Make</span><select required value={make} disabled={!connected || loadingOptions} onChange={(event) => { setMake(event.target.value); setModel(''); setYear(''); setSearched(false); setResults([]); }}><option value="">{loadingOptions ? 'Loading makes...' : 'Select make'}</option>{makes.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
        <label className="field"><span>Model</span><select required value={model} disabled={!make} onChange={(event) => { setModel(event.target.value); setYear(''); setSearched(false); setResults([]); }}><option value="">Select model</option>{models.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
        <label className="field"><span>Year</span><select required value={year} disabled={!model} onChange={(event) => { setYear(event.target.value); setSearched(false); setResults([]); }}><option value="">Select year</option>{years.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
        <button className="button button-primary car-check-submit" type="submit" disabled={!connected || !make || !model || !year || loadingResults}>{loadingResults ? 'Searching...' : 'Find compatible parts'} <Search size={15} /></button>
      </div>
      <div className="car-check-foot"><button type="button" className="text-button" onClick={reset}>Reset vehicle</button>{searched && <span>{loadingResults ? 'Searching fitment data...' : `${total.toLocaleString('en-IN')} compatible products found`}</span>}</div>
      {error && <div className="form-error car-check-error">{error}</div>}
      {!connected && <div className="integration-note car-check-error"><Shield size={16} /><p>Connect WooCommerce to load vehicle fitment and store product information.</p></div>}
    </form>
    {searched && <section className="car-check-results" aria-live="polite">{loadingResults ? <div className="empty-state"><Activity size={22} /><strong>Finding compatible parts</strong><span>Checking the store fitment list.</span></div> : results.length ? <><header><div><h2>{make} {model} · {year}</h2><p>{total.toLocaleString('en-IN')} compatible parts</p></div><span>Page {page} of {Math.max(1, Math.ceil(total / 24))}</span></header><div className="car-part-grid">{results.map((product) => <article className="car-part-card" key={product.id}><div className="car-part-image">{product.image?.src ? <img src={product.image.src} alt={product.image.alt || product.name} loading="lazy" /> : <Box size={30} />}</div><div className={`car-part-stock ${product.stockStatus === 'instock' ? 'in-stock' : 'out-stock'}`}>{product.stockStatus === 'instock' ? product.manageStock && product.stockQuantity != null ? `In stock · ${product.stockQuantity}` : 'In stock' : 'Out of stock'}</div><h3>{product.name}</h3><small>{product.sku || `Product ${product.id}`}</small><strong className="car-part-price">{product.salePrice > 0 ? <><del>{fmt(product.regularPrice)}</del> {fmt(product.salePrice)}</> : fmt(product.regularPrice)}</strong>{product.permalink && <a className="button button-primary button-small" href={product.permalink} target="_blank" rel="noreferrer">View product <ArrowRight size={13} /></a>}</article>)}</div><footer className="car-check-pagination"><button className="button button-quiet button-small" disabled={page <= 1 || loadingResults} onClick={() => setPage((value) => value - 1)}>Previous</button><span>Page {page} · {total.toLocaleString('en-IN')} products</span><button className="button button-quiet button-small" disabled={page >= Math.ceil(total / 24) || loadingResults} onClick={() => setPage((value) => value + 1)}>Next</button></footer></> : <div className="empty-state"><CarFront size={24} /><strong>No compatible parts found</strong><span>No published WooCommerce products match {make} {model} {year}.</span></div>}</section>}
  </>;
}

function WebsiteOrderRow({ order, busy, onAssign }) {
  const [warehouse, setWarehouse] = useState(order.warehouse || 'KG');
  const [packers, setPackers] = useState([]);
  const [packerId, setPackerId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const canAssign = order.status === 'ready_to_pack' && !order.assignedTo;
  useEffect(() => {
    if (!canAssign) { setLoading(false); return undefined; }
    let active = true;
    setLoading(true); setError(''); setPackerId('');
    api(`/users/packers?warehouse=${encodeURIComponent(warehouse)}`)
      .then((result) => { if (active) { setPackers(result.items); setPackerId(result.items[0]?.id || ''); } })
      .catch((failure) => { if (active) { setPackers([]); setError(failure.message); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [warehouse, canAssign]);
  return <tr>
    <td><strong>{order.orderNumber}</strong><small>{order.invoiceNumber} · Website</small></td>
    <td><strong>{order.customer.name}</strong><small>{order.customer.phone || order.customer.email || 'Website customer'}</small></td>
    <td>{order.items.map((item, index) => <span className="website-order-item" key={`${item.sku}-${index}`}><strong>{item.name}</strong><small>{item.sku} × {item.quantity} {item.unit || 'PCS'}</small></span>)}</td>
    <td className="order-total">{fmt(order.total)}</td>
    <td>{new Date(order.createdAt).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
    <td>{canAssign ? <select className="website-assign-select" aria-label={`Fulfilment warehouse for ${order.orderNumber}`} value={warehouse} disabled={busy} onChange={(event) => setWarehouse(event.target.value)}>{warehouses.map((item) => <option value={item.code} key={item.code}>{item.code} - {item.name}</option>)}</select> : <><strong>{order.warehouse}</strong><small>Fulfilment warehouse</small></>}</td>
    <td>{canAssign ? <>{loading ? <span className="website-muted">Loading packers...</span> : <select className="website-assign-select" aria-label={`Packer for ${order.orderNumber}`} value={packerId} disabled={busy || !packers.length} onChange={(event) => setPackerId(event.target.value)}><option value="">Choose packer</option>{packers.map((packer) => <option value={packer.id} key={packer.id}>{packer.name} · {packer.id}</option>)}</select>}{error && <small className="form-error">{error}</small>}{!loading && !error && !packers.length && <small className="form-error">No approved packer at {warehouse}.</small>}</> : <strong>{order.assignedName || 'Unassigned'}</strong>}</td>
    <td>{canAssign ? <button className="button button-primary button-small" disabled={busy || loading || !packerId} onClick={() => onAssign(order.id, warehouse, packerId)}>Assign to packer <ArrowRight size={13} /></button> : <span className={`order-status status-${order.status}`}>{STATUS_LABELS[order.status] || order.status}</span>}</td>
  </tr>;
}

export default App;
