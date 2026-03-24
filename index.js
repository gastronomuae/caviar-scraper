const { main } = require('./src/fetch-products-all-1caviar');

main().catch((err) => {
  console.error(err.response?.data || err.message);
  process.exit(1);
});
