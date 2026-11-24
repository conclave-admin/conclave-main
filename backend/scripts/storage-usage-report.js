#!/usr/bin/env node
require("dotenv").config();
const { pool } = require("../src/config/db");
const { getStorageOverview } = require("../src/services/storageMonitor.service");

async function main() {
  try {
    const report = await getStorageOverview();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.alerts.storageThresholdExceeded || report.alerts.storageBudgetExceeded || report.alerts.deletionFailures) {
      process.exitCode = 2;
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`Storage report failed: ${error.message}\n`);
  process.exitCode = 1;
});
