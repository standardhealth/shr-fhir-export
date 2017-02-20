const {FHIRExporter} = require('../lib/export.js');

describe('#experiment()', () => {
  it('should load FHIR JSON', () => {
    new FHIRExporter();
  });
});
/*
const {expect} = require('chai');
const fs = require('fs');
const th = require('shr-test-helpers');
const mdl = require('shr-models');
const {exportToMarkdown} = require('../index');

describe('#exportToMarkdownCommonCases()', th.commonExportTests(importFixture, exportNamespaces));

describe('#exportToMarkdownSpecificCases()', () => {
  it('should correctly export a master index', () => {
    let ns = new mdl.Namespace('shr.test');
    let de = new mdl.DataElement(new mdl.Identifier(ns.namespace, 'Simple'), true)
      .withDescription('It is a simple element')
      .withConcept(new mdl.Concept('http://foo.org', 'bar'))
      .withValue(new mdl.IdentifiableValue(new mdl.PrimitiveIdentifier('string')).withMinMax(1, 1));
    ns.addDefinition(de);

    de = new mdl.DataElement(new mdl.Identifier(ns.namespace, 'Coded'), true)
      .withDescription('It is a coded element')
      .withValue(new mdl.IdentifiableValue(new mdl.PrimitiveIdentifier('code')).withMinMax(1, 1)
        .withConstraint(new mdl.ValueSetConstraint('http://standardhealthrecord.org/test/vs/Coded'))
      );
    ns.addDefinition(de);

    let ns2 = new mdl.Namespace('shr.other.test');
    de = new mdl.DataElement(new mdl.Identifier(ns2.namespace, 'Simple'), true)
      .withDescription('It is a coded element descending from foobar')
      .withValue(new mdl.IdentifiableValue(new mdl.PrimitiveIdentifier('code')).withMinMax(1, 1)
        .withConstraint(new mdl.ValueSetConstraint('http://standardhealthrecord.org/other/test/vs/Coded'))
      );
    ns2.addDefinition(de);

    let expectedMD = importFixture('index');
    const results = exportToMarkdown([ns, ns2]);
    expect(splitLines(results.index)).to.eql(expectedMD);
  });
});

function exportNamespaces(...namespace) {
  let markdowns = [];
  const results = exportToMarkdown(namespace);
  for (const ns of namespace) {
    markdowns = markdowns.concat(splitLines(results.namespaces[ns.namespace].index), '');
  }
  return markdowns;
}

function importFixture(name, ext='.md') {
  const fixture = fs.readFileSync(`${__dirname}/fixtures/${name}${ext}`, 'utf8');
  return splitLines(fixture).concat('');
}

function splitLines(text) {
  return text.split('\n').map(l => l.trim());
}
*/
