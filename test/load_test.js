const {expect} = require('chai');
const load = require('../lib/load.js');

describe('#load()', () => {
  var defs;
  before(() => {
    defs = load('FHIR_STU_3');
  });

  it('should load base FHIR resources', () => {
    expect(defs.findResource('Condition').url).to.equal('http://hl7.org/fhir/StructureDefinition/Condition');
    expect(defs.findResource('http://hl7.org/fhir/StructureDefinition/Condition').id).to.equal('Condition');
  });

  it('should load base FHIR primitive types', () => {
    expect(defs.findType('boolean').url).to.equal('http://hl7.org/fhir/StructureDefinition/boolean');
    expect(defs.findType('http://hl7.org/fhir/StructureDefinition/boolean').id).to.equal('boolean');
  });

  it('should load base FHIR complex types', () => {
    expect(defs.findType('Address').url).to.equal('http://hl7.org/fhir/StructureDefinition/Address');
    expect(defs.findType('http://hl7.org/fhir/StructureDefinition/Address').id).to.equal('Address');
  });

  it('should load base FHIR extensions', () => {
    expect(defs.findExtension('patient-mothersMaidenName').url).to.equal('http://hl7.org/fhir/StructureDefinition/patient-mothersMaidenName');
    expect(defs.findExtension('http://hl7.org/fhir/StructureDefinition/patient-mothersMaidenName').id).to.equal('patient-mothersMaidenName');
  });

  it('should load base FHIR value sets', () => {
    expect(defs.findValueSet('allergy-clinical-status').url).to.equal('http://hl7.org/fhir/ValueSet/allergy-clinical-status');
    expect(defs.findValueSet('http://hl7.org/fhir/ValueSet/allergy-clinical-status').id).to.equal('allergy-clinical-status');
  });

  it('should load US Core profiles', () => {
    expect(defs.findResource('us-core-patient').url).to.equal('http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient');
    expect(defs.findResource('http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient').id).to.equal('us-core-patient');
  });

  it('should load US Core extensions', () => {
    expect(defs.findExtension('us-core-race').url).to.equal('http://hl7.org/fhir/us/core/StructureDefinition/us-core-race');
    expect(defs.findExtension('http://hl7.org/fhir/us/core/StructureDefinition/us-core-race').id).to.equal('us-core-race');
  });

  it('should load US Core value sets', () => {
    expect(defs.findValueSet('us-core-cvx').url).to.equal('http://hl7.org/fhir/us/core/ValueSet/us-core-cvx');
    expect(defs.findValueSet('http://hl7.org/fhir/us/core/ValueSet/us-core-cvx').id).to.equal('us-core-cvx');
  });

  it('should globally find any definition', () => {
    expect(defs.find('Condition').kind).to.equal('resource');
    expect(defs.find('http://hl7.org/fhir/StructureDefinition/Condition').kind).to.equal('resource');
    expect(defs.find('boolean').kind).to.equal('primitive-type');
    expect(defs.find('http://hl7.org/fhir/StructureDefinition/boolean').kind).to.equal('primitive-type');
    expect(defs.find('Address').kind).to.equal('complex-type');
    expect(defs.find('http://hl7.org/fhir/StructureDefinition/Address').kind).to.equal('complex-type');
    expect(defs.find('patient-mothersMaidenName').type).to.equal('Extension');
    expect(defs.find('http://hl7.org/fhir/StructureDefinition/patient-mothersMaidenName').type).to.equal('Extension');
    expect(defs.find('allergy-clinical-status').resourceType).to.equal('ValueSet');
    expect(defs.find('http://hl7.org/fhir/ValueSet/allergy-clinical-status').resourceType).to.equal('ValueSet');
    expect(defs.find('us-core-patient').kind).to.equal('resource');
    expect(defs.find('http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient').kind).to.equal('resource');
    expect(defs.find('us-core-race').type).to.equal('Extension');
    expect(defs.find('http://hl7.org/fhir/us/core/StructureDefinition/us-core-race').type).to.equal('Extension');
    expect(defs.find('us-core-cvx').resourceType).to.equal('ValueSet');
    expect(defs.find('http://hl7.org/fhir/us/core/ValueSet/us-core-cvx').resourceType).to.equal('ValueSet');
  });
});
