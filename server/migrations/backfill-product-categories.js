import 'dotenv/config';
import mongoose from 'mongoose';
import { createClient } from 'redis';
import { Product } from '../models/Product.js';

const apply = process.argv.includes('--apply');
const legacyCategory = (value) => value == null || String(value).trim() === '' || /^general$/i.test(String(value).trim());

try {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not configured.');
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
  const filter = {
    name: { $type: 'string', $ne: '' },
    $or: [{ category: { $exists: false } }, { category: null }, { category: '' }, { category: { $regex: '^general$', $options: 'i' } }],
  };
  const count = await Product.countDocuments(filter);
  const samples = await Product.find(filter).select('name category sku brand').limit(8).lean();
  console.log(`${apply ? 'Applying' : 'Preview'}: ${count.toLocaleString()} products have a name and a blank/General category.`);
  console.log('Sample changes:', JSON.stringify(samples.map(({ name, category, sku, brand }) => ({ sku, brand, oldCategory: category || '(blank)', newCategory: name }))));
  if (!apply) {
    console.log('No database changes made. Run with --apply to copy legacy product names into category.');
  } else {
    let operations = [];
    let updated = 0;
    const cursor = Product.find(filter).select('_id name category').lean().cursor({ batchSize: 500 });
    for await (const product of cursor) {
      if (!legacyCategory(product.category)) continue;
      operations.push({ updateOne: {
        filter: { _id: product._id, name: product.name, category: product.category ?? null },
        update: { $set: { category: product.name.trim().slice(0, 100) } },
      } });
      if (operations.length === 500) {
        const result = await Product.bulkWrite(operations, { ordered: false });
        updated += result.modifiedCount;
        operations = [];
      }
    }
    if (operations.length) {
      const result = await Product.bulkWrite(operations, { ordered: false });
      updated += result.modifiedCount;
    }
    console.log(`Category backfill complete: ${updated.toLocaleString()} product categories updated. Product names and IDs were preserved.`);
    if (process.env.REDIS_URL) {
      const redis = createClient({ url: process.env.REDIS_URL });
      redis.on('error', () => {});
      try {
        await redis.connect();
        await redis.incr('stockroom:cache:products:version');
        console.log('Product search and inventory caches invalidated.');
      } catch {
        console.log('Redis cache invalidation was unavailable; cached views will refresh when their TTL expires.');
      } finally {
        if (redis.isOpen) await redis.quit().catch(() => {});
      }
    }
  }
} catch {
  console.error('Category migration could not connect or complete. Check the database configuration; no credentials were printed.');
  process.exitCode = 1;
} finally {
  await mongoose.disconnect().catch(() => {});
}
