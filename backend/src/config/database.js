import mongoose from 'mongoose';
import { env } from './environment.js';

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

export async function disconnectDatabase() {
  await mongoose.disconnect();
}

export function databaseIsReady() {
  return mongoose.connection.readyState === 1;
}
