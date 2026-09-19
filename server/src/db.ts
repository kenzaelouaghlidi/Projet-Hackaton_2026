import dotenv from 'dotenv';
dotenv.config();

import { Pool } from 'pg';

export const db = new Pool({
  connectionString: process.env.DATABASE_URL,
});