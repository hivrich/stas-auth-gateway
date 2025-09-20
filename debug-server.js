const express = require('express');
const path = require('path');
const app = express();

app.use(express.static(path.join(__dirname, 'public')));

app.get('/oauth/authorize', (req, res) => {
  console.log('OAuth authorize request:', req.query);
  res.sendFile(path.join(__dirname, 'public', 'oauth-authorize.html'));
});

const PORT = 3339;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Debug server listening on ${PORT}`);
});
