import 'dotenv/config';
import mongoose from 'mongoose';
import { createClient } from 'redis';
import { Product } from '../models/Product.js';
import { ProductCounter } from '../models/ProductCounter.js';

const apply = process.argv.includes('--apply');
const categoryMatchesName = (name, category) => String(name || '').trim().toLocaleUpperCase() === String(category || '').trim().toLocaleUpperCase();

try {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not configured.');
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
  const missingFilter = { $or: [{ productNumber: { $exists: false } }, { productNumber: null }] };
  const missingCount = await Product.countDocuments(missingFilter);
  const highest = await Product.findOne({ productNumber: { $type: 'number' } }).sort({ productNumber: -1 }).select('productNumber').lean();
  const firstNumber = Number(highest?.productNumber || 0) + 1;
  const namesCursor = Product.find({ name: { $type: 'string', $ne: '' }, category: { $type: 'string', $ne: '' } }).select('name category sku brand').lean().cursor({ batchSize: 500 });
  const nameSamples = []; let namesToClear = 0;
  for await (const product of namesCursor) if (categoryMatchesName(product.name, product.category)) {
    namesToClear += 1;
    if (nameSamples.length < 8) nameSamples.push({ sku: product.sku, brand: product.brand, name: product.name, category: product.category });
  }
  console.log(`${apply ? 'Applying' : 'Preview'}: assign ${missingCount.toLocaleString()} numeric IDs, starting at ${firstNumber.toLocaleString('en-IN')}.`);
  console.log(`${namesToClear.toLocaleString()} names exactly match Category and will be cleared; custom names with a different category are kept.`);
  console.log('Sample names to clear:', JSON.stringify(nameSamples));
  if (!apply) {
    console.log('No database changes made. Run with --apply to assign product numbers and clear transferred names.');
  } else {
    let nextNumber = firstNumber;
    let operations = [];
    const missingCursor = Product.find(missingFilter).select('_id').sort({ _id: 1 }).lean().cursor({ batchSize: 500 });
    for await (const product of missingCursor) {
      operations.push({ updateOne: { filter: { _id: product._id, ...missingFilter }, update: { $set: { productNumber: nextNumber++ } }, overwriteImmutable: true } });
      if (operations.length === 500) {
        await Product.bulkWrite(operations, { ordered: false });
        operations = [];
      }
    }
    if (operations.length) await Product.bulkWrite(operations, { ordered: false });

    let clearedNames = 0;
    operations = [];
    const nameCursor = Product.find({ name: { $type: 'string', $ne: '' }, category: { $type: 'string', $ne: '' } }).select('_id name category').lean().cursor({ batchSize: 500 });
    for await (const product of nameCursor) {
      if (!categoryMatchesName(product.name, product.category)) continue;
      operations.push({ updateOne: { filter: { _id: product._id, name: product.name, category: product.category }, update: { $set: { name: '' } } } });
      if (operations.length === 500) {
        const result = await Product.bulkWrite(operations, { ordered: false });
        clearedNames += result.modifiedCount;
        operations = [];
      }
    }
    if (operations.length) {
      const result = await Product.bulkWrite(operations, { ordered: false });
      clearedNames += result.modifiedCount;
    }

    const finalHighest = await Product.findOne({ productNumber: { $type: 'number' } }).sort({ productNumber: -1 }).select('productNumber').lean();
    await ProductCounter.updateOne({ _id: 'products' }, { $max: { value: Number(finalHighest?.productNumber || 0) } }, { upsert: true });
    await Product.createIndexes();
    console.log(`Assigned ${missingCount.toLocaleString()} product numbers. Cleared ${clearedNames.toLocaleString()} transferred legacy names; categories and internal MongoDB IDs are preserved.`);

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
  console.error('Product ID migration could not connect or complete. Check database configuration; credentials were not printed.');
  process.exitCode = 1;
} finally {
  await mongoose.disconnect().catch(() => {});
}
