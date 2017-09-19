function getSnapshotElement(profile, target) {
  // NOTE: The validateChoice argument allows this to work in the differential, when there might be a value[x],
  // but since the choice didn't change, there is no type array in the differential.
  // TODO: If path isn't in elements, but is valid by drilling into a type, what then?
  let choice;
  let parts = target.split('.');
  if (parts.length > 1 && parts[parts.length-2].endsWith('[x]')) {
    // The last part of the path is the actual choice, but the real path ends with [x]
    choice = parts.pop();
  }
  let path = `${profile.type}.${parts.join('.')}`;
  const el = profile.snapshot.element.find(e => e.path == path);
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

function getDifferentialElementById(profile, id) {
  return getFHIRElementByID(profile.differential.element, id);
}

function getFHIRElementByID(elements, id) {
  return elements.find(e => e.id == id);
}

var idCounter = 1;

function addSlicingToBaseElement(snapshotEl, differentialEl, discType, discPath) {
  if (typeof snapshotEl.slicing !== 'undefined') {
    // A slicing already exists, so just add the missing discriminator
    if (!snapshotEl.slicing.discriminator.some(d => d.type == discType && d.path == discPath)) {
      snapshotEl.slicing.discriminator.push({ type: discType, path: discPath });
    }
  } else {
    snapshotEl.slicing = createSlicingObject(discType, discPath);
  }
  if (typeof differentialEl !== 'undefined' && differentialEl != null) {
    differentialEl.slicing = snapshotEl.slicing;
  }
}

function createSlicingObject(discType, discPath) {
  const slicing = {
    id : (idCounter++).toString(),
    discriminator : [{
      type: discType,
      path: discPath
    }],
    ordered : false,
    rules : 'open'
  };
  return slicing;
}

function elementTypeContainsTypeName(elementType, typeName) {
  for (const t of elementType) {
    if (t.code == typeName
        || t.profile == `http://hl7.org/fhir/StructureDefinition/${typeName}`
        || (t.code == 'Reference' && t.targetProfile == `http://hl7.org/fhir/StructureDefinition/${typeName}`)) {
      return true;
    }
  }
  return false;
}

function fhirID(identifier, extra = '') {
  const id = `${identifier.namespace.replace('.', '-')}-${identifier.name}`;
  if (extra.length > 0) {
    return `${id}-${extra}`;
  }
  return id;
}

function fhirURL(identifier, configuredURL, isExtension=false) {
  let extra;
  if (isExtension) {
    extra = 'extension';
  }
  return `${configuredURL}/StructureDefinition/${fhirID(identifier, extra)}`;
}

function shortID(identifier) {
  return identifier.name.toLowerCase();
}

function valueAndFields(element) {
  if (typeof element.value !== 'undefined') {
    return [element.value, ...element.fields];
  }
  return element.fields;
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

class FHIRExportError extends Error {
  constructor(message = 'FHIR export error') {
    super(message);
    this.message = message;   // from Error
    this.name = 'FHIRExportError'; // from Error
  }
}

module.exports = {FHIRExportError, getSnapshotElement, getSnapshotElementById, getDifferentialElementById, addSlicingToBaseElement, createSlicingObject, elementTypeContainsTypeName, fhirID, fhirURL, shortID, valueAndFields, equalShrElementPaths, escapeHTML, cloneJSON};