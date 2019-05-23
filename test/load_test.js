const {expect} = require('chai');
const load = require('../lib/load.js');

describe('#load()', () => {
  describe('FHIR_R4', () => {
    let defs;
    before(() => {
      defs = load('FHIR_R4');
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
      expect(defs.findValueSet('allergyintolerance-clinical').url).to.equal('http://hl7.org/fhir/ValueSet/allergyintolerance-clinical');
      expect(defs.findValueSet('http://hl7.org/fhir/ValueSet/allergyintolerance-clinical').id).to.equal('allergyintolerance-clinical');
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
      expect(defs.findValueSet('us-core-vaccines-cvx').url).to.equal('http://hl7.org/fhir/us/core/ValueSet/us-core-vaccines-cvx');
      expect(defs.findValueSet('http://hl7.org/fhir/us/core/ValueSet/us-core-vaccines-cvx').id).to.equal('us-core-vaccines-cvx');
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
      expect(defs.find('allergyintolerance-clinical').resourceType).to.equal('ValueSet');
      expect(defs.find('http://hl7.org/fhir/ValueSet/allergyintolerance-clinical').resourceType).to.equal('ValueSet');
      expect(defs.find('us-core-patient').kind).to.equal('resource');
      expect(defs.find('http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient').kind).to.equal('resource');
      expect(defs.find('us-core-race').type).to.equal('Extension');
      expect(defs.find('http://hl7.org/fhir/us/core/StructureDefinition/us-core-race').type).to.equal('Extension');
      expect(defs.find('us-core-vaccines-cvx').resourceType).to.equal('ValueSet');
      expect(defs.find('http://hl7.org/fhir/us/core/ValueSet/us-core-vaccines-cvx').resourceType).to.equal('ValueSet');
    });
  });

  describe('FHIR_STU_3', () => {
    let defs;
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

  describe('FHIR_DSTU_2', () => {
    let defs;
    before(() => {
      defs = load('FHIR_DSTU_2');
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
      expect(defs.findValueSet('allergy-intolerance-status').url).to.equal('http://hl7.org/fhir/ValueSet/allergy-intolerance-status');
      expect(defs.findValueSet('http://hl7.org/fhir/ValueSet/allergy-intolerance-status').id).to.equal('allergy-intolerance-status');
    });

    it('should load Argonaut profiles', () => {
      expect(defs.findResource('argo-patient').url).to.equal('http://fhir.org/guides/argonaut/StructureDefinition/argo-patient');
      expect(defs.findResource('http://fhir.org/guides/argonaut/StructureDefinition/argo-patient').id).to.equal('argo-patient');
    });

    it('should load Argonaut extensions', () => {
      expect(defs.findExtension('argo-race').url).to.equal('http://fhir.org/guides/argonaut/StructureDefinition/argo-race');
      expect(defs.findExtension('http://fhir.org/guides/argonaut/StructureDefinition/argo-race').id).to.equal('argo-race');
    });

    it('should load Argonaut value sets', () => {
      expect(defs.findValueSet('vacc-status').url).to.equal('http://fhir.org/guides/argonaut/ValueSet/vacc-status');
      expect(defs.findValueSet('http://fhir.org/guides/argonaut/ValueSet/vacc-status').id).to.equal('vacc-status');
    });

    it('should globally find any definition', () => {
      expect(defs.find('Condition').kind).to.equal('resource');
      expect(defs.find('http://hl7.org/fhir/StructureDefinition/Condition').kind).to.equal('resource');
      expect(defs.find('boolean').kind).to.equal('datatype');
      expect(defs.find('http://hl7.org/fhir/StructureDefinition/boolean').kind).to.equal('datatype');
      expect(defs.find('Address').kind).to.equal('datatype');
      expect(defs.find('http://hl7.org/fhir/StructureDefinition/Address').kind).to.equal('datatype');
      expect(defs.find('patient-mothersMaidenName').constrainedType).to.equal('Extension');
      expect(defs.find('http://hl7.org/fhir/StructureDefinition/patient-mothersMaidenName').constrainedType).to.equal('Extension');
      expect(defs.find('allergy-intolerance-status').resourceType).to.equal('ValueSet');
      expect(defs.find('http://hl7.org/fhir/ValueSet/allergy-intolerance-status').resourceType).to.equal('ValueSet');
      expect(defs.find('argo-patient').kind).to.equal('resource');
      expect(defs.find('http://fhir.org/guides/argonaut/StructureDefinition/argo-patient').kind).to.equal('resource');
      expect(defs.find('argo-race').constrainedType).to.equal('Extension');
      expect(defs.find('http://fhir.org/guides/argonaut/StructureDefinition/argo-race').constrainedType).to.equal('Extension');
      expect(defs.find('vacc-status').resourceType).to.equal('ValueSet');
      expect(defs.find('http://fhir.org/guides/argonaut/ValueSet/vacc-status').resourceType).to.equal('ValueSet');
    });
  });
});
