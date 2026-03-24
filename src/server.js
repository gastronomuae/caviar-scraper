const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

app.get('/', (req, res) => {
  res.send('Server is running');
});

function ingestGastronomPayload(req, res) {
  console.log('📦 Incoming Gastronom webhook');

  const data = req.body;
  const incoming = Array.isArray(data) ? data : [data];

  console.log('📊 Payload:');
  console.log(JSON.stringify(data, null, 2));

  const filePath = path.join(__dirname, '../Output/from_gastronom.json');
  let existing = [];

  if (fs.existsSync(filePath)) {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      existing = Array.isArray(parsed) ? parsed : [parsed];
    } catch (_) {
      existing = [];
    }
  }

  const merged = [...existing, ...incoming];

  fs.writeFileSync(filePath, JSON.stringify(merged, null, 2));

  console.log(`💾 Saved to Output/from_gastronom.json (total: ${merged.length})`);

  res.json({
    status: 'ok',
    received: incoming.length
  });
}

app.post('/gastronom', ingestGastronomPayload);
/** @deprecated Use POST /gastronom — kept for existing webhook URLs */
app.post('/shopify', ingestGastronomPayload);

app.listen(3000, () => {
  console.log('🚀 Server running on port 3000 — POST /gastronom or /shopify → Output/from_gastronom.json');
});
