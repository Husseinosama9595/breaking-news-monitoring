import mongoose from 'mongoose';
import { env } from './environment.js';
import MonitoredAccount from '../models/MonitoredAccount.js';

const COUNTRY_MONITORING_INDEX_KEYS = Object.freeze({ platform: 1, countryCode: 1, enabled: 1, monitoringStatus: 1 });
const COUNTRY_MONITORING_INDEX_OPTIONS = Object.freeze({ name: 'account_country_monitoring' });

/** Parse the configured Mongo database name without opening a connection. */
export function resolveMongoDatabaseName(mongoUri = env.mongoUri) {
  let uri;
  try { uri = new URL(mongoUri); } catch {
    throw new TypeError('MONGODB_URI must be a valid MongoDB connection URI');
  }
  const path = uri.pathname.startsWith('/') ? uri.pathname.slice(1) : uri.pathname;
  let databaseName;
  try { databaseName = decodeURIComponent(path.split('/')[0] ?? ''); } catch {
    throw new TypeError('MONGODB_URI must contain a valid encoded database name');
  }
  if (databaseName.length === 0) throw new TypeError('MONGODB_URI must include a database name for queue isolation');
  return databaseName;
}

export async function connectDatabase() {
  mongoose.set('strictQuery', true);
  await mongoose.connect(env.mongoUri, {
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 5000,
  });
  return mongoose.connection;
}

/** Ensure the country-query index exists before the HTTP server begins accepting requests. */
export async function ensureCountryMonitoringIndex({ collection = MonitoredAccount.collection } = {}) {
  return collection.createIndex(COUNTRY_MONITORING_INDEX_KEYS, COUNTRY_MONITORING_INDEX_OPTIONS);
}

export async function disconnectDatabase() {
  await mongoose.disconnect();
}

export function databaseIsReady() {
  return mongoose.connection.readyState === 1;
}
