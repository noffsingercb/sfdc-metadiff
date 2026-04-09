// adapters/stdout/index.js
// Stdout adapter -- writes a formatted MDIF document to process.stdout.
// Zero config. Useful as a pipe source in CI/CD:
//   node src/cli.js | tee changes.mdif | your-consumer

const { formatDocument } = require('../../src/format');

async function consume(blocks, opts = {}) {
  const document = formatDocument(blocks, opts);
  process.stdout.write(document + '\n');
}

module.exports = { consume };