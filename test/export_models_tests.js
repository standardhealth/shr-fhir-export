const fs = require('fs-extra');
const path = require('path');
const err = require('shr-test-helpers/errors');
const {sanityCheckModules} = require('shr-models');
const export_tests = require('shr-test-helpers/export');
const {commonExportTests} = export_tests;
const load = require('../lib/load');
const {ModelsExporter, setLogger} = require('../lib/logical/export');

sanityCheckModules({ 'shr-test-helpers': export_tests });

// define the fixFn to pass in to auto-fix broken tests
function fixFn (name, result, errors) {
  if (/^\s*(true|yes|1)\s*$/i.test(process.env.FIX_TEST_ERRORS)) {
    if (result != null) {
      const fixture = path.join(`${__dirname}/fixtures/`, `${name}.json`);
      console.error(`Fixing ${name} expected fixture to actual result.  Check ${fixture}.`);
      fs.writeFileSync(fixture, JSON.stringify(result, null, 2));
    }
    if (errors.length) {
      const fixture_err = path.join(`${__dirname}/fixtures/`, `${name}_errors.json`);
      console.error(`Fixing ${name} expected errors fixture to actual errors.  Check ${fixture_err}.`);
      fs.writeFileSync(fixture_err, JSON.stringify(errors.map(e => ({ msg: e.msg })), null, 2));
    }
  }
}

// Set the logger -- this is needed for detecting and checking errors
setLogger(err.logger());

describe('#exportToJSON()', commonExportTests(exportSpecifications, importFixture, importErrorsFixture, fixFn, path.join(__dirname, 'actuals')));

function defaultConfiguration()
{
  return JSON.parse(fs.readFileSync(`${__dirname}/fixtures/config/defaultConfig.json`, 'utf8'));
}

function exportSpecifications(specifications) {
  const exporter = new ModelsExporter(specifications, load('FHIR_STU_3'), defaultConfiguration());
  return exporter.export();
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
