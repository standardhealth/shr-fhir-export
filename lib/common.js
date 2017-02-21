function getSnapshotElement(profile, target) {
  return getFHIRElement(profile.type, profile.snapshot.element, target);
}

function getDifferentialElement(profile, target) {
  return getFHIRElement(profile.type, profile.differential.element, target, false);
}

function getFHIRElement(targetItem, elements, target, validateChoice=true) {
  // NOTE: The validateChoice argument allows this to work in the differential, when there might be a value[x],
  // but since the choice didn't change, there is no type array in the differential.
  // TODO: If path isn't in elements, but is valid by drilling into a type, what then?
  let choice;
  let parts = target.split('.');
  if (parts.length > 1 && parts[parts.length-2].endsWith('[x]')) {
    // The last part of the path is the actual choice, but the real path ends with [x]
    choice = parts.pop();
  }
  let path = `${targetItem}.${parts.join('.')}`;
  for (const el of elements) {
    if (el.path == path) {
      if (validateChoice && typeof choice != 'undefined') {
        if (!elementTypeContainsTypeName(el.type, choice)) {
          return; // it's not a valid choice!
        }
      }
      return el;
    }
  }
}

function elementTypeContainsTypeName(elementType, typeName) {
  const found = elementType.some(t => {
    return t.code == typeName
    || t.profile == `http://hl7.org/fhir/StructureDefinition/${typeName}`
    || (t.code == 'Reference' && t.targetProfile == `http://hl7.org/fhir/StructureDefinition/${typeName}`);
  });
  return found;
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

module.exports = {getSnapshotElement, getDifferentialElement, getFHIRElement, elementTypeContainsTypeName, fhirID, fhirURL, shortID, valueAndFields, escapeHTML, cloneJSON};