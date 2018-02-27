const fs = require('fs');
const path = require('path');
const err = require('shr-test-helpers/errors');
const {sanityCheckModules} = require('shr-models');
const export_tests = require('shr-test-helpers/export');
const {commonExportTests} = export_tests;
const {exportToFHIRLogicalModels, setLogger} = require('../lib/logical/export');

sanityCheckModules({ 'shr-test-helpers': export_tests });

// Set the logger -- this is needed for detecting and checking errors
setLogger(err.logger());

describe('#exportToJSON()', commonExportTests(exportSpecifications, importFixture, importErrorsFixture, path.join(__dirname, 'actuals')));

function defaultConfiguration()
{
  return JSON.parse(fs.readFileSync(`${__dirname}/fixtures/config/defaultConfig.json`, 'utf8'));
}

function exportSpecifications(specifications) {
  const results = exportToFHIRLogicalModels(specifications, defaultConfiguration());
  return results;
}

function importFixture(name, ext='.json') {
  return JSON.parse(fs.readFileSync(`${__dirname}/fixtures/${name}${ext}`, 'utf8'));
}

function importErrorsFixture(name, ext='.json') {
  const file = `${__dirname}/fixtures/${name}_errors${ext}`;
  if (fs.existsSync(file)) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } else {
    // default to no expected _errors
    return [];
  }
}
