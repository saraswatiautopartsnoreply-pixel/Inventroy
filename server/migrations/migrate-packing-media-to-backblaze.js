import 'dotenv/config';
import mongoose from 'mongoose';
import { PackingPhoto } from '../models/PackingPhoto.js';
import { uploadBackblazeMedia } from '../storage/backblaze.js';

const apply = process.argv.includes('--apply');
const hasImage = { image: { $exists: true, $ne: null } };
const mediaTypes = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
};

function mediaBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (Buffer.isBuffer(value?.buffer)) return Buffer.from(value.buffer.subarray(0, value.position ?? value.buffer.length));
  if (typeof value?.value === 'function') {
    const buffer = value.value(true);
    if (Buffer.isBuffer(buffer)) return buffer;
  }
  return Buffer.alloc(0);
}

try {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not configured.');
  if (apply && (!process.env.BACKBLAZE_KEY_ID || !process.env.BACKBLAZE_APPLICATION_KEY || !process.env.BACKBLAZE_BUCKET_ID)) {
    throw new Error('Set BACKBLAZE_KEY_ID, BACKBLAZE_APPLICATION_KEY, and BACKBLAZE_BUCKET_ID on the server before applying.');
  }
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });

  const filter = { ...hasImage, storageProvider: { $ne: 'backblaze' } };
  const total = await PackingPhoto.countDocuments(filter);
  console.log(`${apply ? 'Migrating' : 'Preview'}: ${total.toLocaleString()} existing packing media file(s) in MongoDB.`);
  console.log('Each file is uploaded to Backblaze first; MongoDB metadata and media are changed only after that upload succeeds.');
  if (!apply) {
    console.log('No database or storage changes made. Run with --apply to upload and move the existing media.');
  } else {
    const collection = mongoose.connection.collection(PackingPhoto.collection.collectionName);
    const indexes = await collection.indexes();
    const ttlIndex = indexes.find((index) => index.key?.expiresAt === 1 && index.expireAfterSeconds !== undefined);
    if (ttlIndex) await collection.dropIndex(ttlIndex.name);
    await PackingPhoto.createIndexes();

    let uploaded = 0;
    let failed = 0;
    const cursor = PackingPhoto.find(filter).select('_id mimeType image').lean().cursor({ batchSize: 1 });
    for await (const photo of cursor) {
      try {
        const mimeType = String(photo.mimeType || '');
        const extension = mediaTypes[mimeType];
        const body = mediaBuffer(photo.image);
        if (!extension || !body.length) throw new Error('Unsupported or empty media data.');
        const storageFileName = `packing-media/${String(photo._id)}.${extension}`;
        const stored = await uploadBackblazeMedia({ body, contentType: mimeType, fileName: storageFileName });
        const result = await PackingPhoto.updateOne(
          { _id: photo._id, storageProvider: { $ne: 'backblaze' }, ...hasImage },
          { $set: { storageProvider: 'backblaze', storageFileId: stored.fileId, storageFileName }, $unset: { image: 1 } },
        );
        if (result.modifiedCount) uploaded += 1;
      } catch (error) {
        failed += 1;
        console.error(`Could not migrate media ${String(photo._id)}: ${error.message}`);
      }
      const completed = uploaded + failed;
      if (completed % 25 === 0 || completed === total) console.log(`Processed ${completed.toLocaleString()} of ${total.toLocaleString()} · uploaded ${uploaded.toLocaleString()} · failed ${failed.toLocaleString()}`);
    }
    console.log(`Finished: ${uploaded.toLocaleString()} migrated, ${failed.toLocaleString()} failed. Failed records retain their MongoDB media and can be retried.`);
    if (failed) process.exitCode = 1;
  }
} catch (error) {
  console.error(`Backblaze media migration could not complete: ${error.message}`);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect().catch(() => {});
}
