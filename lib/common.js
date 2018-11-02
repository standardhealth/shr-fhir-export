const mdls = require('shr-models');
const MVH = require('./multiVersionHelper');

function getSnapshotElement(profile, target, sliceNumber) {
  // NOTE: The validateChoice argument allows this to work in the differential, when there might be a value[x],
  // but since the choice didn't change, there is no type array in the differential.
  // TODO: If path isn't in elements, but is valid by drilling into a type, what then?
  let choice;
  let parts = target.split('.');
  if (parts.length > 1 && parts[parts.length-2].endsWith('[x]')) {
    // The last part of the path is the actual choice, but the real path ends with [x]
    choice = parts.pop();
  }
  let path = `${MVH.sdType(profile)}.${parts.join('.')}`;
  const el = profile.snapshot.element.find(e => {
    // If sliceNumber is specified we want the n + 1 match (note, this only works when path is root of slice)
    return e.path == path && (typeof sliceNumber === 'undefined' || (--sliceNumber) < 0);
  });
  if (path.endsWith('[x]') && typeof el !== 'undefined' && typeof choice != 'undefined') {
    if (!elementTypeContainsTypeName(el.type, choice)) {
      return; // it's not a valid choice!
    }
  }
  return el;
}

function getSnapshotElementById(profile, id) {
  return getFHIRElementByID(profile.snapshot.element, id);
}

function getDifferentialElementById(profile, id, createIfMissing=false) {
  let df = getFHIRElementByID(profile.differential.element, id);
  if (typeof df === 'undefined' && createIfMissing) {
    const ss = getSnapshotElementById(profile, id);
    if (typeof ss !== 'undefined') {
      df = { id: ss.id, path: ss.path };
      // Don't worry about where we put it -- it will be re-sorted later
      profile.differential.element.push(df);
    }
  }
  return df;
}

function getFHIRElementByID(elements, id) {
  return elements.find(e => e.id == id);
}

var sliceIDCounters = new Map();

function addSlicingToBaseElement(structureDef, snapshotEl, differentialEl, discType, discPath) {
  if (typeof snapshotEl.slicing !== 'undefined') {
    // A slicing already exists, so just add the missing discriminator
    if (!MVH.edSlicingDiscriminator(structureDef, snapshotEl).some(d => d.type == discType && d.path == discPath)) {
      snapshotEl.slicing.discriminator.push(MVH.convertDiscriminator(structureDef, { type: discType, path: discPath }));
    }
  } else {
    snapshotEl.slicing = createSlicingObject(structureDef, discType, discPath);
  }
  if (typeof differentialEl !== 'undefined' && differentialEl != null) {
    differentialEl.slicing = snapshotEl.slicing;
  }
}

function createSlicingObject(structureDef, discType, discPath) {
  if (!sliceIDCounters.has(structureDef.id)) {
    sliceIDCounters.set(structureDef.id, { count: 1});
  }
  const slicing = {
    id : `${sliceIDCounters.get(structureDef.id).count++}`,
    discriminator : [
      MVH.convertDiscriminator(structureDef, { type: discType, path: discPath })
    ],
    ordered : false,
    rules : 'open'
  };
  return slicing;
}

function elementTypeContainsTypeName(elementType, typeName) {
  for (const t of elementType) {
    if (t.code == typeName
        || MVH.typeProfile(t) == `http://hl7.org/fhir/StructureDefinition/${typeName}`
        || (t.code == 'Reference' && MVH.typeTargetProfile(t) == `http://hl7.org/fhir/StructureDefinition/${typeName}`)) {
      return true;
    }
  }
  return false;
}

function fhirID(identifier, extra = '') {
  const id = `${identifier.namespace.replace(/\./g, '-')}-${identifier.name}`;
  if (extra.length > 0) {
    return `${id}-${extra}`;
  }
  return id;
}

function fhirURL(identifier, configuredURL, extra = '') {
  return `${configuredURL}/StructureDefinition/${fhirID(identifier, extra)}`;
}

function shortID(identifier, camel=false) {
  return camel ? lowerFirst(identifier.name) : identifier.name.toLowerCase();
}

function valueAndFields(element) {
  if (typeof element.value !== 'undefined') {
    return [element.value, ...element.fields];
  }
  return element.fields;
}

function valueName(value) {
  let name;
  if (value instanceof mdls.ChoiceValue) {
    const opts = value.aggregateOptions;
    // If it's only 2 choices, spell them out, otherwise just say "Choice of types"
    if (opts.length <= 2) {
      name = opts.map(o => valueName(o)).join(' or ');
    } else {
      name = 'Choice of types';
    }
  } else if (value instanceof mdls.TBD) {
    name = value.toString();
  } else if (['Coding', 'CodeableConcept'].indexOf(value.identifier.name) != -1) {
    name = 'code';
  } else {
    name = value.identifier.name;
  }
  return name;
}

function equalShrElementPaths(path1, path2) {
  if (path1.length != path2.length) {
    return false;
  }
  return path1.every((id, i) => id.equals(path2[i]));
}

function escapeHTML(unsafe = '') {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function cloneJSON(json) {
  if (typeof json !== 'undefined' && json != null) {
    return JSON.parse(JSON.stringify(json));
  }
}

function capitalize(string) {
  if (typeof string === 'string') {
    return string.charAt(0).toUpperCase() + string.slice(1);
  }
  return string;
}

function lowerFirst(string) {
  if (typeof string === 'string') {
    return string.charAt(0).toLowerCase() + string.slice(1);
  }
  return string;
}

function todayString() {
  const pad = (n) => n < 10 ? '0' + n : n;
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}

function isCustomProfile(profile) {
  return profile._shr;
}

function typeToString(type) {
  if (typeof type === 'string') {
    return type;
  } else if (typeof type === 'object') {
    if (MVH.typeProfile(type)) {
      return MVH.typeProfile(type);
    } else if (MVH.typeTargetProfile(type)) {
      return MVH.typeTargetProfile(type);
    } else if (type.code) {
      return type.code;
    }
  }
  // If we got here, we don't really know how to handle it, so...
  return `${type}`;
}

function trim(text) {
  if (typeof text === 'string') {
    return text.trim();
  }
  return text;
}

function getTarget(config, specs) {
  if (config && config.fhirTarget && config.fhirTarget.length > 0) {
    if (config.fhirTarget === 'FHIR_STU_3' || config.fhirTarget === 'FHIR_DSTU_2') {
      return config.fhirTarget;
    }
    throw new Error(`Unsupported fhirTarget in config: "${config.fhirTarget}".  Valid choices are "FHIR_STU_3" and "FHIR_DSTU_2".`);
  }
  const targets = specs.maps.targets.filter(t => t === 'FHIR_DSTU_2' || t === 'FHIR_STU_3');
  if (targets.length === 0) {
    return 'FHIR_STU_3'; // it doesn't really matter because nothing will get produced
  } else if (targets.length === 1) {
    return targets[0];
  }
  throw new Error(`Multiple FHIR targets found in mapping files.  Specify a single target in the config using the "fhirTarget" key.  Valid choices are "FHIR_STU_3" and "FHIR_DSTU_2".`);
}

class ProcessTracker {
  constructor() {
    this._map = {};
  }

  start(...ids) {
    for (let id of ids) {
      if (!this._map[id]) {
        this._map[id] = 0;
      }
      this._map[id] = this._map[id] + 1;
    }
  }

  stop(...ids) {
    for (let id of ids) {
      this._map[id] = this._map[id] - 1;
      if (this._map[id] === 0) {
        delete(this._map[id]);
      }
    }
  }

  isActive(id) {
    return this._map[id] && this._map[id] > 0;
  }
}

class FHIRExportError extends Error {
  constructor(message = 'FHIR export error') {
    super(message);
    this.message = message;   // from Error
    this.name = 'FHIRExportError'; // from Error
  }
}

module.exports = {FHIRExportError, getSnapshotElement, getSnapshotElementById, getDifferentialElementById, addSlicingToBaseElement, createSlicingObject, elementTypeContainsTypeName, fhirID, fhirURL, shortID, valueAndFields, valueName, equalShrElementPaths, escapeHTML, cloneJSON, capitalize, lowerFirst, todayString, isCustomProfile, typeToString, trim, getTarget, ProcessTracker};