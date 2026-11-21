import 'dotenv/config';
import mongoose from 'mongoose';
import { demoProducts } from '../src/data.js';
import { Product } from './models/Product.js';

if (!process.env.MONGODB_URI) throw new Error('Set MONGODB_URI before running the demo seed.');

try {
  await mongoose.connect(process.env.MONGODB_URI);
  const operations = demoProducts.map(({ id: _id, updatedAt: _updatedAt, ...product }) => ({
    updateOne: { filter: { sku: product.sku }, update: { $setOnInsert: product }, upsert: true },
  }));
  const result = await Product.bulkWrite(operations, { ordered: false });
  console.info(`Seed complete. Inserted ${result.upsertedCount} demo products; existing SKUs were left as-is.`);
} finally {
  await mongoose.disconnect();
}
