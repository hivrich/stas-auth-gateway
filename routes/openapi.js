const express = require('express');
const path = require('path');
const router = express.Router();

function sendFile(res, p, type){
  res.set({
    'Content-Type': type + '; charset=utf-8',
    'Cache-Control': 'public, max-age=60',
    'Access-Control-Allow-Origin': '*'
  });
  res.sendFile(path.join(__dirname, '..', p));
}

router.get('/openapi.json',      (req,res)=>sendFile(res, 'openapi.json',       'application/json'));
router.get('/openapi.yaml',      (req,res)=>sendFile(res, 'openapi.yaml',       'application/yaml'));
router.get('/openapi.min.json',  (req,res)=>sendFile(res, 'openapi.min.json',   'application/json'));
router.get('/openapi.min.yaml',  (req,res)=>sendFile(res, 'openapi.min.yaml',   'application/yaml'));
router.get('/openapi.actions.json',(req,res)=>sendFile(res,'openapi.actions.json','application/json'));

module.exports = router;
