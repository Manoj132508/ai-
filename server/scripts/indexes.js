/**
 * Compare the indexes declared in code against those that actually exist.
 *
 *   npm run indexes           report drift
 *   npm run indexes -- --sync create anything missing
 *
 * WHY THIS EXISTS
 *
 * `autoIndex` is disabled in production (see config/db.js), because building
 * an index on a large collection blocks and can stall a deploy. That is the
 * right call, but it means production indexes no longer follow the code
 * automatically -- so a developer can add an index, see it work locally, and
 * ship a query that does a full collection scan in production.
 *
 * Turning off automatic index creation without a way to verify indexes is how
 * that happens. This script is the other half of that decision.
 */
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../config/db.js';
import '../models/index.js';

const SYNC = process.argv.includes('--sync');

/** Renders { userId: 1, createdAt: -1 } as "userId:1, createdAt:-1". */
function describe(key) {
  return Object.entries(key)
    .map(([field, direction]) => `${field}:${direction}`)
    .join(', ');
}

async function report() {
  await connectDatabase();

  let missing = 0;

  for (const modelName of mongoose.modelNames()) {
    const model = mongoose.model(modelName);
    const collection = model.collection.collectionName;

    // What the schema asks for, and what the database actually has.
    const declared = model.schema.indexes(); // [[key, options], ...]
    const existing = await model.collection.indexes().catch(() => []);
    const existingKeys = new Set(existing.map((idx) => JSON.stringify(idx.key)));

    console.log(`\n${collection}`);

    // _id is created implicitly by MongoDB and is never declared in a schema.
    for (const idx of existing.filter((i) => i.name === '_id_')) {
      console.log(`  [implicit] ${describe(idx.key)}`);
    }

    for (const [key, options] of declared) {
      const present = existingKeys.has(JSON.stringify(key));
      if (!present) missing += 1;
      const flags = options?.unique ? ' (unique)' : '';
      console.log(`  ${present ? '[ok]      ' : '[MISSING] '}${describe(key)}${flags}`);
    }

    // An index in the database that no schema declares -- usually a leftover
    // from a removed query. Worth surfacing: it still costs write throughput
    // and disk on every insert.
    for (const idx of existing) {
      if (idx.name === '_id_') continue;
      const isDeclared = declared.some(([key]) => JSON.stringify(key) === JSON.stringify(idx.key));
      if (!isDeclared) console.log(`  [ORPHAN]  ${describe(idx.key)} -- not declared in any schema`);
    }
  }

  if (missing > 0) {
    console.log(`\n${missing} index(es) missing.`);
    if (SYNC) {
      console.log('Creating them...');
      for (const modelName of mongoose.modelNames()) {
        await mongoose.model(modelName).createIndexes();
      }
      console.log('Done.');
    } else {
      console.log('Re-run with --sync to create them.');
    }
  } else {
    console.log('\nAll declared indexes present.');
  }

  await disconnectDatabase();
}

report().catch(async (err) => {
  console.error('\nIndex check failed:', err.message);
  await disconnectDatabase().catch(() => {});
  process.exit(1);
});
