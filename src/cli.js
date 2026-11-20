#!/usr/bin/env node
// Maintenance commands. In Docker:
//   docker compose exec openpad node src/cli.js address                     show it
//   docker compose exec openpad node src/cli.js address notes.example.com   change it
//   docker compose exec openpad node src/cli.js address --reset             ask again on the home page

import { ADDRESS_SETTING, normalizeAddress } from './address.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db.js';

const [command, value] = process.argv.slice(2);
const config = loadConfig();

function usage() {
  console.log(`Usage:
  node src/cli.js address                 show the public address
  node src/cli.js address <host or URL>   change it (e.g. notes.example.com)
  node src/cli.js address --reset         forget it; the home page asks again`);
}

if (command !== 'address') {
  usage();
  process.exit(command ? 1 : 0);
}

const db = openDatabase(config.dbPath);
try {
  if (value === undefined) {
    const stored = db.getSetting(ADDRESS_SETTING);
    if (config.publicAddress) console.log(`${config.publicAddress} (from PUBLIC_ADDRESS)`);
    else console.log(stored ?? 'Not set yet: the home page will ask for it.');
  } else if (value === '--reset') {
    db.deleteSetting(ADDRESS_SETTING);
    console.log('Address forgotten. The home page will ask for it again.');
  } else {
    const parsed = normalizeAddress(value);
    if (!parsed.ok) {
      console.error(`Not a valid address: "${value}". Use a domain or IP, with an optional port and http(s)://.`);
      process.exitCode = 1;
    } else {
      db.putSetting(ADDRESS_SETTING, parsed.origin);
      console.log(`Saved: ${parsed.origin}`);
    }
  }
  if (config.publicAddress && value !== undefined) {
    console.log('Note: PUBLIC_ADDRESS is set, and it takes precedence over the stored address.');
  }
} finally {
  db.close();
}
