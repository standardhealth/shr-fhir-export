function load(target) {
  const result = new FHIRDefinitions();
  const files = [
    `./definitions/${target}/extension-definitions.json`,
    `./definitions/${target}/profiles-resources.json`,
    `./definitions/${target}/profiles-types.json`
  ];
  for (const file of files) {
    const definitions = require(file);
    for (const entry of definitions.entry) {
      result.add(entry.resource);
    }
  }
  result.extensionTemplate = require(`./definitions/${target}/shr-extension-template.json`);
  return result;
}

class FHIRDefinitions {
  constructor() {
    this._extensions = new Map();
    this._resources = new Map();
    this._types = new Map();
    this._extensionTemplate = {};
  }

  get extensions() { return Array.from(this._extensions.values()); }
  findExtension(url) {
    return this._extensions.get(url);
  }
  get resources() { return Array.from(this._resources.values()); }
  findResource(name) {
    return this._resources.get(name);
  }
  get types() { return Array.from(this._types.values()); }
  findType(name) {
    return this._types.get(name);
  }

  get extensionTemplate() { return this._extensionTemplate; }
  set extensionTemplate(extTemplate) {
    this._extensionTemplate = extTemplate;
  }

  find(key) {
    if (this._resources.has(key)) {
      return this._resources.get(key);
    } else if (this._types.has(key)) {
      return this._types.get(key);
    } else {
      return this._extensions.get(key);
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
    }
  }
}

module.exports = load;