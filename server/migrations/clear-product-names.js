import 'dotenv/config';
import mongoose from 'mongoose';
import { createClient } from 'redis';
import { Product } from '../models/Product.js';

const apply = process.argv.includes('--apply');
const nonemptyName = { name: { $type: 'string', $ne: '' } };

try {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not configured.');
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });

  const count = await Product.countDocuments(nonemptyName);
  const samples = await Product.find(nonemptyName)
    .select('productNumber brand sku name category')
    .limit(8)
    .lean();

  console.log(`${apply ? 'Applying' : 'Preview'}: clear the stored name on ${count.toLocaleString()} products.`);
  console.log('Category, brand, SKU, stock, and generated product IDs will be preserved.');
  console.log('Sample affected products:', JSON.stringify(samples.map(({ productNumber, brand, sku, name, category }) => ({ productNumber, brand, sku, name, category }))));

  if (!apply) {
    console.log('No database changes made. Run with --apply to clear these names.');
  } else {
    const result = await Product.updateMany(nonemptyName, { $set: { name: '' } });
    console.log(`Cleared ${Number(result.modifiedCount || 0).toLocaleString()} product names; category data was retained.`);

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
  console.error('Product name cleanup could not connect or complete. Check database configuration; credentials were not printed.');
  process.exitCode = 1;
} finally {
  await mongoose.disconnect().catch(() => {});
}
