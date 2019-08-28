const fs = require('fs-extra');
const path = require('path');
const err = require('shr-test-helpers/errors');
const {sanityCheckModules} = require('shr-models');
const export_tests = require('shr-test-helpers/export');
const {commonExportTests} = export_tests;
const load = require('../lib/load');
const {ModelsExporter, setLogger} = require('../lib/logical/export');

sanityCheckModules({ 'shr-test-helpers': export_tests });

function setupTests(target) {
  const fixturePath = path.join(__dirname, 'fixtures', target);

  // define the fixFn to pass in to auto-fix broken tests
  const fixFn = (name, result, errors) => {
    if (/^\s*(true|yes|1)\s*$/i.test(process.env.FIX_TEST_ERRORS)) {
      if (result != null) {
        const fixture = path.join(fixturePath, `${name}.json`);
        console.error(`Fixing ${name} expected fixture to actual result.  Check ${fixture}.`);
        fs.writeFileSync(fixture, JSON.stringify(result, null, 2));
      }
      if (errors.length) {
        const fixture_err = path.join(fixturePath, `${name}_errors.json`);
        console.error(`Fixing ${name} expected errors fixture to actual errors.  Check ${fixture_err}.`);
        fs.writeFileSync(fixture_err, JSON.stringify(errors.map(e => ({ msg: e.msg })), null, 2));
      }
    }
  };

  const exportSpecifications = (specifications) => {
    const config = JSON.parse(fs.readFileSync(path.join(fixturePath, 'config', 'defaultConfig.json'), 'utf8'));
    const exporter = new ModelsExporter(specifications, load(target), config);
    return exporter.export();
  };

  const importFixture = (name, ext='.json') => {
    return JSON.parse(fs.readFileSync(path.join(fixturePath, `${name}${ext}`), 'utf8'));
  };

  const importErrorsFixture = (name, ext='.json') => {
    const file = path.join(fixturePath, `${name}_errors${ext}`);
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } else {
      // default to no expected _errors
      return [];
    }
  };

  // Set the logger -- this is needed for detecting and checking errors
  setLogger(err.logger());

  describe('#exportToJSON()', () => { describe(target, commonExportTests(exportSpecifications, importFixture, importErrorsFixture, fixFn, path.join(__dirname, 'actuals', target))); });
}

setupTests('FHIR_STU_3');
setupTests('FHIR_R4');

