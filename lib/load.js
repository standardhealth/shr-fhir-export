const common = require('./common');
const MVH = require('./multiVersionHelper');
const fs = require('fs');
const path = require('path');

const _cache = new Map();

function load(target) {
  if (!_cache.has(target)) {
    const result = new FHIRDefinitions(target);
    // Load the base FHIR definitions
    const files = [
      `${__dirname}/definitions/${target}/extension-definitions.json`,
      `${__dirname}/definitions/${target}/profiles-resources.json`,
      `${__dirname}/definitions/${target}/profiles-types.json`,
      `${__dirname}/definitions/${target}/profiles-others.json`,
      `${__dirname}/definitions/${target}/valuesets.json`
    ];
    for (const file of files) {
      const definitions = require(file);
      for (const entry of definitions.entry) {
        result.add(entry.resource);
      }
    }
    // Load external IGs (e.g., US Core)
    recursiveLoadIGPath(`${__dirname}/definitions/${target}/IGs`, result);
    // Load our templates
    result.implementationGuideTemplate = fs.readFileSync(`${__dirname}/definitions/${target}/shr-implementationGuide-template.xml`, 'utf8');
    result.extensionTemplate = require(`${__dirname}/definitions/${target}/shr-extension-template.json`);
    result.valueSetTemplate = require(`${__dirname}/definitions/${target}/shr-valueSet-template.json`);
    if (target !== 'FHIR_DSTU_2') {
      result.codeSystemTemplate = require(`${__dirname}/definitions/${target}/shr-codeSystem-template.json`);
    }

    _cache.set(target, result);
  }

  return _cache.get(target);
}

function recursiveLoadIGPath(filePath, fhirDefinitions) {
  const stat = fs.lstatSync(filePath);
  if (stat.isDirectory()) {
    fs.readdirSync(filePath).forEach(file => {
      recursiveLoadIGPath(path.join(filePath,file), fhirDefinitions);
    });
  } else if (stat.isFile() && filePath.endsWith('.json')) {
    fhirDefinitions.add(require(filePath));
  }
}

class FHIRDefinitions {
  constructor(target) {
    this._target = target;
    this._extensions = new Map();
    this._resources = new Map();
    this._types = new Map();
    this._valueSets = new Map();
    this._implementationGuideTemplate = '';
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

  get implementationGuideTemplate() { return this._implementationGuideTemplate; }
  set implementationGuideTemplate(implementationGuideTemplate) {
    this._implementationGuideTemplate = implementationGuideTemplate;
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
    } else if (this._extensions.has(key)) {
      return this.findExtension(key);
    } else {
      return this.findValueSet(key);
    }
  }

  add(definition) {
    if (this._target === 'FHIR_DSTU_2') {
      populateMissingIds(definition);
    }
    if (typeof definition === 'undefined' || definition == null) {
      return;
    } else if (MVH.sdType(definition) == 'Extension' && MVH.sdBaseDefinition(definition) != 'http://hl7.org/fhir/StructureDefinition/Element') {
      addDefinitionToMap(definition, this._extensions);
    } else if (definition.kind === 'primitive-type' || definition.kind === 'complex-type' || definition.kind === 'datatype') {
      addDefinitionToMap(definition, this._types);
    } else if (definition.kind == 'resource') {
      addDefinitionToMap(definition, this._resources);
    } else if (definition.resourceType == 'ValueSet') {
      addDefinitionToMap(definition, this._valueSets);
    }
  }
}

// DSTU2 resource definitions don't specify ids for the snapshot elements, but it's easier for us to process everything if they're there.
// So default DSTU2 ids to the path.
function populateMissingIds(definition) {
  if (typeof definition === 'undefined' || definition == null) {
    return;
  }
  const fixId = (element) => {
    if (element.id == null) {
      element.id = element.path;
    }
  };
  if (definition.snapshot && definition.snapshot.element) {
    definition.snapshot.element.forEach(fixId);
  }
  if (definition.differential && definition.differential.element) {
    definition.differential.element.forEach(fixId);
  }
}

function addDefinitionToMap(def, defMap) {
  if (def.id) {
    defMap.set(def.id, def);
  }
  if (def.url) {
    defMap.set(def.url, def);
  }
}

function cloneJsonMapValues(map) {
  return Array.from(map.values()).map(v => common.cloneJSON(v));
}

module.exports = load;