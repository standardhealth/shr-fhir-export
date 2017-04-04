const common = require('./common');

function load(target) {
  const result = new FHIRDefinitions();
  const files = [
    `./definitions/${target}/extension-definitions.json`,
    `./definitions/${target}/profiles-resources.json`,
    `./definitions/${target}/profiles-types.json`,
    `./definitions/${target}/valuesets.json`
  ];
  for (const file of files) {
    const definitions = require(file);
    for (const entry of definitions.entry) {
      result.add(entry.resource);
    }
  }
  result.extensionTemplate = require(`./definitions/${target}/shr-extension-template.json`);
  result.valueSetTemplate = require(`./definitions/${target}/shr-valueSet-template.json`);
  result.codeSystemTemplate = require(`./definitions/${target}/shr-codeSystem-template.json`);
  return result;
}

class FHIRDefinitions {
  constructor() {
    this._extensions = new Map();
    this._resources = new Map();
    this._types = new Map();
    this._valueSets = new Map();
    this._extensionTemplate = {};
    this._valueSetTemplate = {};
    this._codeSystemTemplate = {};
  }

  // NOTE: These all return clones of the JSON to prevent the source values from being overwritten

  get extensions() { return cloneJsonMapValues(this._extensions); }
  findExtension(url) {
    return common.cloneJSON(this._extensions.get(url));
  }
  get resources() { return cloneJsonMapValues(this._resources); }
  findResource(name) {
    return common.cloneJSON(this._resources.get(name));
  }
  get types() { return cloneJsonMapValues(this._types); }
  findType(name) {
    return common.cloneJSON(this._types.get(name));
  }
  get valueSets() { return cloneJsonMapValues(this._valueSets); }
  findValueSet(name) {
    return common.cloneJSON(this._valueSets.get(name));
  }

  get extensionTemplate() { return common.cloneJSON(this._extensionTemplate); }
  set extensionTemplate(extensionTemplate) {
    this._extensionTemplate = extensionTemplate;
  }

  get valueSetTemplate() { return common.cloneJSON(this._valueSetTemplate); }
  set valueSetTemplate(valueSetTemplate) {
    this._valueSetTemplate = valueSetTemplate;
  }

  get codeSystemTemplate() { return common.cloneJSON(this._codeSystemTemplate); }
  set codeSystemTemplate(codeSystemTemplate) {
    this._codeSystemTemplate = codeSystemTemplate;
  }

  find(key) {
    if (this._resources.has(key)) {
      return this.findResource(key);
    } else if (this._types.has(key)) {
      return this.findType(key);
    } else {
      return this.findExtension(key);
    }
  }

  add(definition) {
    if (typeof definition === 'undefined' || definition == null) {
      return;
    } else if (definition.type == 'Extension' && definition.baseDefinition != 'http://hl7.org/fhir/StructureDefinition/Element') {
      this._extensions.set(definition.url, definition);
    } else if (definition.kind == 'primitive-type' || definition.kind == 'complex-type') {
      this._types.set(definition.id, definition);
    } else if (definition.kind == 'resource') {
      this._resources.set(definition.id, definition);
    } else if (definition.resourceType == 'ValueSet') {
      this._valueSets.set(definition.url, definition);
    }
  }
}

function cloneJsonMapValues(map) {
  return Array.from(map.values()).map(v => common.cloneJSON(v));
}

module.exports = load;