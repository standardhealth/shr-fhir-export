const path = require('path');
const fs = require('fs-extra');
const {expect} = require('chai');
const StructureDefinition = require('../lib/logical/StructureDefinition');

describe('#StructureDefinition.fromJSON()', () => {
  describe('FHIR_STU_3', () => {
    const fixturePath = path.join(__dirname, 'fixtures', 'FHIR_STU_3');
    it('should deserialize a simple structure definition correctly', () => {
      const sdJSON = JSON.parse(fs.readFileSync(path.join(fixturePath, 'Simple.json'), 'utf8'));
      const sd = StructureDefinition.fromJSON(sdJSON[0]);

      // Test the high-level properties
      expect(sd.id).to.equal('shr-test-Simple-model');
      expect(sd.text).to.eql({
        status: 'generated',
        div: '<div xmlns="http://www.w3.org/1999/xhtml">\n  <p><b>Simple Logical Model</b></p>\n  <p>It is a simple element</p>\n</div>'
      });
      expect(sd.url).to.equal('http://foobar.com/fhir/StructureDefinition/shr-test-Simple-model');
      expect(sd.name).to.equal('Simple');
      expect(sd.title).to.equal('shr-test-Simple');
      expect(sd.status).to.equal('draft');
      expect(sd.date).to.equal('2018-02-26');
      expect(sd.publisher).to.equal('The Foo Bar Corporation');
      expect(sd.contact).to.eql([{
        telecom: [{ system: 'url', value: 'http://foobar.com' }]
      }]);
      expect(sd.description).to.equal('It is a simple element');
      expect(sd.fhirVersion).to.equal('3.0.1');
      expect(sd.kind).to.equal('logical');
      expect(sd.abstract).to.be.false;
      expect(sd.type).to.eql('shr-test-Simple-model');
      expect(sd.baseDefinition).to.equal('http://hl7.org/fhir/StructureDefinition/Element');
      expect(sd.derivation).to.equal('specialization');
      expect(sd.elements).to.have.length(2);

      // Test the first (root) element
      const el0 = sd.elements[0];
      expect(el0.id).to.equal('shr-test-Simple-model');
      expect(el0.path).to.equal('shr-test-Simple-model');
      expect(el0.definition).to.equal('It is a simple element');
      expect(el0.min).to.equal(0);
      expect(el0.max).to.equal('*');
      expect(el0.base).to.eql({
        path: 'shr-test-Simple-model',
        min: 0,
        max: '*'
      });
      expect(el0.mustSupport).to.be.false;
      expect(el0.isModifier).to.be.false;
      expect(el0.isSummary).to.be.false;

      // Test the second element
      const el1 = sd.elements[1];
      expect(el1.id).to.equal('shr-test-Simple-model.value');
      expect(el1.path).to.equal('shr-test-Simple-model.value');
      expect(el1.short).to.equal('String representing it is a simple element');
      expect(el1.definition).to.equal('String representing it is a simple element');
      expect(el1.min).to.equal(1);
      expect(el1.max).to.equal('1');
      expect(el1.base).to.eql({
        path: 'shr-test-Simple-model.value',
        min: 1,
        max: '1'
      });
      expect(el1.type).to.eql([{ code: 'string' }]);
      expect(el1.mustSupport).to.be.false;
      expect(el1.isModifier).to.be.false;
      expect(el1.isSummary).to.be.false;
    });

    it('should convert binding.valueSet[x] to binding.valueSet', () => {
      const sdJSON = JSON.parse(fs.readFileSync(path.join(fixturePath, 'Coded.json'), 'utf8'));
      const sd = StructureDefinition.fromJSON(sdJSON[0]);

      // General deserialization is already tested elsewhere; jump right to the element with the binding
      const el1 = sd.elements[1];
      expect(el1.id).to.equal('shr-test-Coded-model.value');
      expect(el1.path).to.equal('shr-test-Coded-model.value');
      expect(el1.short).to.equal('Concept representing it is a coded element');
      expect(el1.definition).to.equal('Concept representing it is a coded element');
      expect(el1.min).to.equal(1);
      expect(el1.max).to.equal('1');
      expect(el1.base).to.eql({
        path: 'shr-test-Coded-model.value',
        min: 1,
        max: '1'
      });
      expect(el1.type).to.eql([{ code: 'Coding' }]);
      expect(el1.mustSupport).to.be.false;
      expect(el1.isModifier).to.be.false;
      expect(el1.isSummary).to.be.false;
      // The STU3 valueSet[x] should have been converted to R4 valueset
      expect(el1.binding).to.eql({
        strength: 'required',
        valueSet: 'http://standardhealthrecord.org/test/vs/Coded'
      });
    });

    it('should convert singular targetProfile to targetProfile array', () => {
      const sdJSON = JSON.parse(fs.readFileSync(path.join(fixturePath, 'SimpleReference.json'), 'utf8'));
      const sd = StructureDefinition.fromJSON(sdJSON[0]);

      // General deserialization is already tested elsewhere; jump right to the element with the binding
      const el1 = sd.elements[1];
      expect(el1.id).to.equal('shr-test-SimpleReference-model.value');
      expect(el1.path).to.equal('shr-test-SimpleReference-model.value');
      expect(el1.code).to.eql([{
        system: 'http://foo.org',
        code: 'bar',
        display: 'Foobar'
      }]);
      expect(el1.short).to.equal('Simple representing it is a reference to a simple element');
      expect(el1.definition).to.equal('Simple representing it is a reference to a simple element');
      expect(el1.min).to.equal(1);
      expect(el1.max).to.equal('1');
      expect(el1.base).to.eql({
        path: 'shr-test-SimpleReference-model.value',
        min: 1,
        max: '1'
      });
      // The STU3 targetProfile should have been converted to an array for R4
      expect(el1.type).to.eql([{
        code: 'Reference',
        targetProfile: ['http://foobar.com/fhir/StructureDefinition/shr-test-Simple-model']
      }]);
      expect(el1.mustSupport).to.be.false;
      expect(el1.isModifier).to.be.false;
      expect(el1.isSummary).to.be.false;
    });
  });

  describe('FHIR_R4', () => {
    const fixturePath = path.join(__dirname, 'fixtures', 'FHIR_R4');
    it('should deserialize a simple structure definition correctly', () => {
      const sdJSON = JSON.parse(fs.readFileSync(path.join(fixturePath, 'Simple.json'), 'utf8'));
      const sd = StructureDefinition.fromJSON(sdJSON[0]);

      // Test the high-level properties
      expect(sd.id).to.equal('shr-test-Simple-model');
      expect(sd.text).to.eql({
        status: 'generated',
        div: '<div xmlns="http://www.w3.org/1999/xhtml">\n  <p><b>Simple Logical Model</b></p>\n  <p>It is a simple element</p>\n</div>'
      });
      expect(sd.url).to.equal('http://foobar.com/fhir/StructureDefinition/shr-test-Simple-model');
      expect(sd.name).to.equal('Simple');
      expect(sd.title).to.equal('shr-test-Simple');
      expect(sd.status).to.equal('draft');
      expect(sd.date).to.equal('2018-02-26');
      expect(sd.publisher).to.equal('The Foo Bar Corporation');
      expect(sd.contact).to.eql([{
        telecom: [{ system: 'url', value: 'http://foobar.com' }]
      }]);
      expect(sd.description).to.equal('It is a simple element');
      expect(sd.fhirVersion).to.equal('4.0.0');
      expect(sd.kind).to.equal('logical');
      expect(sd.abstract).to.be.false;
      expect(sd.type).to.eql('shr-test-Simple-model');
      expect(sd.baseDefinition).to.equal('http://hl7.org/fhir/StructureDefinition/Element');
      expect(sd.derivation).to.equal('specialization');
      expect(sd.elements).to.have.length(2);

      // Test the first (root) element
      const el0 = sd.elements[0];
      expect(el0.id).to.equal('shr-test-Simple-model');
      expect(el0.path).to.equal('shr-test-Simple-model');
      expect(el0.definition).to.equal('It is a simple element');
      expect(el0.min).to.equal(0);
      expect(el0.max).to.equal('*');
      expect(el0.base).to.eql({
        path: 'shr-test-Simple-model',
        min: 0,
        max: '*'
      });
      expect(el0.mustSupport).to.be.false;
      expect(el0.isModifier).to.be.false;
      expect(el0.isSummary).to.be.false;

      // Test the second element
      const el1 = sd.elements[1];
      expect(el1.id).to.equal('shr-test-Simple-model.value');
      expect(el1.path).to.equal('shr-test-Simple-model.value');
      expect(el1.short).to.equal('String representing it is a simple element');
      expect(el1.definition).to.equal('String representing it is a simple element');
      expect(el1.min).to.equal(1);
      expect(el1.max).to.equal('1');
      expect(el1.base).to.eql({
        path: 'shr-test-Simple-model.value',
        min: 1,
        max: '1'
      });
      expect(el1.type).to.eql([{ code: 'string' }]);
      expect(el1.mustSupport).to.be.false;
      expect(el1.isModifier).to.be.false;
      expect(el1.isSummary).to.be.false;
    });

    it('should convert binding.valueSet[x] to binding.valueSet', () => {
      const sdJSON = JSON.parse(fs.readFileSync(path.join(fixturePath, 'Coded.json'), 'utf8'));
      const sd = StructureDefinition.fromJSON(sdJSON[0]);

      // General deserialization is already tested elsewhere; jump right to the element with the binding
      const el1 = sd.elements[1];
      expect(el1.id).to.equal('shr-test-Coded-model.value');
      expect(el1.path).to.equal('shr-test-Coded-model.value');
      expect(el1.short).to.equal('Concept representing it is a coded element');
      expect(el1.definition).to.equal('Concept representing it is a coded element');
      expect(el1.min).to.equal(1);
      expect(el1.max).to.equal('1');
      expect(el1.base).to.eql({
        path: 'shr-test-Coded-model.value',
        min: 1,
        max: '1'
      });
      expect(el1.type).to.eql([{ code: 'Coding' }]);
      expect(el1.mustSupport).to.be.false;
      expect(el1.isModifier).to.be.false;
      expect(el1.isSummary).to.be.false;
      // Keep the R4 valueset format
      expect(el1.binding).to.eql({
        strength: 'required',
        valueSet: 'http://standardhealthrecord.org/test/vs/Coded'
      });
    });

    it('should convert singular targetProfile to targetProfile array', () => {
      const sdJSON = JSON.parse(fs.readFileSync(path.join(fixturePath, 'SimpleReference.json'), 'utf8'));
      const sd = StructureDefinition.fromJSON(sdJSON[0]);

      // General deserialization is already tested elsewhere; jump right to the element with the binding
      const el1 = sd.elements[1];
      expect(el1.id).to.equal('shr-test-SimpleReference-model.value');
      expect(el1.path).to.equal('shr-test-SimpleReference-model.value');
      expect(el1.code).to.eql([{
        system: 'http://foo.org',
        code: 'bar',
        display: 'Foobar'
      }]);
      expect(el1.short).to.equal('Simple representing it is a reference to a simple element');
      expect(el1.definition).to.equal('Simple representing it is a reference to a simple element');
      expect(el1.min).to.equal(1);
      expect(el1.max).to.equal('1');
      expect(el1.base).to.eql({
        path: 'shr-test-SimpleReference-model.value',
        min: 1,
        max: '1'
      });
      // Keep the R4 valueset format
      expect(el1.type).to.eql([{
        code: 'Reference',
        targetProfile: ['http://foobar.com/fhir/StructureDefinition/shr-test-Simple-model']
      }]);
      expect(el1.mustSupport).to.be.false;
      expect(el1.isModifier).to.be.false;
      expect(el1.isSummary).to.be.false;
    });
  });
});
