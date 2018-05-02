const fs = require('fs-extra');
const path = require('path');
const {expect} = require('chai');
const err = require('shr-test-helpers/errors');
const {sanityCheckModules} = require('shr-models');
const shrTI = require('shr-text-import');
const shrEx = require('shr-expand');
const shrFE = require('../index');

sanityCheckModules({shrTI, shrEx, shrFE});


describe('Export to FHIR regression tests (SLOW - to skip use "yarn test:fast")', function () {
  const FIXTURES_SPEC_PATH = path.join(__dirname, 'fixtures', 'regression', 'spec');
  const FIXTURES_EXPECTED_PATH = path.join(__dirname, 'fixtures', 'regression', 'expected');

  let result;
  before(function() {
    // This takes a while, so increase the timeout
    this.timeout(10*1000);

    // Set the logger
    const logger = err.logger();
    shrTI.setLogger(logger);
    shrEx.setLogger(logger);
    shrFE.setLogger(logger);

    const configSpecs = shrTI.importConfigFromFilePath(FIXTURES_SPEC_PATH);
    const specs = shrTI.importFromFilePath(FIXTURES_SPEC_PATH, configSpecs);
    const expSpecs = shrEx.expand(specs, shrFE);
    result = shrFE.exportToFHIR(expSpecs, configSpecs);
  });

  ['profile', 'extension', 'model', 'valueSet', 'codeSystem'].forEach(name => {
    describe(`#${name}s`, function () {
      const tested = new Map();
      const parentPath = path.join(FIXTURES_EXPECTED_PATH, `${name}s`);
      for (const file of fs.readdirSync(parentPath).filter(f => f.endsWith('.json'))) {
        const filePath = path.join(parentPath, file);
        const expected = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        tested.set(expected.id, true);
        it(`should export ${name}: ${expected.id}`, function () {
          const actual = result[`${name}s`].find(r => r.id === expected.id);
          expect(actual, `${name} not found: ${expected.id}`).to.not.be.null;
          const normalizedActual = JSON.parse(JSON.stringify(actual));
          expect(normalizedActual).to.eql(expected);
        });
      }

      it (`should not export unexpected ${name}s`, function() {
        const unexpected = result[`${name}s`].map(r => r.id).filter(id => !tested.has(id));
        expect(unexpected, `exported unexpected ${name}s: ${unexpected.join(', ')}`).to.be.empty;
      });
    });
  });
});
