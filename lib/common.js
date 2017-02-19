function getSnapshotElement(profile, target) {
  return getFHIRElement(profile.type, profile.snapshot.element, target);
}

function getDifferentialElement(profile, target) {
  return getFHIRElement(profile.type, profile.differential.element, target);
}

function getFHIRElement(targetItem, elements, target) {
  // TODO: If path isn't in elements, but is valid by drilling into a type, what then?
  const path = `${targetItem}.${target}`;
  for (const el of elements) {
    if (el.path == path) {
      return el;
    }
  }
}

function fhirID(identifier, extra = '') {
  const id = `${identifier.namespace.replace('.', '-')}-${identifier.name}`;
  if (extra.length > 0) {
    return `${id}-${extra}`;
  }
  return id;
}

function fhirURL(identifier, isExtension=false) {
  if (identifier.isPrimitive && isExtension) {
    return identifier.name;
  }
  let extra;
  if (isExtension) {
    extra = 'extension';
  }
  return `http://standardhealthrecord.org/fhir/StructureDefinition/${fhirID(identifier, extra)}`;
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

module.exports = {getSnapshotElement, getDifferentialElement, getFHIRElement, fhirID, fhirURL, shortID, valueAndFields, escapeHTML, cloneJSON};