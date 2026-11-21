import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import mongoose from 'mongoose';
import { createClient } from 'redis';
import { rateLimit } from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import { SignJWT, jwtVerify } from 'jose';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { demoProducts, demoUsers } from '../src/data.js';
import { Product } from './models/Product.js';
import { User } from './models/User.js';
import { Order } from './models/Order.js';
import { Rack } from './models/Rack.js';
import { PackingPhoto } from './models/PackingPhoto.js';
import { PushSubscription } from './models/PushSubscription.js';
import { ActivityEvent } from './models/ActivityEvent.js';
import { UserSession } from './models/UserSession.js';

const app = express();
const webpush = createRequire(import.meta.url)('web-push');
const production = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT || process.env.API_PORT || 4000);
const host = process.env.API_HOST || (production ? '0.0.0.0' : '127.0.0.1');
const appDirectory = path.dirname(fileURLToPath(import.meta.url));
const cacheTtlSeconds = Number(process.env.SEARCH_CACHE_TTL_SECONDS || 15);
const sessionSecret = process.env.SESSION_SECRET || 'local-demo-session-secret-change-before-deploy';
const sessionKey = new TextEncoder().encode(sessionSecret);
const sessionCookie = 'stockroom_session';
let dataSource = 'demo';
let redisClient = null;
let demoProductStore = structuredClone(demoProducts).map((product) => ({ ...product, locations: product.locations.map((location) => ({ ...location, reserved: 0 })) }));
let demoUserStore = structuredClone(demoUsers);
let demoOrders = [];
let demoRackStore = [];
let demoPackingPhotos = [];
let demoPushSubscriptions = [];
let demoActivityEvents = [];
let demoUserSessions = [];
const photoRetentionMs = 7 * 24 * 60 * 60 * 1000;
const auditRetentionDays = 210;
const auditRetentionMs = auditRetentionDays * 24 * 60 * 60 * 1000;
const gstRate = 18;
const money = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
const sessionLostAfterMs = 5 * 60 * 1000;
const pushConfigured = Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
if (pushConfigured) webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@saraswati-inventory.local', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);

if (production && (!process.env.MONGODB_URI || !process.env.REDIS_URL || !process.env.SESSION_SECRET || !process.env.BOOTSTRAP_ADMIN_EMAIL || !process.env.BOOTSTRAP_ADMIN_PASSWORD || !pushConfigured)) {
  throw new Error('Production requires MongoDB, Redis, SESSION_SECRET, bootstrap admin credentials, and VAPID push keys.');
}
if (production && (Buffer.byteLength(sessionSecret) < 32 || process.env.BOOTSTRAP_ADMIN_PASSWORD.length < 12)) {
  throw new Error('Production requires a SESSION_SECRET of at least 32 bytes and a bootstrap admin password of at least 12 characters.');
}

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: { directives: { imgSrc: ["'self'", 'data:', 'https:'] } } }));
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.use('/api/', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false }));

const roleRank = { Packer: 1, 'Store Manager': 2, Admin: 3 };
const canManage = (user) => roleRank[user?.role] >= roleRank['Store Manager'];
const isAdmin = (user) => user?.role === 'Admin';
const cleanUser = (user) => ({ id: String(user._id || user.id), name: user.name, phone: user.phone || '', email: user.email, role: user.role, warehouse: user.warehouse || '', approved: user.approved !== false, active: user.active !== false });
const asDate = (value) => value ? new Date(value) : new Date();

function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function normalizeProduct(product) {
  const value = typeof product.toObject === 'function' ? product.toObject() : product;
  return {
    id: String(value._id || value.id), name: value.name, sku: value.sku, brand: value.brand,
    category: value.category || 'General', unit: value.unit || 'PCS', vehicleFitment: value.vehicleFitment || [],
    oe: Array.isArray(value.oe) ? value.oe : [], price: Number(value.price || 0), priceIncludesGst: Boolean(value.priceIncludesGst),
    cost: Number(value.cost || 0), reorderPoint: Number(value.reorderPoint || 0), barcode: value.barcode || '',
    locations: Array.isArray(value.locations) ? value.locations.map((location) => ({ warehouse: location.warehouse, rack: location.rack, qty: Number(location.qty || 0), reserved: Number(location.reserved || 0) })) : [],
    wooCommerceId: value.wooCommerceId || null, updatedAt: value.updatedAt ? new Date(value.updatedAt).toISOString() : '',
  };
}

function normalizeOrder(order) {
  const value = typeof order.toObject === 'function' ? order.toObject() : order;
  return { ...value, id: String(value._id || value.id), _id: undefined, createdAt: asDate(value.createdAt).toISOString(), updatedAt: asDate(value.updatedAt).toISOString() };
}

async function signSession(user, sessionId) {
  return new SignJWT({ name: user.name, email: user.email, role: user.role })
    .setProtectedHeader({ alg: 'HS256' }).setSubject(String(user._id || user.id)).setJti(sessionId).setIssuedAt().setExpirationTime('12h').sign(sessionKey);
}

function activityEvent(type, order, actor) {
  const value = typeof order.toObject === 'function' ? order.toObject() : order;
  const orderId = String(value._id || value.id);
  return {
    eventKey: `${type}:${orderId}`, type, actorId: actor.id, actorName: actor.name, actorRole: actor.role,
    warehouse: value.warehouse, orderId, orderNumber: value.orderNumber, customerName: value.customer?.name || '',
    source: value.source || 'manual', items: (value.items || []).map((item) => ({ sku: item.sku, name: item.name, unit: item.unit || 'PCS', quantity: item.quantity, unitPrice: item.unitPrice, lineTotal: item.lineTotal, gstIncluded: Boolean(item.gstIncluded), gstRate: item.gstRate, gstAmount: Number(item.gstAmount || 0) })),
    total: Number(value.total || 0), occurredAt: new Date(), expiresAt: new Date(Date.now() + auditRetentionMs),
  };
}

async function recordActivityEvent(type, order, actor, mongoSession) {
  const record = activityEvent(type, order, actor);
  if (dataSource === 'mongodb') {
    if (mongoSession) await ActivityEvent.create([record], { session: mongoSession });
    else await ActivityEvent.updateOne({ eventKey: record.eventKey }, { $setOnInsert: record }, { upsert: true });
    return;
  }
  if (!demoActivityEvents.some((event) => event.eventKey === record.eventKey)) demoActivityEvents.unshift({ ...record, id: `evt-${randomBytes(8).toString('hex')}` });
}

async function createUserSession(user, sessionId) {
  const now = new Date();
  const record = { sessionId, userId: user.id, userName: user.name, userEmail: user.email, userRole: user.role, warehouse: user.warehouse || '', loginAt: now, lastSeenAt: now, endedAt: null, durationSeconds: 0, endReason: null, expiresAt: null };
  if (dataSource === 'mongodb') await UserSession.create(record);
  else demoUserSessions.unshift(record);
}

async function updateUserSessionHeartbeat(sessionId) {
  if (!sessionId) return false;
  const now = new Date();
  if (dataSource === 'mongodb') { const result = await UserSession.updateOne({ sessionId, endedAt: null }, { $set: { lastSeenAt: now } }); return result.modifiedCount > 0; }
  const session = demoUserSessions.find((item) => item.sessionId === sessionId && !item.endedAt);
  if (session) { session.lastSeenAt = now; return true; }
  return false;
}

async function endUserSession(sessionId, reason, endedAt = new Date()) {
  if (!sessionId) return;
  if (dataSource === 'mongodb') {
    const session = await UserSession.findOne({ sessionId, endedAt: null });
    if (!session) return;
    const closedAt = reason === 'connection_lost' ? new Date(session.lastSeenAt) : endedAt;
    session.endedAt = closedAt; session.durationSeconds = Math.max(0, Math.floor((closedAt.getTime() - session.loginAt.getTime()) / 1000));
    session.endReason = reason; session.expiresAt = new Date(endedAt.getTime() + auditRetentionMs); await session.save();
  } else {
    const session = demoUserSessions.find((item) => item.sessionId === sessionId && !item.endedAt);
    if (!session) return;
    const closedAt = reason === 'connection_lost' ? new Date(session.lastSeenAt) : endedAt;
    session.endedAt = closedAt; session.durationSeconds = Math.max(0, Math.floor((closedAt.getTime() - new Date(session.loginAt).getTime()) / 1000));
    session.endReason = reason; session.expiresAt = new Date(endedAt.getTime() + auditRetentionMs);
  }
}

async function sweepLostSessions() {
  const now = new Date(); const cutoff = new Date(now.getTime() - sessionLostAfterMs);
  if (dataSource === 'mongodb') {
    const stale = await UserSession.find({ endedAt: null, lastSeenAt: { $lt: cutoff } }).limit(500).lean();
    if (stale.length) await UserSession.bulkWrite(stale.map((session) => ({ updateOne: { filter: { sessionId: session.sessionId, endedAt: null }, update: { $set: { endedAt: session.lastSeenAt, durationSeconds: Math.max(0, Math.floor((session.lastSeenAt.getTime() - session.loginAt.getTime()) / 1000)), endReason: 'connection_lost', expiresAt: new Date(now.getTime() + auditRetentionMs) } } } })));
  } else {
    for (const session of demoUserSessions) if (!session.endedAt && new Date(session.lastSeenAt) < cutoff) await endUserSession(session.sessionId, 'connection_lost', now);
    demoActivityEvents = demoActivityEvents.filter((event) => new Date(event.expiresAt) > now);
    demoUserSessions = demoUserSessions.filter((session) => !session.expiresAt || new Date(session.expiresAt) > now);
  }
}

async function requireAuth(request, response, next) {
  try {
    const token = request.cookies[sessionCookie];
    if (!token) return response.status(401).json({ error: 'Sign in required.' });
    const { payload } = await jwtVerify(token, sessionKey);
    request.sessionId = payload.jti || '';
    if (dataSource === 'mongodb') {
      const user = await User.findById(payload.sub).select('name phone email role warehouse approved active').lean();
      if (!user?.active || user.approved === false) return response.status(401).json({ error: 'Account is inactive or awaiting approval.' });
      request.user = cleanUser(user);
    } else {
      const user = demoUserStore.find((item) => item.id === payload.sub);
      if (!user || user.approved === false || user.active === false) return response.status(401).json({ error: 'Account is inactive or awaiting approval.' });
      request.user = cleanUser(user);
    }
    return next();
  } catch {
    return response.status(401).json({ error: 'Your session expired. Sign in again.' });
  }
}

function requireManager(request, response, next) {
  if (!canManage(request.user)) return response.status(403).json({ error: 'Store manager access required.' });
  return next();
}

function requireAdmin(request, response, next) {
  if (!isAdmin(request.user)) return response.status(403).json({ error: 'Admin access required.' });
  return next();
}

async function getAllProducts() {
  return dataSource === 'mongodb' ? (await Product.find({ active: { $ne: false } }).sort({ sku: 1 }).lean()).map(normalizeProduct) : demoProductStore;
}

async function findProductBySku(sku, session) {
  const normalized = String(sku).trim().toUpperCase();
  if (dataSource === 'mongodb') {
    const query = Product.findOne({ sku: normalized });
    if (session) query.session(session);
    return query;
  }
  return demoProductStore.find((product) => product.sku === normalized);
}

async function invalidateSearchCache() {
  if (!redisClient?.isReady) return;
  try {
    const keys = [];
    for await (const key of redisClient.scanIterator({ MATCH: 'stockroom:search:v1:*', COUNT: 100 })) keys.push(key);
    if (keys.length) await redisClient.del(keys);
  } catch (error) { console.warn('Search cache invalidation failed:', error.message); }
}

function photoMetadata(photo) {
  const id = String(photo._id || photo.id);
  return { id, orderId: photo.orderId, productId: photo.productId, sku: photo.sku, productName: photo.productName, warehouse: photo.warehouse, packerId: photo.packerId, packerName: photo.packerName, keep: Boolean(photo.keep), expiresAt: photo.expiresAt ? new Date(photo.expiresAt).toISOString() : null, createdAt: photo.createdAt ? new Date(photo.createdAt).toISOString() : new Date().toISOString(), imageUrl: `/api/packing-photos/${encodeURIComponent(id)}/image` };
}

async function findAccessibleOrder(orderId, user) {
  const order = dataSource === 'mongodb' ? await Order.findById(orderId).lean() : demoOrders.find((item) => item.id === orderId);
  if (!order) return null;
  if (!canManage(user) && (String(order.assignedTo) !== user.id || order.warehouse !== user.warehouse)) return null;
  return order;
}

async function getActivePhotos(filter = {}) {
  const now = new Date();
  if (dataSource === 'mongodb') return PackingPhoto.find({ ...filter, $or: [{ keep: true }, { expiresAt: { $gt: now } }] }).select('-image').sort({ createdAt: -1 }).lean();
  demoPackingPhotos = demoPackingPhotos.filter((photo) => photo.keep || new Date(photo.expiresAt) > now);
  return demoPackingPhotos.filter((photo) => Object.entries(filter).every(([key, value]) => String(photo[key]) === String(value))).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

async function notifyPacker(user, order) {
  if (!pushConfigured) return;
  const subscriptions = dataSource === 'mongodb' ? await PushSubscription.find({ userId: user.id }).lean() : demoPushSubscriptions.filter((entry) => entry.userId === user.id);
  const payload = JSON.stringify({ title: 'New order to pack', body: `${order.orderNumber} · ${order.items.length} item${order.items.length === 1 ? '' : 's'} at ${order.warehouse}`, url: '/?page=Packing', orderId: order.id });
  await Promise.all(subscriptions.map(async (subscription) => {
    try { await webpush.sendNotification({ endpoint: subscription.endpoint, keys: subscription.keys }, payload, { TTL: 60, urgency: 'high' }); }
    catch (error) {
      if (error.statusCode === 404 || error.statusCode === 410) {
        if (dataSource === 'mongodb') await PushSubscription.deleteOne({ _id: subscription._id });
        else demoPushSubscriptions = demoPushSubscriptions.filter((entry) => entry.endpoint !== subscription.endpoint);
      } else console.warn('Packing push notification failed:', error.message);
    }
  }));
}

async function readSearchCache(key) {
  if (!redisClient?.isReady) return null;
  try { const value = await redisClient.get(key); return value ? JSON.parse(value) : null; }
  catch (error) { console.warn('Search cache read failed:', error.message); return null; }
}

async function writeSearchCache(key, value) {
  if (!redisClient?.isReady) return;
  try { await redisClient.set(key, JSON.stringify(value), { EX: cacheTtlSeconds }); }
  catch (error) { console.warn('Search cache write failed:', error.message); }
}

function validateProduct(input) {
  const sku = String(input.sku || '').trim().toUpperCase();
  const name = String(input.name || '').trim();
  const brand = String(input.brand || '').trim();
  if (!sku || !name || !brand) throw Object.assign(new Error('Name, SKU and brand are required.'), { status: 400 });
  const locations = (input.locations || []).map((location) => {
    const rawRack = String(location.rack || '').trim();
    const rack = /^G-\d+[A-E]$/i.test(rawRack) ? rawRack.toUpperCase() : rawRack;
    return {
      warehouse: String(location.warehouse || '').toUpperCase(), rack,
      qty: Number(location.qty ?? 0), reserved: 0,
    };
  });
  for (const location of locations) {
    if (location.warehouse && !['KG', 'SPB', 'BG', 'PB'].includes(location.warehouse)) throw Object.assign(new Error('Unknown warehouse code.'), { status: 400 });
    if (location.rack.length > 120 || /[\u0000-\u001F\u007F<>]/.test(location.rack)) throw Object.assign(new Error(`Invalid location label: ${location.rack || '(blank)'}`), { status: 400 });
    if (!Number.isFinite(location.qty)) throw Object.assign(new Error('Stock quantities are invalid.'), { status: 400 });
  }
  const fitments = Array.isArray(input.vehicleFitment) ? input.vehicleFitment.slice(0, 100).map((item) => ({
    make: String(item.make || '').trim(), model: String(item.model || '').trim(),
    yearFrom: item.yearFrom ? Number(item.yearFrom) : undefined, yearTo: item.yearTo ? Number(item.yearTo) : undefined,
    engine: String(item.engine || '').trim(),
  })) : [];
  return {
    name, sku, brand, category: String(input.category || 'General').trim().slice(0, 100),
    unit: String(input.unit || 'PCS').trim().toUpperCase().slice(0, 20) || 'PCS',
    vehicleFitment: fitments, oe: Array.isArray(input.oe) ? [...new Set(input.oe.map((item) => String(item).trim().toUpperCase()).filter(Boolean))].slice(0, 50) : [],
    price: Math.max(0, Number(input.price || 0)), priceIncludesGst: Boolean(input.priceIncludesGst), cost: Math.max(0, Number(input.cost || 0)),
    reorderPoint: Math.max(0, Number(input.reorderPoint || 0)), barcode: String(input.barcode || '').trim() || undefined, locations,
  };
}

function preserveReservedStock(existing, updated) {
  if (!updated.locations.length) updated.locations = (existing.locations || []).map((location) => ({ warehouse: location.warehouse, rack: location.rack, qty: location.qty, reserved: location.reserved || 0 }));
  for (const oldLocation of existing.locations || []) {
    const reserved = Number(oldLocation.reserved || 0);
    if (!reserved) continue;
    const replacement = updated.locations.find((location) => location.warehouse === oldLocation.warehouse && location.rack === oldLocation.rack);
    if (!replacement) throw Object.assign(new Error(`Cannot move ${oldLocation.rack} while ${reserved} units are reserved for an order.`), { status: 409 });
    if (replacement.qty < reserved) throw Object.assign(new Error(`At least ${reserved} units must remain at ${oldLocation.rack} while an order is reserved.`), { status: 409 });
    replacement.reserved = reserved;
  }
  return updated;
}

function createOrderNumber(prefix) {
  const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  return `${prefix}-${date}-${randomBytes(2).toString('hex').toUpperCase()}`;
}

function sumAvailable(product, warehouse) {
  return product.locations.filter((location) => !warehouse || location.warehouse === warehouse)
    .reduce((sum, location) => sum + Math.max(0, Number(location.qty || 0) - Number(location.reserved || 0)), 0);
}

function allocateFromProduct(product, quantity, warehouse) {
  const allocations = [];
  let remaining = quantity;
  for (const location of product.locations.filter((item) => item.warehouse === warehouse)) {
    const available = Math.max(0, Number(location.qty || 0) - Number(location.reserved || 0));
    const amount = Math.min(available, remaining);
    if (amount > 0) { allocations.push({ warehouse, rack: location.rack, quantity: amount }); remaining -= amount; }
    if (!remaining) break;
  }
  if (remaining) throw Object.assign(new Error(`${product.sku} does not have enough available stock at ${warehouse}.`), { status: 409 });
  return allocations;
}

async function reserveOrder(orderId, user) {
  const unreservedSkus = [];
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      unreservedSkus.length = 0;
      const order = await Order.findById(orderId).session(session);
      if (!order || order.status !== 'ready_to_pack') throw Object.assign(new Error('This order is no longer waiting to be accepted.'), { status: 409 });
      if (!canManage(user) && (order.assignedTo !== user.id || order.warehouse !== user.warehouse)) throw Object.assign(new Error('You can only accept orders assigned to you at your warehouse.'), { status: 403 });
      for (const item of order.items) {
        if (!item.productId || item.allocations?.length) continue;
        const product = await Product.findById(item.productId).session(session);
        if (!product) { unreservedSkus.push(item.sku); continue; }
        let allocations;
        try { allocations = allocateFromProduct(product, item.quantity, order.warehouse); }
        catch (error) { if (error.status !== 409) throw error; unreservedSkus.push(item.sku); continue; }
        for (const allocation of allocations) {
          const location = product.locations.find((entry) => entry.warehouse === allocation.warehouse && entry.rack === allocation.rack);
          location.reserved += allocation.quantity;
        }
        item.allocations = allocations;
        await product.save({ session });
      }
      if (unreservedSkus.length) order.notes = `Stock was not reserved for unmapped or unavailable items: ${[...new Set(unreservedSkus)].join(', ')}`;
      order.status = 'accepted'; order.assignedTo = user.id; order.assignedName = user.name;
      order.statusHistory.push({ status: 'accepted', userId: user.id, userName: user.name, note: 'Accepted for packing' });
      await order.save({ session }); result = normalizeOrder(order);
    });
    return result;
  } finally { await session.endSession(); }
}

async function createAssignedOrder(orderData, user) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const [order] = await Order.create([orderData], { session });
      for (const item of order.items) {
        const product = await Product.findById(item.productId).session(session);
        if (!product) throw Object.assign(new Error(`Product ${item.sku} no longer exists.`), { status: 409 });
        const allocations = allocateFromProduct(product, item.quantity, order.warehouse);
        for (const allocation of allocations) {
          const location = product.locations.find((entry) => entry.warehouse === allocation.warehouse && entry.rack === allocation.rack);
          location.reserved += allocation.quantity;
        }
        item.allocations = allocations;
        await product.save({ session });
      }
      order.status = 'accepted'; order.assignedTo = user.id; order.assignedName = user.name;
      order.statusHistory.push({ status: 'accepted', userId: user.id, userName: user.name, note: 'Assigned by the store manager for packing' });
      await order.save({ session });
      await recordActivityEvent('sale_created', order, { id: order.createdById, name: order.createdByName, role: order.createdByRole }, session);
      result = normalizeOrder(order);
    });
    return result;
  } finally { await session.endSession(); }
}

function reserveDemoOrder(order, user) {
  const unreservedSkus = [];
  for (const item of order.items) {
    if (item.allocations?.length) continue;
    const product = demoProductStore.find((entry) => entry.sku === item.sku);
    if (!product) { unreservedSkus.push(item.sku); continue; }
    try {
      item.allocations = allocateFromProduct(product, item.quantity, order.warehouse);
      for (const allocation of item.allocations) {
        const location = product.locations.find((entry) => entry.warehouse === allocation.warehouse && entry.rack === allocation.rack);
        if (location) location.reserved = Number(location.reserved || 0) + allocation.quantity;
      }
    }
    catch (error) { if (error.status !== 409) throw error; unreservedSkus.push(item.sku); }
  }
  if (unreservedSkus.length) order.notes = `Stock was not reserved for unmapped or unavailable items: ${[...new Set(unreservedSkus)].join(', ')}`;
  order.status = 'accepted'; order.assignedTo = user.id; order.assignedName = user.name;
  order.statusHistory.push({ status: 'accepted', userId: user.id, userName: user.name, note: 'Accepted for packing', at: new Date() });
  return order;
}

async function updateOrderStatus(orderId, target, user) {
  const transitions = { accepted: ['packing'], packing: ['packed'], packed: ['shipped'], shipped: ['completed'] };
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const order = await Order.findById(orderId).session(session);
      if (!order) throw Object.assign(new Error('Order not found.'), { status: 404 });
      if (!canManage(user) && (order.assignedTo !== user.id || order.warehouse !== user.warehouse)) throw Object.assign(new Error('You can only update orders assigned to you at your warehouse.'), { status: 403 });
      if (target === 'cancelled') {
        if (['packed', 'shipped', 'completed', 'cancelled'].includes(order.status)) throw Object.assign(new Error('This order cannot be cancelled at its current stage.'), { status: 409 });
        if (['accepted', 'packing'].includes(order.status)) await adjustReservations(order, -1, session);
      } else if (!(transitions[order.status] || []).includes(target)) {
        throw Object.assign(new Error(`Cannot move an order from ${order.status} to ${target}.`), { status: 409 });
      }
      if (target === 'packed') { await consumeReservedStock(order, session); order.packedBy = user.name; }
      order.status = target;
      order.statusHistory.push({ status: target, userId: user.id, userName: user.name, note: target === 'packed' ? 'Packing completed; stock deducted' : '' });
      await order.save({ session });
      if (target === 'packed') await recordActivityEvent('order_packed', order, user, session);
      result = normalizeOrder(order);
    });
    return result;
  } finally { await session.endSession(); }
}

async function adjustReservations(order, direction, session) {
  for (const item of order.items) {
    if (!item.productId || !item.allocations?.length) continue;
    const product = await Product.findById(item.productId).session(session);
    if (!product) continue;
    for (const allocation of item.allocations) {
      const location = product.locations.find((entry) => entry.warehouse === allocation.warehouse && entry.rack === allocation.rack);
      if (location) location.reserved = Math.max(0, location.reserved + (allocation.quantity * direction));
    }
    await product.save({ session });
  }
}

async function consumeReservedStock(order, session) {
  for (const item of order.items) {
    if (!item.productId || !item.allocations?.length) continue;
    const product = await Product.findById(item.productId).session(session);
    if (!product) throw Object.assign(new Error(`Product ${item.sku} is missing.`), { status: 409 });
    for (const allocation of item.allocations) {
      const location = product.locations.find((entry) => entry.warehouse === allocation.warehouse && entry.rack === allocation.rack);
      if (!location || location.qty < allocation.quantity || location.reserved < allocation.quantity) throw Object.assign(new Error(`Reserved stock for ${item.sku} changed.`), { status: 409 });
      location.qty -= allocation.quantity; location.reserved -= allocation.quantity;
    }
    await product.save({ session });
  }
}

function consumeDemoStock(order) {
  for (const item of order.items) {
    const product = demoProductStore.find((entry) => entry.sku === item.sku);
    if (!product) continue;
    for (const allocation of item.allocations) {
      const location = product.locations.find((entry) => entry.warehouse === allocation.warehouse && entry.rack === allocation.rack);
      if (location) { location.qty -= allocation.quantity; location.reserved = Math.max(0, Number(location.reserved || 0) - allocation.quantity); }
    }
  }
}

function cancelDemoReservation(order) {
  for (const item of order.items) {
    const product = demoProductStore.find((entry) => entry.sku === item.sku);
    for (const allocation of item.allocations || []) {
      const location = product?.locations.find((entry) => entry.warehouse === allocation.warehouse && entry.rack === allocation.rack);
      if (location) location.reserved = Math.max(0, Number(location.reserved || 0) - allocation.quantity);
    }
  }
}

function getWooConfig() {
  const url = String(process.env.WOOCOMMERCE_URL || '').trim().replace(/\/$/, '');
  const consumerKey = process.env.WOOCOMMERCE_CONSUMER_KEY;
  const consumerSecret = process.env.WOOCOMMERCE_CONSUMER_SECRET;
  if (!url || !consumerKey || !consumerSecret) throw Object.assign(new Error('WooCommerce URL and REST API credentials are not configured.'), { status: 503 });
  return { url, authorization: `Basic ${Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64')}` };
}

async function wooRequest(path, options = {}) {
  const config = getWooConfig();
  const response = await fetch(`${config.url}/wp-json/wc/v3/${path}`, {
    ...options, signal: AbortSignal.timeout(20_000),
    headers: { Authorization: config.authorization, Accept: 'application/json', 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw Object.assign(new Error(`WooCommerce returned ${response.status}: ${result?.message || 'Check the store URL and API key permissions.'}`), { status: 502 });
  return result;
}

function wcMeta(product, key) { return product.meta_data?.find((entry) => [key, `_${key}`].includes(entry.key))?.value; }

function wooYmmDetails(product) {
  const relevant = /(year|make|model|ymm|fitment|vehicle|engine|trim)/i;
  const displayValue = (value) => {
    if (Array.isArray(value)) return value.map(displayValue).filter(Boolean).join(', ');
    if (value && typeof value === 'object') return Object.entries(value).map(([key, item]) => `${key}: ${displayValue(item)}`).filter((item) => !item.endsWith(': ')).join(' · ');
    return String(value ?? '').trim();
  };
  const details = [];
  for (const attribute of product.attributes || []) {
    if (relevant.test(attribute.name || '')) {
      const value = displayValue(attribute.options || []);
      if (value) details.push(`${attribute.name}: ${value}`);
    }
  }
  for (const entry of product.meta_data || []) {
    if (relevant.test(entry.key || '')) {
      const value = displayValue(entry.value);
      if (value) details.push(`${String(entry.key).replace(/^_+/, '').replaceAll('_', ' ')}: ${value}`);
    }
  }
  return [...new Set(details)].slice(0, 8).map((value) => value.slice(0, 320));
}

function normalizeWooCatalogProduct(item) {
  return { id: item.id, name: item.name, sku: item.sku || '', regularPrice: Number(item.regular_price || 0), salePrice: Number(item.sale_price || 0), status: item.status, stockStatus: item.stock_status, stockQuantity: item.stock_quantity, manageStock: item.manage_stock, permalink: item.permalink || '', image: item.images?.[0] ? { src: item.images[0].src, alt: item.images[0].alt || item.name } : null, ymmDetails: wooYmmDetails(item) };
}

async function wooYmmRequest(path) {
  const { url } = getWooConfig();
  const response = await fetch(`${url}/wp-json/saraswati/v1/ymm/${path}`, { signal: AbortSignal.timeout(20_000), headers: { Accept: 'application/json' } });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw Object.assign(new Error(response.status === 404 ? 'The YMM data connector is not installed on WordPress yet. Install wordpress/saraswati-ymm-rest.php, then try again.' : `WordPress YMM lookup returned ${response.status}: ${result?.message || 'Check the YMM data connector.'}`), { status: 502 });
  return result;
}

app.get('/api/health', (_request, response) => {
  const ready = dataSource === 'mongodb' && mongoose.connection.readyState === 1 && (!production || redisClient?.isReady);
  response.status(ready || !production ? 200 : 503).json({ ok: ready || !production, source: dataSource, cache: redisClient?.isReady ? 'ready' : 'disabled' });
});

const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 15, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many sign-in attempts. Try again later.' } });
app.post('/api/auth/login', loginLimiter, async (request, response, next) => {
  try {
    const email = String(request.body.email || '').trim().toLowerCase(); const password = String(request.body.password || '');
    let user;
    if (dataSource === 'mongodb') {
      user = await User.findOne({ email });
      if (!user || !(await bcrypt.compare(password, user.passwordHash))) return response.status(401).json({ error: 'Email or password is incorrect.' });
    } else {
      user = demoUserStore.find((item) => item.email.toLowerCase() === email && item.password === password);
      if (!user) return response.status(401).json({ error: 'Email or password is incorrect.' });
    }
    if (user.active === false || user.approved === false) return response.status(403).json({ error: 'Your account is waiting for admin approval.' });
    const safe = cleanUser(user); const sessionId = randomBytes(16).toString('hex'); const token = await signSession(user, sessionId);
    await createUserSession(safe, sessionId);
    response.cookie(sessionCookie, token, { httpOnly: true, secure: production, sameSite: 'lax', path: '/', maxAge: 12 * 60 * 60 * 1000 });
    return response.json({ user: safe });
  } catch (error) { return next(error); }
});

app.post('/api/auth/register', loginLimiter, async (request, response, next) => {
  try {
    const name = String(request.body.name || '').trim();
    const phone = String(request.body.phone || '').trim();
    const email = String(request.body.email || '').trim().toLowerCase();
    const password = String(request.body.password || '');
    const role = request.body.role;
    const warehouse = String(request.body.warehouse || '').toUpperCase();
    if (name.length < 2 || name.length > 120) return response.status(400).json({ error: 'Enter your full name.' });
    if (!/^\+?[0-9 ()-]{7,25}$/.test(phone)) return response.status(400).json({ error: 'Enter a valid phone number.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) return response.status(400).json({ error: 'Enter a valid email address.' });
    if (password.length < 12) return response.status(400).json({ error: 'Use a password with at least 12 characters.' });
    if (!['Packer', 'Store Manager'].includes(role) || !['KG', 'SPB', 'BG', 'PB'].includes(warehouse)) return response.status(400).json({ error: 'Choose Packer or Store Manager and select your warehouse.' });
    if (dataSource === 'mongodb') {
      await User.create({ name, phone, email, role, warehouse, approved: false, active: false, passwordHash: await bcrypt.hash(password, 12) });
    } else {
      if (demoUserStore.some((user) => user.email.toLowerCase() === email)) return response.status(409).json({ error: 'An account with this email already exists.' });
      demoUserStore.push({ id: `u-${Date.now()}`, name, phone, email, role, warehouse, password, approved: false, active: false });
    }
    return response.status(201).json({ message: 'Registration received. An admin must approve your account before you can sign in.' });
  } catch (error) { return next(error); }
});

app.post('/api/auth/logout', requireAuth, async (request, response, next) => {
  try { await endUserSession(request.sessionId, 'logout'); response.clearCookie(sessionCookie, { httpOnly: true, secure: production, sameSite: 'lax', path: '/' }); return response.status(204).end(); }
  catch (error) { return next(error); }
});
app.get('/api/auth/me', requireAuth, (request, response) => response.json({ user: request.user }));
app.post('/api/auth/heartbeat', requireAuth, async (request, response, next) => {
  try {
    const renewed = await updateUserSessionHeartbeat(request.sessionId);
    if (!renewed) {
      const sessionId = randomBytes(16).toString('hex'); await createUserSession(request.user, sessionId);
      const token = await signSession(request.user, sessionId);
      response.cookie(sessionCookie, token, { httpOnly: true, secure: production, sameSite: 'lax', path: '/', maxAge: 12 * 60 * 60 * 1000 });
    }
    return response.json({ ok: true, resumed: !renewed, at: new Date().toISOString() });
  }
  catch (error) { return next(error); }
});

app.get('/api/users', requireAuth, requireAdmin, async (_request, response, next) => {
  try {
    const users = dataSource === 'mongodb' ? await User.find().select('name phone email role warehouse approved active').sort({ name: 1 }).lean() : demoUserStore;
    response.json({ items: users.map(cleanUser) });
  } catch (error) { next(error); }
});

app.get('/api/users/packers', requireAuth, requireManager, async (request, response, next) => {
  try {
    const warehouse = String(request.query.warehouse || '').toUpperCase();
    if (!['KG', 'SPB', 'BG', 'PB'].includes(warehouse)) return response.status(400).json({ error: 'Choose a valid warehouse for the packer list.' });
    const items = dataSource === 'mongodb'
      ? await User.find({ active: true, approved: { $ne: false }, role: 'Packer', warehouse }).select('name phone email role warehouse').sort({ name: 1 }).lean()
      : demoUserStore.filter((user) => user.role === 'Packer' && user.approved !== false && user.active !== false && user.warehouse === warehouse);
    return response.json({ items: items.map(cleanUser) });
  } catch (error) { return next(error); }
});

app.post('/api/users', requireAuth, requireAdmin, async (request, response, next) => {
  try {
    const name = String(request.body.name || '').trim(); const email = String(request.body.email || '').trim().toLowerCase();
    const role = request.body.role;
    const phone = String(request.body.phone || '').trim();
    const warehouse = String(request.body.warehouse || '').toUpperCase();
    if (!name || !email || !['Admin', 'Store Manager', 'Packer'].includes(role)) return response.status(400).json({ error: 'Name, email and a valid role are required.' });
    if (role !== 'Admin' && !['KG', 'SPB', 'BG', 'PB'].includes(warehouse)) return response.status(400).json({ error: 'Choose a warehouse for this account.' });
    if (dataSource === 'mongodb') {
      const temporaryPassword = String(request.body.password || randomBytes(12).toString('base64url'));
      const user = await User.create({ name, phone, email, role, warehouse: warehouse || undefined, approved: true, active: true, passwordHash: await bcrypt.hash(temporaryPassword, 12) });
      return response.status(201).json({ user: cleanUser(user), temporaryPassword });
    }
    if (demoUserStore.some((item) => item.email.toLowerCase() === email)) return response.status(409).json({ error: 'This email already has an account.' });
    const user = { id: `u-${Date.now()}`, name, phone, email, role, warehouse, approved: true, active: true, password: request.body.password || randomBytes(12).toString('base64url') };
    demoUserStore.push(user); return response.status(201).json({ user: cleanUser(user), temporaryPassword: user.password });
  } catch (error) { next(error); }
});

app.patch('/api/users/:id/role', requireAuth, requireAdmin, async (request, response, next) => {
  try {
    const role = request.body.role;
    if (!['Admin', 'Store Manager', 'Packer'].includes(role)) return response.status(400).json({ error: 'Unknown role.' });
    let user;
    if (dataSource === 'mongodb') user = await User.findByIdAndUpdate(request.params.id, { role }, { new: true, runValidators: true }).select('name phone email role warehouse approved active');
    else { user = demoUserStore.find((item) => item.id === request.params.id); if (user) user.role = role; }
    if (!user) return response.status(404).json({ error: 'Team member not found.' });
    return response.json({ user: cleanUser(user) });
  } catch (error) { return next(error); }
});

app.patch('/api/users/:id/approval', requireAuth, requireAdmin, async (request, response, next) => {
  try {
    if (request.body.approved !== true) return response.status(400).json({ error: 'Approval can only be granted by an admin.' });
    let user;
    if (dataSource === 'mongodb') user = await User.findOneAndUpdate({ _id: request.params.id, approved: false }, { approved: true, active: true }, { new: true }).select('name phone email role warehouse approved active');
    else { user = demoUserStore.find((item) => item.id === request.params.id); if (user?.approved === false) { user.approved = true; user.active = true; } else user = null; }
    if (!user) return response.status(404).json({ error: 'Pending account not found.' });
    return response.json({ user: cleanUser(user) });
  } catch (error) { return next(error); }
});

app.patch('/api/users/:id/warehouse', requireAuth, requireAdmin, async (request, response, next) => {
  try {
    const warehouse = String(request.body.warehouse || '').toUpperCase();
    if (!['KG', 'SPB', 'BG', 'PB'].includes(warehouse)) return response.status(400).json({ error: 'Choose KG, SPB, BG or PB.' });
    let user;
    if (dataSource === 'mongodb') user = await User.findByIdAndUpdate(request.params.id, { warehouse }, { new: true, runValidators: true }).select('name phone email role warehouse approved active');
    else { user = demoUserStore.find((item) => item.id === request.params.id); if (user) user.warehouse = warehouse; }
    if (!user) return response.status(404).json({ error: 'Team member not found.' });
    return response.json({ user: cleanUser(user) });
  } catch (error) { return next(error); }
});

app.delete('/api/users/:id', requireAuth, requireAdmin, async (request, response, next) => {
  try {
    const userId = String(request.params.id);
    if (userId === request.user.id) return response.status(409).json({ error: 'You cannot delete the account you are currently using.' });
    if (dataSource !== 'mongodb') {
      const index = demoUserStore.findIndex((user) => user.id === userId);
      if (index < 0) return response.status(404).json({ error: 'Team member not found.' });
      if (demoUserStore[index].role === 'Admin' && demoUserStore.filter((user) => user.role === 'Admin' && user.active !== false).length <= 1) return response.status(409).json({ error: 'Keep at least one active admin account.' });
      const [deleted] = demoUserStore.splice(index, 1);
      demoPushSubscriptions = demoPushSubscriptions.filter((subscription) => subscription.userId !== userId);
      return response.json({ deleted: true, user: cleanUser(deleted) });
    }
    if (!mongoose.isValidObjectId(userId)) return response.status(404).json({ error: 'Team member not found.' });
    const user = await User.findById(userId).select('name email role active').lean();
    if (!user) return response.status(404).json({ error: 'Team member not found.' });
    if (user.role === 'Admin' && user.active !== false && await User.countDocuments({ role: 'Admin', active: { $ne: false }, _id: { $ne: user._id } }) === 0) {
      return response.status(409).json({ error: 'Keep at least one active admin account.' });
    }
    const openAssignedOrder = await Order.exists({ assignedTo: userId, status: { $in: ['ready_to_pack', 'accepted', 'packing'] } });
    if (openAssignedOrder) return response.status(409).json({ error: 'This member still has open packing orders. Complete or cancel those orders before deleting the account.' });
    const now = new Date();
    const sessions = await UserSession.find({ userId, endedAt: null }).select('sessionId loginAt').lean();
    if (sessions.length) await UserSession.bulkWrite(sessions.map((session) => ({ updateOne: {
      filter: { sessionId: session.sessionId, endedAt: null },
      update: { $set: { endedAt: now, durationSeconds: Math.max(0, Math.floor((now.getTime() - new Date(session.loginAt).getTime()) / 1000)), endReason: 'admin_removed', expiresAt: new Date(now.getTime() + auditRetentionMs) } },
    } })));
    await PushSubscription.deleteMany({ userId });
    await User.deleteOne({ _id: user._id });
    return response.json({ deleted: true, user: cleanUser(user) });
  } catch (error) { return next(error); }
});

app.get('/api/products', requireAuth, requireManager, async (_request, response, next) => {
  try {
    const page = Math.max(1, Math.floor(Number(_request.query.page) || 1));
    const limit = Math.min(25, Math.max(1, Math.floor(Number(_request.query.limit) || 25)));
    if (dataSource !== 'mongodb') {
      const items = demoProductStore.filter((product) => product.active !== false).sort((a, b) => a.sku.localeCompare(b.sku)).slice((page - 1) * limit, page * limit);
      return response.json({ items, total: demoProductStore.filter((product) => product.active !== false).length, page, pageSize: limit });
    }
    const criteria = { active: { $ne: false } };
    const [items, total] = await Promise.all([
      Product.find(criteria).sort({ sku: 1 }).skip((page - 1) * limit).limit(limit).lean(),
      Product.countDocuments(criteria),
    ]);
    return response.json({ items: items.map(normalizeProduct), total, page, pageSize: limit });
  }
  catch (error) { next(error); }
});

app.get('/api/products/summary', requireAuth, requireManager, async (_request, response, next) => {
  try {
    if (dataSource !== 'mongodb') {
      const products = demoProductStore.filter((product) => product.active !== false);
      const available = (product, warehouse) => (product.locations || []).filter((location) => !warehouse || location.warehouse === warehouse).reduce((sum, location) => sum + Math.max(0, Number(location.qty || 0) - Number(location.reserved || 0)), 0);
      return response.json({ totalSkus: products.length, totalUnits: products.reduce((sum, product) => sum + available(product), 0), lowStock: products.filter((product) => available(product) <= Number(product.reorderPoint || 5)).length, warehouses: Object.fromEntries(['KG', 'SPB', 'BG', 'PB'].map((code) => [code, products.reduce((sum, product) => sum + available(product, code), 0)])) });
    }
    const [summary] = await Product.aggregate([
      { $match: { active: { $ne: false } } },
      { $unwind: { path: '$locations', preserveNullAndEmptyArrays: true } },
      { $set: { locationAvailable: { $let: { vars: { balance: { $subtract: [{ $ifNull: ['$locations.qty', 0] }, { $ifNull: ['$locations.reserved', 0] }] } }, in: { $cond: [{ $gt: ['$$balance', 0] }, '$$balance', 0] } } } } },
      { $group: {
        _id: '$_id', reorderPoint: { $first: { $ifNull: ['$reorderPoint', 5] } },
        available: { $sum: '$locationAvailable' },
        KG: { $sum: { $cond: [{ $eq: ['$locations.warehouse', 'KG'] }, '$locationAvailable', 0] } },
        SPB: { $sum: { $cond: [{ $eq: ['$locations.warehouse', 'SPB'] }, '$locationAvailable', 0] } },
        BG: { $sum: { $cond: [{ $eq: ['$locations.warehouse', 'BG'] }, '$locationAvailable', 0] } },
        PB: { $sum: { $cond: [{ $eq: ['$locations.warehouse', 'PB'] }, '$locationAvailable', 0] } },
      } },
      { $group: {
        _id: null, totalSkus: { $sum: 1 }, totalUnits: { $sum: '$available' },
        lowStock: { $sum: { $cond: [{ $lte: ['$available', '$reorderPoint'] }, 1, 0] } },
        kgUnits: { $sum: '$KG' }, spbUnits: { $sum: '$SPB' }, bgUnits: { $sum: '$BG' }, pbUnits: { $sum: '$PB' },
      } },
      { $project: { _id: 0, totalSkus: 1, totalUnits: 1, lowStock: 1, warehouses: { KG: '$kgUnits', SPB: '$spbUnits', BG: '$bgUnits', PB: '$pbUnits' } } },
    ]);
    return response.json(summary || { totalSkus: 0, totalUnits: 0, lowStock: 0, warehouses: { KG: 0, SPB: 0, BG: 0, PB: 0 } });
  } catch (error) { return next(error); }
});

app.get('/api/racks', requireAuth, requireManager, async (_request, response, next) => {
  try {
    const items = dataSource === 'mongodb'
      ? await Rack.find().sort({ warehouse: 1, rack: 1 }).lean()
      : demoRackStore;
    return response.json({ items: items.map((item) => ({ warehouse: item.warehouse, rack: item.rack })) });
  } catch (error) { return next(error); }
});

app.post('/api/racks', requireAuth, requireManager, async (request, response, next) => {
  try {
    const warehouse = String(request.body.warehouse || '').toUpperCase();
    const rack = String(request.body.rack || '').trim().toUpperCase();
    if (!['KG', 'SPB', 'BG', 'PB'].includes(warehouse) || !/^G-\d+[A-E]$/.test(rack)) return response.status(400).json({ error: 'Choose a warehouse and use a rack label such as G-160A.' });
    if (dataSource === 'mongodb') await Rack.create({ warehouse, rack });
    else {
      if (demoRackStore.some((item) => item.warehouse === warehouse && item.rack === rack)) return response.status(409).json({ error: 'That rack already exists in this warehouse.' });
      demoRackStore.push({ warehouse, rack });
    }
    return response.status(201).json({ warehouse, rack });
  } catch (error) { return next(error); }
});

app.get('/api/products/search', requireAuth, requireManager, async (request, response, next) => {
  try {
    const query = String(request.query.q || '').trim().slice(0, 100);
    const warehouse = String(request.query.warehouse || 'all').toUpperCase();
    if (!['ALL', 'KG', 'SPB', 'BG', 'PB'].includes(warehouse)) return response.status(400).json({ error: 'Unknown warehouse.' });
    if (query.length < 2) return response.json({ items: [], total: 0, query, warehouse: warehouse.toLowerCase(), source: dataSource });
    const page = Math.max(1, Math.floor(Number(request.query.page) || 1)); const pageSize = 25;
    const cacheDigest = createHash('sha256').update(`${dataSource}|${warehouse}|${query.toLocaleLowerCase()}|${page}`).digest('hex');
    const cacheKey = `stockroom:search:v2:${cacheDigest}`; const cached = await readSearchCache(cacheKey);
    if (cached) return response.json({ ...cached, cached: true });
    let items; let total;
    if (dataSource === 'mongodb') {
      const expression = new RegExp(escapeRegex(query), 'i');
      const criteria = { $or: [{ sku: expression }, { barcode: expression }, { brand: expression }, { name: expression }, { oe: expression }, { category: expression }, { 'vehicleFitment.make': expression }, { 'vehicleFitment.model': expression }] };
      if (warehouse !== 'ALL') criteria.locations = { $elemMatch: { warehouse } };
      const exactProduct = await Product.findOne({ active: { $ne: false }, $or: [{ sku: query.toUpperCase() }, { barcode: query }] }).lean();
      if (exactProduct && (warehouse === 'ALL' || exactProduct.locations.some((location) => location.warehouse === warehouse))) {
        const exactOe = exactProduct.oe || [];
        const linkedCriteria = exactOe.length ? { active: { $ne: false }, oe: { $in: exactOe } } : { _id: exactProduct._id };
        if (warehouse !== 'ALL') linkedCriteria.locations = { $elemMatch: { warehouse } };
        const linked = await Product.find(linkedCriteria).sort({ sku: 1 }).lean();
        const linkedProducts = linked.map(normalizeProduct);
        if (!linkedProducts.some((product) => product.id === String(exactProduct._id))) linkedProducts.push(normalizeProduct(exactProduct));
        linkedProducts.sort((left, right) => left.sku.localeCompare(right.sku));
        total = linkedProducts.length;
        items = linkedProducts.slice((page - 1) * pageSize, page * pageSize);
      } else {
        const [found, count] = await Promise.all([Product.find(criteria).select('-__v').sort({ sku: 1 }).skip((page - 1) * pageSize).limit(pageSize).lean(), Product.countDocuments(criteria)]);
        items = found.map(normalizeProduct); total = count;
      }
    } else {
      const normalized = query.toLowerCase();
      const matched = demoProductStore.filter((product) => {
        const fields = [product.name, product.sku, product.brand, product.barcode, product.category, ...(product.oe || []), ...(product.vehicleFitment || []).flatMap((fitment) => [fitment.make, fitment.model, fitment.engine])];
        return fields.some((value) => String(value || '').toLowerCase().includes(normalized)) && (warehouse === 'ALL' || product.locations.some((location) => location.warehouse === warehouse));
      });
      total = matched.length; items = matched.slice((page - 1) * pageSize, page * pageSize);
    }
    const result = { items, total, page, pageSize, query, warehouse: warehouse.toLowerCase(), source: dataSource, cached: false };
    await writeSearchCache(cacheKey, result); return response.json(result);
  } catch (error) { return next(error); }
});

app.get('/api/products/oe-mappings', requireAuth, requireManager, async (request, response, next) => {
  try {
    const page = Math.max(1, Math.floor(Number(request.query.page) || 1));
    const pageSize = Math.min(50, Math.max(1, Math.floor(Number(request.query.limit) || 30)));
    if (dataSource !== 'mongodb') {
      const mapping = new Map();
      for (const product of demoProductStore.filter((item) => item.active !== false)) for (const oe of new Set(product.oe || [])) {
        if (!oe) continue;
        if (!mapping.has(oe)) mapping.set(oe, []);
        mapping.get(oe).push(product);
      }
      const entries = [...mapping.entries()].sort(([left], [right]) => left.localeCompare(right));
      const groups = entries.slice((page - 1) * pageSize, page * pageSize).map(([oe, products]) => ({ oe, products }));
      return response.json({ groups, total: entries.length, page, pageSize });
    }
    const [result] = await Product.aggregate([
      { $match: { active: { $ne: false }, oe: { $exists: true, $ne: [] } } },
      { $unwind: '$oe' },
      { $match: { oe: { $type: 'string', $ne: '' } } },
      { $group: { _id: '$oe' } },
      { $sort: { _id: 1 } },
      { $facet: { groups: [{ $skip: (page - 1) * pageSize }, { $limit: pageSize }], count: [{ $count: 'total' }] } },
    ]);
    const oeNumbers = (result?.groups || []).map((group) => group._id);
    const matchingProducts = oeNumbers.length ? (await Product.find({ active: { $ne: false }, oe: { $in: oeNumbers } }).lean()).map(normalizeProduct) : [];
    const groups = oeNumbers.map((oe) => ({ oe, products: matchingProducts.filter((product) => product.oe.includes(oe)) }));
    const total = result?.count?.[0]?.total || 0;
    return response.json({ groups, total, page, pageSize });
  } catch (error) { return next(error); }
});

app.post('/api/products', requireAuth, requireManager, async (request, response, next) => {
  try {
    const product = validateProduct(request.body);
    const saved = dataSource === 'mongodb' ? await Product.create(product) : (() => { if (demoProductStore.some((item) => item.sku === product.sku)) throw Object.assign(new Error('SKU already exists.'), { status: 409 }); const created = { ...product, id: `p-${Date.now()}` }; demoProductStore.unshift(created); return created; })();
    await invalidateSearchCache(); return response.status(201).json({ product: normalizeProduct(saved) });
  } catch (error) { return next(error); }
});

app.put('/api/products/:id', requireAuth, requireManager, async (request, response, next) => {
  try {
    const updated = validateProduct(request.body);
    let saved;
    if (dataSource === 'mongodb') { const existing = await Product.findById(request.params.id); if (existing) saved = await Product.findByIdAndUpdate(existing.id, preserveReservedStock(existing, updated), { new: true, runValidators: true }); }
    else { const index = demoProductStore.findIndex((item) => item.id === request.params.id || item.sku === request.params.id); if (index < 0) return response.status(404).json({ error: 'Product not found.' }); saved = { ...demoProductStore[index], ...preserveReservedStock(demoProductStore[index], updated) }; demoProductStore[index] = saved; }
    if (!saved) return response.status(404).json({ error: 'Product not found.' });
    await invalidateSearchCache(); return response.json({ product: normalizeProduct(saved) });
  } catch (error) { return next(error); }
});

app.delete('/api/products/:id', requireAuth, requireManager, async (request, response, next) => {
  try {
    let deleted;
    if (dataSource === 'mongodb') {
      if (!mongoose.isValidObjectId(request.params.id)) return response.status(404).json({ error: 'Product not found.' });
      const product = await Product.findById(request.params.id).select('locations').lean();
      if (!product) return response.status(404).json({ error: 'Product not found.' });
      if ((product.locations || []).some((location) => Number(location.reserved || 0) > 0)) return response.status(409).json({ error: 'This product has units reserved for open orders. Complete or cancel those orders before deleting it.' });
      deleted = await Product.findByIdAndDelete(request.params.id);
    } else {
      const index = demoProductStore.findIndex((product) => product.id === request.params.id || product.sku === request.params.id);
      if (index < 0) return response.status(404).json({ error: 'Product not found.' });
      if (demoProductStore[index].locations.some((location) => Number(location.reserved || 0) > 0)) return response.status(409).json({ error: 'This product has units reserved for open orders. Complete or cancel those orders before deleting it.' });
      [deleted] = demoProductStore.splice(index, 1);
    }
    await invalidateSearchCache();
    return response.json({ deleted: true, sku: deleted.sku });
  } catch (error) { return next(error); }
});

app.post('/api/products/import', requireAuth, requireManager, async (request, response, next) => {
  try {
    const rows = request.body.products;
    const warehouse = String(request.body.warehouse || '').toUpperCase();
    const updateMatchingOnly = request.body.mode === 'update-matching';
    if (!Array.isArray(rows) || rows.length > 5000) return response.status(400).json({ error: 'Import between 1 and 5,000 rows per file.' });
    if (!['KG', 'SPB', 'BG', 'PB'].includes(warehouse)) return response.status(400).json({ error: 'Select a warehouse for this import.' });
    if (dataSource !== 'mongodb') return response.status(503).json({ error: 'Bulk import requires persistent MongoDB storage. Configure MONGODB_URI before importing so stock is not lost on restart.' });
    const errors = []; let inserted = 0; let updated = 0; let skipped = 0;
    const prepared = [];
    for (let index = 0; index < rows.length; index += 1) {
      try {
        const product = validateProduct(rows[index]);
        if (!product.locations.length) throw Object.assign(new Error('This SKU has no valid stock quantity row. Fix the qty column before importing.'), { status: 400 });
        const warehouseLocations = product.locations.map((location) => ({ ...location, warehouse }));
        const byRack = new Map();
        for (const location of warehouseLocations) {
          const key = location.rack;
          const current = byRack.get(key);
          if (current) current.qty += location.qty;
          else byRack.set(key, { ...location });
        }
        const selectedLocations = [...byRack.values()];
        prepared.push({ index, product, selectedLocations });
      } catch (error) { errors.push({ row: index + 2, sku: rows[index]?.sku || '', error: error.message }); }
    }
    const existingProducts = prepared.length ? await Product.find({ sku: { $in: prepared.map(({ product }) => product.sku) } }).lean() : [];
    const existingBySku = new Map(existingProducts.map((product) => [product.sku, product]));
    const operations = [];
    for (const { index, product, selectedLocations } of prepared) {
      const existing = existingBySku.get(product.sku);
      if (!existing) {
        if (updateMatchingOnly) { skipped += 1; continue; }
        operations.push({ insertOne: { document: { ...product, locations: selectedLocations } } });
        continue;
      }
      const retained = (existing.locations || []).filter((location) => location.warehouse !== warehouse);
      const oldSelected = (existing.locations || []).filter((location) => location.warehouse === warehouse);
      let problem = '';
      for (const oldLocation of oldSelected) {
        const replacement = selectedLocations.find((location) => location.rack === oldLocation.rack);
        if (Number(oldLocation.reserved || 0) > 0 && (!replacement || replacement.qty < Number(oldLocation.reserved))) {
          problem = `At least ${oldLocation.reserved} units must remain at ${oldLocation.rack || warehouse} while an order is reserved.`;
          break;
        }
      }
      if (problem) { errors.push({ row: index + 2, sku: product.sku, error: problem }); continue; }
      const mergedLocations = [...retained, ...selectedLocations.map((location) => {
        const oldLocation = oldSelected.find((current) => current.rack === location.rack);
        return { ...location, reserved: Number(oldLocation?.reserved || 0) };
      })];
      const fields = new Set(rows[index]?.providedFields || []);
      const productUpdates = {};
      if (updateMatchingOnly) {
        if (fields.has('name')) productUpdates.name = product.name;
        if (fields.has('brand')) productUpdates.brand = product.brand;
        if (fields.has('category')) productUpdates.category = product.category;
        if (fields.has('unit') || fields.has('uom')) productUpdates.unit = product.unit;
        if (fields.has('oe')) productUpdates.oe = product.oe;
        if (fields.has('barcode')) productUpdates.barcode = product.barcode;
        if (fields.has('price')) productUpdates.price = product.price;
        if (fields.has('priceincludesgst')) productUpdates.priceIncludesGst = product.priceIncludesGst;
        if (fields.has('cost')) productUpdates.cost = product.cost;
        if (fields.has('reorderpoint')) productUpdates.reorderPoint = product.reorderPoint;
        if (['fitments', 'vehiclemake', 'vehiclemodel', 'yearfrom', 'yearto', 'engine'].some((field) => fields.has(field))) productUpdates.vehicleFitment = product.vehicleFitment;
      }
      operations.push({ updateOne: { filter: { _id: existing._id, locations: existing.locations }, update: { $set: { locations: mergedLocations, ...productUpdates } } } });
    }
    if (operations.length) {
      const result = await Product.bulkWrite(operations, { ordered: false });
      inserted = result.insertedCount || 0; updated = result.modifiedCount || 0;
      if (result.matchedCount < operations.filter((operation) => operation.updateOne).length) {
        errors.push({ row: 0, sku: '', error: 'Some products changed while the file was importing. Re-export this warehouse and retry the remaining rows.' });
      }
    }
    await invalidateSearchCache(); return response.json({ warehouse, inserted, updated, skipped, failed: errors.length, errors: errors.slice(0, 100) });
  } catch (error) { return next(error); }
});

app.get('/api/products/export', requireAuth, requireManager, async (request, response, next) => {
  try {
    const warehouse = String(request.query.warehouse || '').toUpperCase();
    if (!['KG', 'SPB', 'BG', 'PB'].includes(warehouse)) return response.status(400).json({ error: 'Select a warehouse to export.' });
    const filterBy = String(request.query.filterBy || '').toLowerCase();
    const filterValue = String(request.query.filterValue || '').trim().slice(0, 120);
    if (filterBy && !['category', 'brand', 'oe'].includes(filterBy)) return response.status(400).json({ error: 'Choose category, brand, or OE number as the export filter.' });
    if (filterBy && !filterValue) return response.status(400).json({ error: 'Enter an exact value for the selected export filter.' });
    if (!filterBy && filterValue) return response.status(400).json({ error: 'Choose a filter type for the export value.' });
    const columns = ['sku', 'name', 'brand', 'category', 'unit', 'oe', 'barcode', 'price', 'priceIncludesGst', 'cost', 'reorderPoint', 'warehouse', 'rack', 'qty', 'vehicleMake', 'vehicleModel', 'yearFrom', 'yearTo', 'engine', 'fitments'];
    const escapeCsv = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
    const filenameValue = filterValue.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    const filename = `saraswati-${warehouse.toLowerCase()}-${filterBy ? `${filterBy}-${filenameValue}` : 'inventory'}.csv`;
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    response.setHeader('Cache-Control', 'no-store');
    response.write(`\uFEFF${columns.join(',')}\r\n`);
    const matchesFilter = (product) => {
      if (!filterBy) return true;
      const actual = filterBy === 'oe' ? (product.oe || []).some((value) => String(value).localeCompare(filterValue, undefined, { sensitivity: 'accent' }) === 0) : String(product[filterBy] || '').localeCompare(filterValue, undefined, { sensitivity: 'accent' }) === 0;
      return actual;
    };
    const writeRow = async (values) => {
      if (!response.write(`${values.map(escapeCsv).join(',')}\r\n`)) await new Promise((resolve) => response.once('drain', resolve));
    };
    if (dataSource === 'mongodb') {
      const filter = { active: { $ne: false }, 'locations.warehouse': warehouse };
      if (filterBy === 'category' || filterBy === 'brand') filter[filterBy] = { $regex: `^${escapeRegex(filterValue)}$`, $options: 'i' };
      if (filterBy === 'oe') filter.oe = { $regex: `^${escapeRegex(filterValue)}$`, $options: 'i' };
      const cursor = Product.find(filter)
        .select('sku name brand category unit oe barcode price priceIncludesGst cost reorderPoint vehicleFitment locations')
        .sort({ sku: 1 }).lean().cursor({ batchSize: 250 });
      for await (const product of cursor) {
        if (!matchesFilter(product)) continue;
        for (const location of product.locations || []) {
          if (location.warehouse !== warehouse) continue;
          const fitment = product.vehicleFitment?.[0] || {};
          await writeRow([product.sku, product.name, product.brand, product.category, product.unit || 'PCS', (product.oe || []).join('|'), product.barcode, product.price, product.priceIncludesGst, product.cost, product.reorderPoint, warehouse, location.rack, location.qty, fitment.make, fitment.model, fitment.yearFrom, fitment.yearTo, fitment.engine, JSON.stringify(product.vehicleFitment || [])]);
        }
      }
    } else {
      for (const product of demoProductStore) for (const location of product.locations || []) {
        if (location.warehouse !== warehouse || !matchesFilter(product)) continue;
        const fitment = product.vehicleFitment?.[0] || {};
        await writeRow([product.sku, product.name, product.brand, product.category, product.unit || 'PCS', (product.oe || []).join('|'), product.barcode, product.price, product.priceIncludesGst, product.cost, product.reorderPoint, warehouse, location.rack, location.qty, fitment.make, fitment.model, fitment.yearFrom, fitment.yearTo, fitment.engine, JSON.stringify(product.vehicleFitment || [])]);
      }
    }
    return response.end();
  } catch (error) { return next(error); }
});

app.get('/api/orders', requireAuth, async (request, response, next) => {
  try {
    const filter = request.query.status && request.query.status !== 'all' ? { status: request.query.status } : {};
    if (!canManage(request.user)) { filter.assignedTo = request.user.id; filter.warehouse = request.user.warehouse; }
    const items = dataSource === 'mongodb' ? (await Order.find(filter).sort({ createdAt: -1 }).limit(500).lean()).map(normalizeOrder) : demoOrders.filter((item) => (!filter.status || item.status === filter.status) && (canManage(request.user) || (item.assignedTo === request.user.id && item.warehouse === request.user.warehouse))).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return response.json({ items });
  } catch (error) { return next(error); }
});

app.post('/api/orders/:id/assign', requireAuth, requireManager, async (request, response, next) => {
  try {
    const warehouse = String(request.body.warehouse || '').toUpperCase();
    if (!['KG', 'SPB', 'BG', 'PB'].includes(warehouse)) return response.status(400).json({ error: 'Choose a valid fulfilment warehouse.' });
    const packerId = String(request.body.packerId || '').trim();
    if (!packerId) return response.status(400).json({ error: 'Select a packer.' });
    const packer = dataSource === 'mongodb'
      ? await User.findOne({ _id: packerId, active: true, approved: { $ne: false }, role: 'Packer', warehouse }).select('name phone email role warehouse approved active').lean()
      : demoUserStore.find((user) => String(user.id) === packerId && user.role === 'Packer' && user.active !== false && user.approved !== false && user.warehouse === warehouse);
    if (!packer) return response.status(400).json({ error: 'Choose an approved packer assigned to the selected warehouse.' });
    const selectedPacker = cleanUser(packer);
    let updated;
    if (dataSource === 'mongodb') {
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          const order = await Order.findById(request.params.id).session(session);
          if (!order || order.source !== 'woocommerce') throw Object.assign(new Error('Website order not found.'), { status: 404 });
          if (order.status !== 'ready_to_pack' || order.assignedTo) throw Object.assign(new Error('This website order has already been assigned or started.'), { status: 409 });
          order.warehouse = warehouse;
          order.assignedTo = selectedPacker.id;
          order.assignedName = selectedPacker.name;
          order.statusHistory.push({ status: 'ready_to_pack', userId: request.user.id, userName: request.user.name, note: `Assigned to ${selectedPacker.name} for packing at ${warehouse}` });
          await order.save({ session });
          updated = normalizeOrder(order);
        });
      } finally { await session.endSession(); }
    } else {
      const order = demoOrders.find((item) => item.id === request.params.id && item.source === 'woocommerce');
      if (!order) return response.status(404).json({ error: 'Website order not found.' });
      if (order.status !== 'ready_to_pack' || order.assignedTo) return response.status(409).json({ error: 'This website order has already been assigned or started.' });
      order.warehouse = warehouse; order.assignedTo = selectedPacker.id; order.assignedName = selectedPacker.name; order.updatedAt = new Date().toISOString();
      order.statusHistory.push({ status: 'ready_to_pack', userId: request.user.id, userName: request.user.name, note: `Assigned to ${selectedPacker.name} for packing at ${warehouse}`, at: new Date() });
      updated = normalizeOrder(order);
    }
    notifyPacker(selectedPacker, updated).catch((error) => console.warn('Packing push notification failed:', error.message));
    return response.json({ order: updated, message: `${updated.orderNumber} assigned to ${selectedPacker.name} at ${warehouse}.` });
  } catch (error) { return next(error); }
});

app.get('/api/activity', requireAuth, requireManager, async (_request, response, next) => {
  try {
    await sweepLostSessions();
    const since = new Date(Date.now() - auditRetentionMs);
    if (dataSource === 'mongodb') {
      const [events, sessions] = await Promise.all([
        ActivityEvent.find({ occurredAt: { $gte: since } }).sort({ occurredAt: -1 }).limit(5000).lean(),
        UserSession.find({ loginAt: { $gte: since } }).sort({ loginAt: -1 }).limit(5000).lean(),
      ]);
      return response.json({ events, sessions: sessions.map((session) => ({ id: session.sessionId, userId: session.userId, userName: session.userName, userEmail: session.userEmail, userRole: session.userRole, warehouse: session.warehouse, loginAt: session.loginAt, lastSeenAt: session.lastSeenAt, endedAt: session.endedAt, durationSeconds: session.durationSeconds, endReason: session.endReason, active: !session.endedAt })), retentionDays: auditRetentionDays });
    }
    const events = demoActivityEvents.filter((event) => new Date(event.occurredAt) >= since).slice(0, 5000);
    const sessions = demoUserSessions.filter((session) => new Date(session.loginAt) >= since).slice(0, 5000).map((session) => ({ id: session.sessionId, userId: session.userId, userName: session.userName, userEmail: session.userEmail, userRole: session.userRole, warehouse: session.warehouse, loginAt: session.loginAt, lastSeenAt: session.lastSeenAt, endedAt: session.endedAt, durationSeconds: session.durationSeconds, endReason: session.endReason, active: !session.endedAt }));
    return response.json({ events, sessions, retentionDays: auditRetentionDays });
  } catch (error) { return next(error); }
});

app.get('/api/sales/history', requireAuth, requireManager, async (request, response, next) => {
  try {
    const since = new Date(Date.now() - auditRetentionMs);
    const page = Math.max(1, Math.floor(Number(request.query.page) || 1));
    const pageSize = 100;
    const query = String(request.query.q || '').trim().slice(0, 100);
    if (dataSource === 'mongodb') {
      const filter = { type: 'sale_created', occurredAt: { $gte: since } };
      if (query) {
        const safe = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        filter.$or = [{ orderNumber: { $regex: safe, $options: 'i' } }, { customerName: { $regex: safe, $options: 'i' } }, { actorName: { $regex: safe, $options: 'i' } }, { 'items.sku': { $regex: safe, $options: 'i' } }, { 'items.name': { $regex: safe, $options: 'i' } }];
      }
      const [items, count, totals] = await Promise.all([
        ActivityEvent.find(filter).sort({ occurredAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
        ActivityEvent.countDocuments(filter),
        ActivityEvent.aggregate([{ $match: filter }, { $group: { _id: null, salesTotal: { $sum: '$total' }, orderCount: { $sum: 1 }, unitsSold: { $sum: { $sum: '$items.quantity' } } } }]),
      ]);
      const summary = totals[0] || { salesTotal: 0, orderCount: 0, unitsSold: 0 };
      return response.json({ items, page, pageSize, count, pages: Math.max(1, Math.ceil(count / pageSize)), summary, retentionDays: auditRetentionDays });
    }
    const matching = demoActivityEvents.filter((event) => event.type === 'sale_created' && new Date(event.occurredAt) >= since && (!query || [event.orderNumber, event.customerName, event.actorName, ...event.items.flatMap((item) => [item.sku, item.name])].some((value) => String(value || '').toLowerCase().includes(query.toLowerCase()))));
    const start = (page - 1) * pageSize;
    const summary = matching.reduce((total, event) => ({ salesTotal: total.salesTotal + event.total, orderCount: total.orderCount + 1, unitsSold: total.unitsSold + event.items.reduce((sum, item) => sum + item.quantity, 0) }), { salesTotal: 0, orderCount: 0, unitsSold: 0 });
    return response.json({ items: matching.slice(start, start + pageSize), page, pageSize, count: matching.length, pages: Math.max(1, Math.ceil(matching.length / pageSize)), summary, retentionDays: auditRetentionDays });
  } catch (error) { return next(error); }
});

app.post('/api/orders', requireAuth, requireManager, async (request, response, next) => {
  try {
    const warehouse = String(request.body.warehouse || '').toUpperCase();
    const customer = { name: String(request.body.customer?.name || '').trim(), email: String(request.body.customer?.email || '').trim(), phone: String(request.body.customer?.phone || '').trim(), address: String(request.body.customer?.address || '').trim(), gstin: String(request.body.customer?.gstin || '').trim() };
    const lines = Array.isArray(request.body.items) ? request.body.items : [];
    const taxRate = gstRate;
    const shippingAmount = Math.max(0, Number(request.body.shippingAmount || 0));
    const paymentMethod = ['cash', 'card', 'upi', 'bank_transfer', 'credit'].includes(request.body.paymentMethod) ? request.body.paymentMethod : 'cash';
    const requestedPacker = String(request.body.packerId || '').trim();
    let packer = null;
    if (!requestedPacker) return response.status(400).json({ error: 'Assign this order to an approved packer at the selected warehouse.' });
    if (requestedPacker) {
      const found = dataSource === 'mongodb'
        ? await User.findOne({ _id: requestedPacker, active: true, approved: { $ne: false }, role: 'Packer', warehouse }).select('name phone email role warehouse approved active').lean()
        : demoUserStore.find((user) => user.id === requestedPacker && user.role === 'Packer' && user.approved !== false && user.active !== false && user.warehouse === warehouse);
      if (!found) return response.status(400).json({ error: 'Choose an approved packer from the selected warehouse.' });
      packer = cleanUser(found);
    }
    if (!['KG', 'SPB', 'BG', 'PB'].includes(warehouse) || !customer.name || !lines.length) return response.status(400).json({ error: 'Customer, warehouse, and at least one item are required.' });
    const orderItems = []; const seen = new Set();
    for (const line of lines) {
      const product = await findProductBySku(line.sku);
      const quantity = Math.floor(Number(line.quantity));
      if (!product || quantity < 1 || !Number.isFinite(quantity)) return response.status(400).json({ error: `Invalid product or quantity: ${line.sku}.` });
      if (seen.has(product.sku)) return response.status(400).json({ error: `Remove duplicate line ${product.sku} and update its quantity.` });
      seen.add(product.sku);
      const available = product.locations.filter((location) => location.warehouse === warehouse).reduce((sum, location) => sum + Number(location.qty || 0) - Number(location.reserved || 0), 0);
      if (quantity > available) return response.status(409).json({ error: `${product.sku} has only ${Math.max(0, available)} available at ${warehouse}.` });
      const unitPrice = Number(line.unitPrice ?? product.price);
      if (!Number.isFinite(unitPrice) || unitPrice < 0) return response.status(400).json({ error: `Invalid price for ${product.sku}.` });
      const gstIncluded = Boolean(product.priceIncludesGst);
      const lineTotal = money(unitPrice * quantity);
      const taxableAmount = money(gstIncluded ? lineTotal / (1 + gstRate / 100) : lineTotal);
    orderItems.push({ productId: dataSource === 'mongodb' ? product._id : product.id, sku: product.sku, name: product.name, brand: product.brand, unit: product.unit || 'PCS', quantity, unitPrice, lineTotal, taxableAmount, gstIncluded, gstRate, gstAmount: money(gstIncluded ? lineTotal - taxableAmount : taxableAmount * gstRate / 100), allocations: [] });
    }
    const subtotal = money(orderItems.reduce((sum, item) => sum + item.taxableAmount, 0)); const discountAmount = money(Math.min(subtotal, Math.max(0, Number(request.body.discountAmount || 0))));
    const taxAmount = money((subtotal - discountAmount) * taxRate / 100);
    const total = money(subtotal - discountAmount + taxAmount + shippingAmount); const amountPaid = Math.min(total, Math.max(0, Number(request.body.amountPaid ?? (paymentMethod === 'credit' ? 0 : total))));
    const order = { orderNumber: createOrderNumber('SO'), invoiceNumber: createOrderNumber('INV'), source: 'manual', createdById: request.user.id, createdByName: request.user.name, createdByRole: request.user.role, customer, warehouse, items: orderItems, subtotal, discountAmount, shippingAmount, taxRate, taxAmount, total, paymentMethod, amountPaid, paymentStatus: amountPaid >= total ? 'paid' : amountPaid > 0 ? 'partial' : 'unpaid', balanceDue: Math.max(0, total - amountPaid), status: 'ready_to_pack', statusHistory: [{ status: 'ready_to_pack', userId: request.user.id, userName: request.user.name, note: packer ? `Order created for ${packer.name}` : 'Order created and queued for packing' }], notes: String(request.body.notes || '').slice(0, 1000) };
    if (dataSource === 'mongodb') {
      const saved = await createAssignedOrder(order, packer);
      notifyPacker(packer, saved).catch((error) => console.warn('Packing push notification failed:', error.message));
      await invalidateSearchCache();
      return response.status(201).json({ order: saved });
    }
    const saved = { ...order, id: `o-${Date.now()}`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    reserveDemoOrder(saved, packer);
    demoOrders.unshift(saved);
    await recordActivityEvent('sale_created', saved, request.user);
    notifyPacker(packer, saved).catch((error) => console.warn('Packing push notification failed:', error.message));
    await invalidateSearchCache();
    return response.status(201).json({ order: normalizeOrder(saved) });
  } catch (error) { return next(error); }
});

app.post('/api/orders/:id/accept', requireAuth, async (request, response, next) => {
  try {
    if (request.user.role !== 'Packer' && !isAdmin(request.user)) return response.status(403).json({ error: 'Packer access required.' });
    let updated;
    if (dataSource === 'mongodb') updated = await reserveOrder(request.params.id, request.user);
    else { const order = demoOrders.find((item) => item.id === request.params.id); if (!order) return response.status(404).json({ error: 'Order not found.' }); if (request.user.role === 'Packer' && (order.assignedTo !== request.user.id || order.warehouse !== request.user.warehouse)) return response.status(403).json({ error: 'You can only accept orders assigned to you at your warehouse.' }); if (order.status !== 'ready_to_pack') return response.status(409).json({ error: 'This order is no longer waiting to be accepted.' }); updated = reserveDemoOrder(order, request.user); }
    await invalidateSearchCache(); return response.json({ order: updated });
  } catch (error) { return next(error); }
});

app.patch('/api/orders/:id/status', requireAuth, async (request, response, next) => {
  try {
    const target = String(request.body.status || ''); let updated;
    if (dataSource === 'mongodb') updated = await updateOrderStatus(request.params.id, target, request.user);
    else {
      const order = demoOrders.find((item) => item.id === request.params.id); if (!order) return response.status(404).json({ error: 'Order not found.' });
      if (!canManage(request.user) && (order.assignedTo !== request.user.id || order.warehouse !== request.user.warehouse)) return response.status(403).json({ error: 'You can only update orders assigned to you at your warehouse.' });
      const transitions = { accepted: ['packing'], packing: ['packed'], packed: ['shipped'], shipped: ['completed'] };
      if (target === 'cancelled' && ['ready_to_pack', 'accepted', 'packing'].includes(order.status)) { if (['accepted', 'packing'].includes(order.status)) cancelDemoReservation(order); }
      else if (!(transitions[order.status] || []).includes(target)) return response.status(409).json({ error: `Cannot move an order from ${order.status} to ${target}.` });
      if (target === 'packed') consumeDemoStock(order);
      order.status = target; order.updatedAt = new Date().toISOString(); if (target === 'packed') order.packedBy = request.user.name;
      order.statusHistory.push({ status: target, userId: request.user.id, userName: request.user.name, note: target === 'packed' ? 'Packing completed; stock deducted' : '', at: new Date() }); updated = order;
      if (target === 'packed') await recordActivityEvent('order_packed', order, request.user);
    }
    await invalidateSearchCache(); return response.json({ order: updated });
  } catch (error) { return next(error); }
});

app.get('/api/push/public-key', requireAuth, (request, response) => {
  if (request.user.role !== 'Packer') return response.status(403).json({ error: 'Packer access required.' });
  return response.json({ configured: pushConfigured, publicKey: pushConfigured ? process.env.VAPID_PUBLIC_KEY : '' });
});

app.post('/api/push/subscribe', requireAuth, async (request, response, next) => {
  try {
    if (request.user.role !== 'Packer') return response.status(403).json({ error: 'Packer access required.' });
    if (!pushConfigured) return response.status(503).json({ error: 'Push notifications are not configured on this server.' });
    const { endpoint, keys } = request.body || {};
    if (typeof endpoint !== 'string' || !endpoint.startsWith('https://') || typeof keys?.p256dh !== 'string' || typeof keys?.auth !== 'string') return response.status(400).json({ error: 'A valid browser push subscription is required.' });
    if (dataSource === 'mongodb') await PushSubscription.findOneAndUpdate({ endpoint }, { userId: request.user.id, endpoint, keys }, { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true });
    else {
      const existing = demoPushSubscriptions.find((entry) => entry.endpoint === endpoint);
      if (existing) { existing.userId = request.user.id; existing.keys = keys; }
      else demoPushSubscriptions.push({ userId: request.user.id, endpoint, keys });
    }
    return response.status(201).json({ enabled: true });
  } catch (error) { return next(error); }
});

app.delete('/api/push/subscribe', requireAuth, async (request, response, next) => {
  try {
    if (request.user.role !== 'Packer') return response.status(403).json({ error: 'Packer access required.' });
    const endpoint = String(request.body?.endpoint || '');
    if (dataSource === 'mongodb') await PushSubscription.deleteOne({ userId: request.user.id, endpoint });
    else demoPushSubscriptions = demoPushSubscriptions.filter((entry) => !(entry.userId === request.user.id && entry.endpoint === endpoint));
    return response.status(204).end();
  } catch (error) { return next(error); }
});

app.get('/api/orders/:id/photos', requireAuth, async (request, response, next) => {
  try {
    const order = await findAccessibleOrder(request.params.id, request.user);
    if (!order) return response.status(404).json({ error: 'Order not found.' });
    const photos = await getActivePhotos({ orderId: request.params.id });
    return response.json({ items: photos.map(photoMetadata) });
  } catch (error) { return next(error); }
});

app.post('/api/orders/:id/photos', requireAuth, async (request, response, next) => {
  try {
    if (request.user.role !== 'Packer') return response.status(403).json({ error: 'Only the assigned packer can upload packing photos.' });
    const order = await findAccessibleOrder(request.params.id, request.user);
    if (!order) return response.status(404).json({ error: 'Order not found.' });
    if (!['accepted', 'packing'].includes(order.status)) return response.status(409).json({ error: 'Packing photos can only be added while this order is being packed.' });
    const sku = String(request.body?.sku || '').trim().toUpperCase();
    const item = (order.items || []).find((line) => line.sku === sku);
    if (!item) return response.status(400).json({ error: 'Choose a product from this order.' });
    const dataUrl = String(request.body?.imageData || '');
    const match = dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!match) return response.status(400).json({ error: 'Upload a JPEG, PNG, or WebP image.' });
    const image = Buffer.from(match[2], 'base64');
    if (!image.length || image.length > 1_500_000) return response.status(413).json({ error: 'Packing photos must be smaller than 1.5 MB after compression.' });
    const mimeType = match[1];
    const validSignature = mimeType === 'image/jpeg' ? image[0] === 0xff && image[1] === 0xd8 : mimeType === 'image/png' ? image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) : image.subarray(0, 4).toString() === 'RIFF' && image.subarray(8, 12).toString() === 'WEBP';
    if (!validSignature) return response.status(400).json({ error: 'The uploaded file does not match its image type.' });
    const productId = String(item.productId || item.sku);
    const filter = { orderId: request.params.id, productId };
    const count = dataSource === 'mongodb'
      ? await PackingPhoto.countDocuments({ ...filter, $or: [{ keep: true }, { expiresAt: { $gt: new Date() } }] })
      : (await getActivePhotos(filter)).length;
    if (count >= 10) return response.status(409).json({ error: 'This product already has 10 packing photos for this order.' });
    const savedProduct = dataSource === 'mongodb' ? await Product.findById(productId).select('keepPackingPhotos').lean() : demoProductStore.find((product) => String(product.id) === productId);
    const keep = Boolean(savedProduct?.keepPackingPhotos);
    const values = { ...filter, sku, productName: item.name, warehouse: order.warehouse, packerId: request.user.id, packerName: request.user.name, mimeType, image, keep, expiresAt: keep ? null : new Date(Date.now() + photoRetentionMs) };
    const photo = dataSource === 'mongodb' ? await PackingPhoto.create(values) : (() => { const created = { ...values, id: `photo-${Date.now()}-${randomBytes(3).toString('hex')}`, imageData: `data:${mimeType};base64,${image.toString('base64')}`, createdAt: new Date() }; demoPackingPhotos.push(created); return created; })();
    return response.status(201).json({ photo: photoMetadata(photo) });
  } catch (error) { return next(error); }
});

app.get('/api/packing-photos/:id/image', requireAuth, async (request, response, next) => {
  try {
    const photo = dataSource === 'mongodb' && mongoose.isValidObjectId(request.params.id)
      ? await PackingPhoto.findOne({ _id: request.params.id, $or: [{ keep: true }, { expiresAt: { $gt: new Date() } }] }).lean()
      : dataSource === 'demo' ? (await getActivePhotos()).find((entry) => entry.id === request.params.id) : null;
    if (!photo) return response.status(404).json({ error: 'Packing photo not found or expired.' });
    const order = await findAccessibleOrder(photo.orderId, request.user);
    if (!order) return response.status(404).json({ error: 'Packing photo not found.' });
    response.setHeader('Content-Type', photo.mimeType); response.setHeader('Cache-Control', 'private, no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
    return response.send(dataSource === 'mongodb' ? photo.image : Buffer.from(photo.imageData.split(',')[1], 'base64'));
  } catch (error) { return next(error); }
});

app.patch('/api/products/:productId/packing-photos/keep', requireAuth, requireManager, async (request, response, next) => {
  try {
    const productId = String(request.params.productId || '').trim();
    if (!productId) return response.status(400).json({ error: 'Product ID is required.' });
    if (dataSource === 'mongodb') await Product.updateOne({ _id: productId }, { $set: { keepPackingPhotos: true } });
    else { const product = demoProductStore.find((entry) => String(entry.id) === productId); if (product) product.keepPackingPhotos = true; }
    const result = dataSource === 'mongodb'
      ? await PackingPhoto.updateMany({ productId }, { $set: { keep: true, expiresAt: null } })
      : (() => { let modifiedCount = 0; for (const photo of demoPackingPhotos) if (photo.productId === productId) { photo.keep = true; photo.expiresAt = null; modifiedCount += 1; } return { modifiedCount }; })();
    return response.json({ kept: result.modifiedCount });
  } catch (error) { return next(error); }
});

app.delete('/api/packing-photos/:id', requireAuth, requireManager, async (request, response, next) => {
  try {
    let deleted;
    if (dataSource === 'mongodb') {
      if (!mongoose.isValidObjectId(request.params.id)) return response.status(404).json({ error: 'Packing photo not found.' });
      deleted = (await PackingPhoto.deleteOne({ _id: request.params.id })).deletedCount;
    } else { const previousLength = demoPackingPhotos.length; demoPackingPhotos = demoPackingPhotos.filter((photo) => photo.id !== request.params.id); deleted = previousLength - demoPackingPhotos.length; }
    if (!deleted) return response.status(404).json({ error: 'Packing photo not found.' });
    return response.status(204).end();
  } catch (error) { return next(error); }
});

app.get('/api/reports/sales', requireAuth, requireManager, async (request, response, next) => {
  try {
    const from = request.query.from ? new Date(request.query.from) : new Date(Date.now() - 30 * 86_400_000);
    const to = request.query.to ? new Date(request.query.to) : new Date();
    const orders = dataSource === 'mongodb'
      ? (await Order.find({ createdAt: { $gte: from, $lte: to }, status: { $in: ['packed', 'shipped', 'completed'] } }).lean()).map(normalizeOrder)
      : demoOrders.filter((order) => ['packed', 'shipped', 'completed'].includes(order.status) && new Date(order.createdAt) >= from && new Date(order.createdAt) <= to);
    const bestSellers = new Map();
    for (const order of orders) for (const item of order.items) {
      const current = bestSellers.get(item.sku) || { sku: item.sku, name: item.name, units: 0, revenue: 0 };
      current.units += item.quantity; current.revenue += item.lineTotal; bestSellers.set(item.sku, current);
    }
    return response.json({ from: from.toISOString(), to: to.toISOString(), orderCount: orders.length, revenue: orders.reduce((sum, order) => sum + order.total, 0), itemsSold: orders.reduce((sum, order) => sum + order.items.reduce((lineSum, item) => lineSum + item.quantity, 0), 0), bestSellers: [...bestSellers.values()].sort((a, b) => b.units - a.units).slice(0, 20), orders });
  } catch (error) { return next(error); }
});

app.get('/api/integrations/woocommerce/status', requireAuth, requireManager, (_request, response) => response.json({ configured: Boolean(process.env.WOOCOMMERCE_URL && process.env.WOOCOMMERCE_CONSUMER_KEY && process.env.WOOCOMMERCE_CONSUMER_SECRET), storeUrl: process.env.WOOCOMMERCE_URL || '', defaultWarehouse: ['KG', 'SPB', 'BG', 'PB'].includes(process.env.WOOCOMMERCE_DEFAULT_WAREHOUSE) ? process.env.WOOCOMMERCE_DEFAULT_WAREHOUSE : 'KG' }));

app.post('/api/integrations/woocommerce/test', requireAuth, requireManager, async (_request, response, next) => {
  try {
    const products = await wooRequest('products?per_page=1&status=any');
    return response.json({ connected: true, storeUrl: process.env.WOOCOMMERCE_URL || '', message: `Connected to WooCommerce. Product access verified${products.length ? '.' : '; the store has no products yet.'}` });
  } catch (error) { return next(error); }
});

app.get('/api/integrations/woocommerce/products', requireAuth, requireManager, async (request, response, next) => {
  try {
    const page = Math.max(1, Math.floor(Number(request.query.page) || 1));
    const search = String(request.query.search || '').trim().slice(0, 100);
    const parameters = new URLSearchParams({ per_page: '25', page: String(page), status: 'any' });
    if (search) parameters.set('search', search);
    const items = await wooRequest(`products?${parameters.toString()}`);
    return response.json({ items: items.map(normalizeWooCatalogProduct), page, pageSize: 25, hasMore: items.length === 25 });
  } catch (error) { return next(error); }
});

app.get('/api/integrations/woocommerce/fitments/options', requireAuth, requireManager, async (request, response, next) => {
  try {
    const params = new URLSearchParams();
    for (const key of ['make', 'model']) { const value = String(request.query[key] || '').trim().slice(0, 100); if (value) params.set(key, value); }
    return response.json(await wooYmmRequest(`options?${params.toString()}`));
  } catch (error) { return next(error); }
});

app.get('/api/integrations/woocommerce/fitments/products', requireAuth, requireManager, async (request, response, next) => {
  try {
    const make = String(request.query.make || '').trim().slice(0, 100);
    const model = String(request.query.model || '').trim().slice(0, 150);
    const year = Math.floor(Number(request.query.year));
    if (!make || !model || !Number.isInteger(year) || year < 1886 || year > new Date().getFullYear() + 2) return response.status(400).json({ error: 'Choose a make, model, and valid year.' });
    const page = Math.max(1, Math.floor(Number(request.query.page) || 1));
    const fitment = await wooYmmRequest(`products?${new URLSearchParams({ make, model, year: String(year), page: String(page), per_page: '24' })}`);
    const ids = [...new Set((fitment.items || []).map((item) => Number(item.product_id)).filter(Number.isInteger))];
    if (!ids.length) return response.json({ items: [], total: Number(fitment.total || 0), page, pageSize: 24, pages: Number(fitment.pages || 0) });
    const storeItems = await wooRequest(`products?${new URLSearchParams({ include: ids.join(','), per_page: String(ids.length), status: 'publish' })}`);
    const byId = new Map(storeItems.map((item) => [Number(item.id), item]));
    const items = ids.map((id) => byId.get(id)).filter(Boolean).map(normalizeWooCatalogProduct);
    return response.json({ items, total: Number(fitment.total || items.length), page, pageSize: 24, pages: Number(fitment.pages || 1) });
  } catch (error) { return next(error); }
});

app.post('/api/integrations/woocommerce/products/pull', requireAuth, requireAdmin, async (_request, response, next) => {
  try {
    let page = 1; let imported = 0; const defaultWarehouse = process.env.WOOCOMMERCE_DEFAULT_WAREHOUSE || 'KG';
    if (!['KG', 'SPB', 'BG', 'PB'].includes(defaultWarehouse)) throw Object.assign(new Error('Invalid WOOCOMMERCE_DEFAULT_WAREHOUSE.'), { status: 500 });
    while (page <= 100) {
      const remote = await wooRequest(`products?per_page=100&page=${page}&status=publish`);
      if (!remote.length) break;
      for (const item of remote) {
        if (!item.sku) continue;
        const data = validateProduct({ sku: item.sku, name: item.name, brand: wcMeta(item, 'brand') || item.brands?.[0]?.name || 'Unbranded', category: item.categories?.[0]?.name || 'General', oe: String(wcMeta(item, 'oe_number') || '').split(/[|,;]/).filter(Boolean), price: Number(item.sale_price || item.regular_price || 0), barcode: wcMeta(item, 'barcode') || '', vehicleFitment: [], locations: [{ warehouse: defaultWarehouse, rack: process.env.WOOCOMMERCE_DEFAULT_RACK || 'G-1A', qty: 0 }] });
        const found = await findProductBySku(data.sku);
        if (found) {
          if (dataSource === 'mongodb') { found.wooCommerceId = item.id; found.name = data.name; found.brand = data.brand; found.category = data.category; found.oe = data.oe; found.price = data.price; await found.save(); }
          else Object.assign(found, data, { wooCommerceId: item.id });
        } else if (dataSource === 'mongodb') await Product.create({ ...data, wooCommerceId: item.id });
        else demoProductStore.push({ ...data, id: `woo-${item.id}`, wooCommerceId: item.id });
        imported += 1;
      }
      if (remote.length < 100) break; page += 1;
    }
    await invalidateSearchCache(); return response.json({ imported, message: `Imported or updated ${imported} WooCommerce products.` });
  } catch (error) { return next(error); }
});

app.post('/api/integrations/woocommerce/orders/pull', requireAuth, requireManager, async (request, response, next) => {
  try {
    const warehouse = String(request.body?.warehouse || process.env.WOOCOMMERCE_DEFAULT_WAREHOUSE || 'KG').toUpperCase();
    if (!['KG', 'SPB', 'BG', 'PB'].includes(warehouse)) return response.status(400).json({ error: 'Choose a valid default warehouse in WooCommerce settings.' });
    let page = 1; let imported = 0; let duplicates = 0; const warnings = [];
    while (page <= 100) {
      const remoteOrders = await wooRequest(`orders?per_page=100&page=${page}&status=processing`);
      if (!remoteOrders.length) break;
      for (const remote of remoteOrders) {
        const already = dataSource === 'mongodb' ? await Order.exists({ wooCommerceId: remote.id }) : demoOrders.some((order) => order.wooCommerceId === remote.id);
        if (already) { duplicates += 1; continue; }
        const items = [];
        for (const line of remote.line_items || []) {
          const quantity = Math.max(0, Math.floor(Number(line.quantity || 0)));
          if (!quantity) continue;
          const product = await findProductBySku(line.sku || '') || (dataSource === 'mongodb'
            ? await Product.findOne({ wooCommerceId: Number(line.product_id) })
            : demoProductStore.find((entry) => Number(entry.wooCommerceId) === Number(line.product_id)));
          const sku = String(line.sku || product?.sku || `WOO-${line.product_id}`).trim().toUpperCase();
          const lineTotal = Math.max(0, Number(line.total ?? (Number(line.price || 0) * quantity)));
          const unitPrice = quantity ? lineTotal / quantity : 0;
          items.push({ ...(product ? { productId: dataSource === 'mongodb' ? product._id : product.id } : {}), sku, name: product?.name || String(line.name || sku).slice(0, 160), brand: product?.brand || 'WooCommerce', unit: product?.unit || 'PCS', quantity, unitPrice, lineTotal, taxableAmount: Math.max(0, Number(line.subtotal ?? line.total ?? lineTotal)), gstIncluded: false, gstRate: 0, gstAmount: Math.max(0, Number(line.total_tax || 0)), allocations: [] });
        }
        if (!items.length) { warnings.push(`WooCommerce order ${remote.id} has no usable product lines.`); continue; }
        const subtotal = (remote.line_items || []).reduce((sum, line) => sum + Math.max(0, Number(line.subtotal || line.total || 0)), 0);
        const discountedSubtotal = items.reduce((sum, item) => sum + item.lineTotal, 0);
        const discountAmount = Math.max(0, Number(remote.discount_total || Math.max(0, subtotal - discountedSubtotal)));
        const shippingAmount = (remote.shipping_lines || []).reduce((sum, line) => sum + Number(line.total || 0), 0);
        const taxAmount = (remote.tax_lines || []).reduce((sum, line) => sum + Number(line.tax_total || 0), 0) || items.reduce((sum, item) => sum + item.gstAmount, 0);
        const total = Number(remote.total || (discountedSubtotal + shippingAmount + taxAmount));
        const customerName = `${remote.billing?.first_name || ''} ${remote.billing?.last_name || ''}`.trim() || 'WooCommerce customer';
        const order = { orderNumber: `WC-${remote.id}`, invoiceNumber: createOrderNumber('INV'), source: 'woocommerce', createdById: request.user.id, createdByName: request.user.name, createdByRole: request.user.role, wooCommerceId: remote.id, customer: { name: customerName, email: remote.billing?.email || '', phone: remote.billing?.phone || '', address: [remote.billing?.address_1, remote.billing?.address_2, remote.billing?.city, remote.billing?.state, remote.billing?.postcode].filter(Boolean).join(', '), gstin: '' }, warehouse, items, subtotal, discountAmount, shippingAmount, taxRate: subtotal ? Number(((taxAmount / subtotal) * 100).toFixed(2)) : 0, taxAmount, total, paymentMethod: 'woocommerce', paymentStatus: 'paid', amountPaid: total, balanceDue: 0, status: 'ready_to_pack', assignedTo: '', assignedName: '', statusHistory: [{ status: 'ready_to_pack', userId: request.user.id, userName: request.user.name, note: 'Received from website; waiting for warehouse and packer assignment' }] };
        let created;
        if (dataSource === 'mongodb') [created] = await Order.create([order]);
        else { created = { ...order, id: `woo-order-${remote.id}`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; demoOrders.unshift(created); }
        await recordActivityEvent('sale_created', created, request.user);
        imported += 1;
      }
      if (remoteOrders.length < 100) break; page += 1;
    }
    const message = imported ? `Imported ${imported} processing website order${imported === 1 ? '' : 's'} to Website Orders. Assign each order a warehouse and packer there.` : duplicates ? `No new processing website orders. ${duplicates} already imported.` : 'No processing website orders were found.';
    return response.json({ imported, duplicates, warnings, message });
  } catch (error) { return next(error); }
});

if (production) {
  const frontendDirectory = path.resolve(appDirectory, '../dist');
  app.use(express.static(frontendDirectory, { index: false, maxAge: '1y', immutable: true }));
  app.get(/^\/(?!api\/).*/, (_request, response, next) => response.sendFile(path.join(frontendDirectory, 'index.html'), (error) => error && next(error)));
}

app.use((error, _request, response, _next) => {
  if (error?.code === 11000) return response.status(409).json({ error: 'A record with that SKU, barcode or order number already exists.' });
  console.error('API request failed:', error);
  response.status(error.status || 500).json({ error: error.status ? error.message : 'The request could not be completed.' });
});

let server;
let sessionSweepTimer;
async function start() {
  if (process.env.MONGODB_URI) {
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000, autoIndex: !production }); dataSource = 'mongodb';
    await Promise.all([Product.createIndexes(), User.createIndexes(), Order.createIndexes(), Rack.createIndexes(), PackingPhoto.createIndexes(), PushSubscription.createIndexes(), ActivityEvent.createIndexes(), UserSession.createIndexes()]);
    await User.updateMany({ role: 'Sales Person' }, { $set: { role: 'Packer', approved: true, active: true } });
    if (process.env.BOOTSTRAP_ADMIN_EMAIL && process.env.BOOTSTRAP_ADMIN_PASSWORD) {
      const email = process.env.BOOTSTRAP_ADMIN_EMAIL.toLowerCase();
      if (!(await User.exists({ email }))) await User.create({ name: process.env.BOOTSTRAP_ADMIN_NAME || 'System Admin', email, role: 'Admin', passwordHash: await bcrypt.hash(process.env.BOOTSTRAP_ADMIN_PASSWORD, 12) });
    }
    console.info('Connected to MongoDB.');
  }
  await sweepLostSessions();
  sessionSweepTimer = setInterval(() => sweepLostSessions().catch((error) => console.warn('Session cleanup failed:', error.message)), 60_000);
  sessionSweepTimer.unref();
  if (process.env.REDIS_URL) {
    redisClient = createClient({ url: process.env.REDIS_URL }); redisClient.on('error', (error) => console.error('Redis connection error:', error.message)); await redisClient.connect(); console.info('Connected to Redis.');
  }
  if (dataSource === 'demo') console.info('MONGODB_URI is unset; demo records are held in server memory.');
  server = app.listen(port, host, () => console.info(`Stockroom API listening on http://${host}:${port}`));
}

async function shutdown(signal) {
  console.info(`Received ${signal}; shutting down.`);
  if (sessionSweepTimer) clearInterval(sessionSweepTimer);
  if (server) await new Promise((resolve) => server.close(resolve));
  if (redisClient?.isOpen) await redisClient.quit(); if (mongoose.connection.readyState) await mongoose.disconnect(); process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT')); process.on('SIGTERM', () => shutdown('SIGTERM'));
start().catch((error) => { console.error('Stockroom API failed to start:', error.message); process.exit(1); });
