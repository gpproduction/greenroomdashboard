// Loads .env from the app folder (if present) before any other module reads process.env.
// Variables already set in the real environment win.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
if (fs.existsSync(file) && typeof process.loadEnvFile === 'function') process.loadEnvFile(file);
