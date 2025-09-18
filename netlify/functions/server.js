const { createServer } = require('@netlify/functions');
const app = require('../../server');

const server = createServer(app);

exports.handler = server;
