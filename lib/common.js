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

function getFHIRTypeHierarchy(fhirDefinitions, fhirType) {
  const type = fhirDefinitions.find(fhirType);
  if (typeof type === 'undefined') {
    return [];
  }
  const baseDef = MVH.sdBaseDefinition(type);
  if (typeof baseDef !== 'undefined') {
    const baseType = fhirDefinitions.find(baseDef);
    if (baseType) {
      return [type.id, ...getFHIRTypeHierarchy(fhirDefinitions, baseType.id)];
    }
  }
  return [type.id];
}

var sliceIDCounters = new Map();

function hasSlicingOnBaseElement(structureDef, snapshotEl, discType, discPath) {
  if (snapshotEl.slicing == null) {
    return false;
  }
  if (structureDef.fhirVersion === '1.0.2') {
    // Since we lose the ".resolve" on round-tripping a discriminator, compare based on the converted DSTU2 discriminators
    const dstu2Disc = MVH.convertDiscriminator(structureDef, { type: discType, path: discPath });
    const dstu2Discs = MVH.edSlicingDiscriminator(structureDef, snapshotEl).map(d => MVH.convertDiscriminator(structureDef, d));
    return dstu2Discs.indexOf(dstu2Disc) !== -1;
  }
  return MVH.edSlicingDiscriminator(structureDef, snapshotEl).some(d => d.type == discType && d.path == discPath);
}

function addSlicingToBaseElement(structureDef, snapshotEl, differentialEl, discType, discPath) {
  if (typeof snapshotEl.slicing !== 'undefined') {
    // A slicing already exists, so just add the missing discriminator
    if (!hasSlicingOnBaseElement(structureDef, snapshotEl, discType, discPath)) {
      snapshotEl.slicing.discriminator.push(MVH.convertDiscriminator(structureDef, { type: discType, path: discPath }));
    } else {
      return; // nothing was changed, so return before we modify the differential
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
        || MVH.typeHasProfile(t, `http://hl7.org/fhir/StructureDefinition/${typeName}`)
        || (t.code == 'Reference' && MVH.typeHasTargetProfile(t, `http://hl7.org/fhir/StructureDefinition/${typeName}`))) {
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
  } else {
    name = value.identifier.name;
  }
  return name;
}

/**
 * Gets an effective Identifier for both IdentifiableValue and ChoiceValue (when applicable):
 * - for IdentifiableValue, it will be value.effectiveIdentifier
 * - for ChoiceValue, it will return an identifier *iff* there is a single TypeConstraint
 * @param {Object} value - the value to get the effective identifier from
 */
function choiceFriendlyEffectiveIdentifier(value) {
  if (value.effectiveIdentifier) {
    return value.effectiveIdentifier;
  }
  const ownTypeConstraints = value.constraintsFilter.own.type.constraints;
  if (value instanceof mdls.ChoiceValue && ownTypeConstraints.length === 1) {
    return ownTypeConstraints[0].isA;
  }
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
    if (MVH.typeProfile(type) && MVH.typeProfile(type).length === 1) {
      return MVH.typeProfile(type)[0];
    } else if (MVH.typeTargetProfile(type) && MVH.typeTargetProfile(type).length === 1) {
      return MVH.typeTargetProfile(type)[0];
    } else if (type.code) {
      return type.code;
    }
  }
  // If we got here, we don't really know how to handle it, so...
  return `${type}`;
}

function getUnrollableType(type) {
  const profiles = MVH.typeProfile(type);
  const targetProfiles = MVH.typeTargetProfile(type);
  // Only return the profile or targetProfile if its the only one, otherwise it's better to return common base type
  if (profiles && profiles.length === 1) {
    return profiles[0];
  } else if (targetProfiles && targetProfiles.length === 1) {
    return targetProfiles[0];
  }
  return type.code;
}

function trim(text) {
  if (typeof text === 'string') {
    return text.trim();
  }
  return text;
}

function getTarget(config, specs) {
  if (config && config.fhirTarget && config.fhirTarget.length > 0) {
    if (config.fhirTarget === 'FHIR_R4' ||config.fhirTarget === 'FHIR_STU_3' || config.fhirTarget === 'FHIR_DSTU_2') {
      return config.fhirTarget;
    }
    throw new Error(`Unsupported fhirTarget in config: "${config.fhirTarget}".  Valid choices are "FHIR_R4", "FHIR_STU_3", and "FHIR_DSTU_2".`);
  }
  const targets = specs.maps.targets.filter(t => t === 'FHIR_R4' || t === 'FHIR_STU_3' || t === 'FHIR_DSTU_2');
  if (targets.length === 0) {
    return 'FHIR_R4'; // it doesn't really matter because nothing will get produced
  } else if (targets.length === 1) {
    return targets[0];
  }
  throw new Error(`Multiple FHIR targets found in mapping files.  Specify a single target in the config using the "fhirTarget" key.  Valid choices are "FHIR_R4", "FHIR_STU_3", and "FHIR_DSTU_2".`);
}

/**
 * Compact the structure definition by removing meaningless differential elements and removing "unrolled" child elements that
 * don't actually represent any differences.  Sometimes we end up with these things because of how profiles are processed, but
 * we don't really need them once the profile is done.
 * @param {Object} sd - the StructureDefinition to compact.  This function directly mutates the passed in StructureDefinition.
 */
function compactStructureDefinition(sd) {
  // First remove any differential elements that are just id/path and don't have any non-trivial child differential elements
  sd.differential.element = sd.differential.element.filter((el, i) => {
    const keys = Object.keys(el);
    if (keys.length <= 2 && keys.every(k => k === 'id' || k === 'path')) {
      // We know that children will be directly after it and will start with the same path
      for (let j=i+1; j < sd.differential.element.length && sd.differential.element[j].path.startsWith(`${el.path}.`); j++) {
        const childEl = sd.differential.element[j];
        const childKeys = Object.keys(childEl);
        if (childKeys.length > 2 || childKeys.some(k => k !== 'id' && k !== 'path')) {
          // It has a non trivial descendent, so keep it
          return true;
        }
      }
      // It has no meaningful child differentials so filter it out
      return false;
    }
    // It's non-trivial so keep it
    return true;
  });

  // Now filter out any child elements that do not need to be present in the snapshot because neither they nor their siblings
  // are represented in the differential.  Note -- if their parent is a BackboneElement, however, then do not filter them out.
  const compactParents = [];
  sd.snapshot.element = sd.snapshot.element.filter((el) => {
    // If its parent is flagged to be compacted, then filter it out
    if (compactParents.some(p => el.id.startsWith(`${p}.`))) {
      return false;
    }
    // If it's a backbone element, keep it and don't mark it to be compacted
    if (el.type && el.type.length === 1 && el.type[0].code === 'BackboneElement') {
      return true;
    }
    // If it has children in the differential, keep it and don't mark it to be compacted
    if (sd.differential.element.some(df => df.id.startsWith(`${el.id}.`))) {
      return true;
    }
    // Otherwise, it's not a BackboneElement and has no children in the differential, so keep it, but mark it as a compacted element
    compactParents.push(el.id);
    return true;
  });

}

/**
 * Replaces all non-computer-friendly characters with _ and truncates to 255 characters
 * @param {string} str - the string to tokenize
 */
function tokenize(str = '') {
  str = str.replace(/[^A-Za-z0-9]+/g, '_').slice(0, 255);
  if (str.startsWith('_')) {
    str = str.slice(1);
  }
  if (str.endsWith('_')) {
    str = str.slice(0, -1);
  }
  return str;
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

class TargetItem {
  constructor(target, commands=[], comments) {
    this._target = target;
    this._commands = commands;
    this._comments = comments;
  }

  static parse(itemTarget) {
    const matches = /([^\s\(]+)(\s+\((.+)\))?(\s+\/\/\s*(.*))?/.exec(itemTarget);
    if (matches == null || typeof matches[1] === 'undefined') {
      return;
    }
    const target = matches[1];
    let commands, comments;
    if (typeof matches[3] !== 'undefined') {
      commands = MappingCommand.parseMany(matches[3]);
    }
    if (typeof matches[5] !== 'undefined') {
      comments = matches[5];
    }
    return new TargetItem(target, commands, comments);
  }

  get target() { return this._target; }
  get commands() { return this._commands; }
  get comments() { return this._comments; }

  // The "noProfile" command indicates that no profile should be generated for the target item, despite any
  // differences.  This is used when you want to use a resource (like Patient) as-is.
  hasNoProfileCommand() {
    return this._commands.some(c => c.key == 'no profile');
  }
  findNoProfileCommand() {
    return this._commands.find(c => c.key == 'no profile');
  }
  addNoProfileCommand(at) {
    this._commands.push(new MappingCommand('no profile', at));
  }

  toItemTarget() {
    const commandStr = this._commands.length == 0 ? '' : ` (${this._commands.map(c => c.toString()).join('; ')})`;
    const commentsStr = typeof this._comments === 'undefined' ? '' : ` // ${this._comments}`;
    return `${this._target}${commandStr}${commentsStr}`;
  }
}

class FieldTarget {
  constructor(target, commands=[], comments) {
    this._target = target;
    this._commands = commands;
    this._comments = comments;
  }

  static parse(ruleTarget) {
    const matches = /([^\s\(]+)(\s+\((.+)\))?(\s+\/\/\s*(.*))?/.exec(ruleTarget);
    if (matches == null || typeof matches[1] === 'undefined') {
      return;
    }
    const target = matches[1];
    let commands, comments;
    if (typeof matches[3] !== 'undefined') {
      commands = MappingCommand.parseMany(matches[3]);
    }
    if (typeof matches[5] !== 'undefined') {
      comments = matches[5];
    }
    return new FieldTarget(target, commands, comments);
  }

  get target() { return this._target; }
  get commands() { return this._commands; }
  get comments() { return this._comments; }

  // Functions to check if the target is an extension and how its mapped (URL or element)
  isExtensionURL() {
    return /^https?:\/\//.test(this._target);
  }
  isExtensionPath() {
    return /^(.+\.)?(extension|modifierExtension)$/.test(this._target);
  }
  isExtension() {
    return this.isExtensionURL() || this.isExtensionPath();
  }

  // The "slice at" command indicates the path where the slicing is rooted.  This is only needed when the target
  // path is *not* where the root of the slice should be (for example, if the target is not multiple cardinality).
  hasSliceAtCommand() {
    return this._commands.some(c => c.key == 'slice at');
  }
  findSliceAtCommand() {
    return this._commands.find(c => c.key == 'slice at');
  }
  addSliceAtCommand(at) {
    this._commands.push(new MappingCommand('slice at', at));
  }

  // The "slice on" command indicates what FHIR calls the "discriminator path".
  hasSliceOnCommand() {
    return this._commands.some(c => c.key == 'slice on');
  }
  findSliceOnCommand() {
    return this._commands.find(c => c.key == 'slice on');
  }
  addSliceOnCommand(on) {
    this._commands.push(new MappingCommand('slice on', on));
  }

  // The "slice on type" command indicates what FHIR calls the "discriminator type".
  // If not set, the "value" type is typically used.
  hasSliceOnTypeCommand() {
    return this._commands.some(c => c.key == 'slice on type');
  }
  findSliceOnTypeCommand() {
    return this._commands.find(c => c.key == 'slice on type');
  }
  addSliceOnTypeCommand(on) {
    this._commands.push(new MappingCommand('slice on type', on));
  }

  // The "in slice" command is for elements to indicate what slice they belong to (by slice name).
  // This is not typically set in the mapping file, but rather, applied by the shr-fhir-export logic.
  hasInSliceCommand() {
    return this._commands.some(c => c.key == 'in slice');
  }
  findInSliceCommand() {
    return this._commands.find(c => c.key == 'in slice');
  }
  addInSliceCommand(sliceName) {
    this._commands.push(new MappingCommand('in slice', sliceName));
  }

  // The "slice #" command is used to map elements to an existing slice (when mapping to a profile).
  // We use slice # since slice name isn't easily exposed in IG documentation.  Slice # starts with 1.
  hasSliceNumberCommand() {
    return this._commands.some(c => c.key == 'slice #');
  }
  findSliceNumberCommand() {
    return this._commands.find(c => c.key == 'slice #');
  }
  addSliceNumberCommand(sliceNumber) {
    this._commands.push(new MappingCommand('slice #', sliceNumber));
  }

  // The "slice strategy" command currently only supports one strategy: "includes".  If not set, then it slices
  // based on mappings that share target paths.
  hasSliceStrategyCommand() {
    return this._commands.some(c => c.key == 'slice strategy');
  }
  findSliceStrategyCommand() {
    return this._commands.find(c => c.key == 'slice strategy');
  }
  addSliceStrategyCommand(strategy) {
    this._commands.push(new MappingCommand('slice strategy', strategy));
  }

  toRuleTarget() {
    const commandStr = this._commands.length == 0 ? '' : ` (${this._commands.map(c => c.toString()).join('; ')})`;
    const commentsStr = typeof this._comments === 'undefined' ? '' : ` // ${this._comments}`;
    return `${this._target}${commandStr}${commentsStr}`;
  }
}

class MappingCommand {
  constructor(key, value) {
    this._key = key;
    this._value = value;
  }

  static parseSingle(command) {
    const [k, v] = command.split('=', 2).map(s => s.trim());
    return new MappingCommand(k, v);
  }

  static parseMany(commands) {
    return commands.split(';').map(c => MappingCommand.parseSingle(c));
  }

  get key() { return this._key; }
  get value() { return this._value; }

  toString() {
    return `${this._key} = ${this._value}`;
  }
}

class FHIRExportError extends Error {
  constructor(message = 'FHIR export error') {
    super(message);
    this.message = message;   // from Error
    this.name = 'FHIRExportError'; // from Error
  }
}

module.exports = {FHIRExportError, getSnapshotElement, getSnapshotElementById, getDifferentialElementById, getFHIRTypeHierarchy, hasSlicingOnBaseElement, addSlicingToBaseElement, createSlicingObject, elementTypeContainsTypeName, fhirID, fhirURL, shortID, valueAndFields, valueName, choiceFriendlyEffectiveIdentifier, equalShrElementPaths, escapeHTML, cloneJSON, capitalize, lowerFirst, todayString, isCustomProfile, typeToString, getUnrollableType, trim, getTarget, compactStructureDefinition, tokenize, ProcessTracker, TargetItem, FieldTarget, MappingCommand};