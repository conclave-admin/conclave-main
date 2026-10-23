const { runStorageCleanup } = require("../src/services/storageCleanup.service");
const { pool } = require("../src/config/db");
runStorageCleanup()
  .then((result) => console.log(result))
  .catch((error) => {
    console.error("Media cleanup failed", error.name);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
