/**
 * AarohCare Backend — Appointment Token Unique Index Migration & Audit Script
 *
 * Why this script is needed:
 * 1. Safely audits existing MongoDB appointments for duplicate (doctorId, date, tokenNumber) combinations
 *    among active bookings [PENDING, CONSULTING, COMPLETED].
 * 2. Enforces strict zero-data-loss safety: Never automatically alters, deletes, or merges historical data.
 * 3. Aborts index creation if any duplicate tokens exist, providing an actionable manual resolution plan.
 * 4. Once verified clean, idempotently creates the partial unique index compatible with MongoDB and Atlas.
 *
 * Usage:
 *   Audit only:    npx tsx scripts/migrateAppointmentTokenIndex.ts --audit-only
 *   Audit & Apply: npx tsx scripts/migrateAppointmentTokenIndex.ts
 */

import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/aarohcare';
const isAuditOnly = process.argv.includes('--audit-only');

const TARGET_INDEX_NAME = 'doctorId_1_date_1_tokenNumber_1';
const TARGET_INDEX_SPEC = {
  key: { doctorId: 1, date: 1, tokenNumber: 1 },
  options: {
    unique: true,
    partialFilterExpression: {
      tokenNumber: { $exists: true, $type: 'string' },
      status: { $in: ['PENDING', 'CONSULTING', 'COMPLETED'] },
    },
    name: TARGET_INDEX_NAME,
  },
};

interface DuplicateGroup {
  _id: {
    doctorId: mongoose.Types.ObjectId;
    date: string;
    tokenNumber: string;
  };
  count: number;
  appointments: Array<{
    id: mongoose.Types.ObjectId;
    status: string;
    paymentStatus?: string;
    createdAt?: Date;
  }>;
}

async function run(): Promise<void> {
  console.log('============================================================');
  console.log(' AarohCare — Appointment Token Index Audit & Migration');
  console.log('============================================================');
  console.log(`Target MongoDB URI: ${MONGO_URI.replace(/\/\/([^:]+):([^@]+)@/, '//$1:****@')}`);
  console.log(`Execution Mode:    ${isAuditOnly ? 'READ-ONLY AUDIT ONLY' : 'AUDIT & IDEMPOTENT MIGRATION'}`);
  console.log('------------------------------------------------------------');

  await mongoose.connect(MONGO_URI);
  const coll = mongoose.connection.db!.collection('appointments');

  console.log('[Step 1/3] Scanning database for duplicate active appointment tokens...');

  const duplicatePipeline = [
    {
      $match: {
        tokenNumber: { $exists: true, $type: 'string' },
        status: { $in: ['PENDING', 'CONSULTING', 'COMPLETED'] },
      },
    },
    {
      $group: {
        _id: {
          doctorId: '$doctorId',
          date: '$date',
          tokenNumber: '$tokenNumber',
        },
        count: { $sum: 1 },
        // Why this change is needed: Avoid logging patient personal information (PII) in audit and migration logs.
        // Captures only technical record identifiers and status needed for authorized operator review.
        appointments: {
          $push: {
            id: '$_id',
            status: '$status',
            paymentStatus: '$paymentStatus',
            createdAt: '$createdAt',
          },
        },
      },
    },
    {
      $match: {
        count: { $gt: 1 },
      },
    },
    {
      $sort: {
        '_id.date': -1 as const,
        '_id.doctorId': 1 as const,
      },
    },
  ];

  const duplicates = (await coll.aggregate(duplicatePipeline).toArray()) as unknown as DuplicateGroup[];

  if (duplicates.length > 0) {
    console.error('\n🚨 AUDIT FAILED: CONFLICTING APPOINTMENT TOKENS DETECTED');
    console.error(`Found ${duplicates.length} conflicting token group(s) across active bookings:\n`);

    for (const group of duplicates) {
      console.error(`• Doctor ID:    ${group._id.doctorId}`);
      console.error(`  Date:         ${group._id.date}`);
      console.error(`  Token Number: "${group._id.tokenNumber}"`);
      console.error(`  Duplicates:   ${group.count} appointments`);
      console.error('  Conflicting Records:');
      for (const appt of group.appointments) {
        console.error(
          `    - ID: ${appt.id} | Status: ${appt.status} | Payment: ${appt.paymentStatus || 'N/A'} | Created: ${appt.createdAt ? new Date(appt.createdAt).toISOString() : 'N/A'}`,
        );
      }
      console.error('');
    }

    console.error('============================================================');
    console.error('🛑 INDEX CREATION BLOCKED FOR SAFETY');
    console.error('Why this migration cannot proceed:');
    console.error('MongoDB rejects unique index builds with E11000 duplicate key error when conflicting data exists.');
    console.error('To preserve historical data integrity, this script will NOT automatically mutate or delete any records.');
    console.error('\nManual Resolution Plan:');
    console.error('1. Review the conflicting appointments above with facility administration.');
    console.error('2. Determine which appointment legitimately owns the token.');
    console.error('3. For the redundant/abandoned appointment, update its status to "CANCELLED", or reassign its token.');
    console.error('4. Re-run "npm run audit:token-index" to confirm all conflicts are resolved.');
    console.error('5. Re-run "npm run migrate:token-index" to safely create the index.');
    console.error('============================================================');

    await mongoose.disconnect();
    process.exit(1);
  }

  console.log('✅ [Audit Passed] Zero duplicate active tokens found across all records.');

  if (isAuditOnly) {
    console.log('\n[Result] Audit completed successfully in read-only mode.');
    console.log('The database is verified ready for unique index creation.');
    await mongoose.disconnect();
    process.exit(0);
  }

  console.log('\n[Step 2/3] Checking existing database indexes...');
  // Why this change is needed: If the appointments collection does not exist yet (e.g. freshly initialized staging database),
  // MongoDB driver throws NamespaceNotFound (code 26). Safely return an empty array so createIndex can initialize it.
  const getExistingIndexes = async () => {
    try {
      return await coll.indexes();
    } catch (err: any) {
      if (err?.code === 26 || err?.codeName === 'NamespaceNotFound') {
        return [];
      }
      throw err;
    }
  };
  const existingIndexes = await getExistingIndexes();
  const existingTarget = existingIndexes.find((idx) => idx.name === TARGET_INDEX_NAME);

  if (existingTarget) {
    console.log(`ℹ️ Index "${TARGET_INDEX_NAME}" already exists on collection "appointments".`);
    console.log('Specification:', JSON.stringify(existingTarget, null, 2));
    console.log('\n✅ [Result] Migration complete. Index is already present and active (Idempotent).');
    await mongoose.disconnect();
    process.exit(0);
  }

  console.log('\n[Step 3/3] Creating partial unique index on MongoDB...');
  console.log(`Index Name: ${TARGET_INDEX_NAME}`);
  console.log('Keys:      ', JSON.stringify(TARGET_INDEX_SPEC.key));
  console.log('Filter:    ', JSON.stringify(TARGET_INDEX_SPEC.options.partialFilterExpression));

  const result = await coll.createIndex(
    TARGET_INDEX_SPEC.key,
    TARGET_INDEX_SPEC.options,
  );
  console.log(`Index successfully created: ${result}`);

  // Post-creation verification
  const verifiedIndexes = await coll.indexes();
  const verifiedTarget = verifiedIndexes.find((idx) => idx.name === TARGET_INDEX_NAME);
  if (!verifiedTarget) {
    console.error('❌ Verification failed: Index was not found after createIndex call!');
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log('============================================================');
  console.log('🎉 SUCCESS: Partial unique index created and verified!');
  console.log(`Verified index: ${TARGET_INDEX_NAME} (unique: ${Boolean(verifiedTarget.unique)})`);
  console.log('============================================================');

  await mongoose.disconnect();
  process.exit(0);
}

run().catch(async (error) => {
  console.error('💥 Fatal error during index migration:', error);
  try {
    await mongoose.disconnect();
  } catch {
    // Ignore disconnect error during fatal exit
  }
  process.exit(1);
});
