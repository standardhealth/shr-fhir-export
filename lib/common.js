function getSnapshotElement(profile, targetPath) {
  // TODO: If path isn't in snapshot, but is valid by drilling into a type, what then?
  const path = `${profile.type}.${targetPath.join('.')}`;
  for (const el of profile.snapshot.element) {
    if (el.path == path) {
      return el;
    }
  }
}

function getDifferentialElement(profile, targetPath) {
  // TODO: If path isn't in differential, but is valid by drilling into a type, what then?
  const path = `${profile.type}.${targetPath.join('.')}`;
  for (const el of profile.differential.element) {
    if (el.path == path) {
      return el;
    }
  }
}

function fhirID(identifier, isExtension=false) {
  const id = `${identifier.namespace.replace('.', '-')}-${identifier.name.toLowerCase()}`;
  if (isExtension) {
    return `${id}-extension`;
  }
  return id;
}

function fhirURL(identifier, isExtension=false) {
  if (identifier.isPrimitive && isExtension) {
    return identifier.name;
  }
  return `http://standardhealthrecord.org/fhir/StructureDefinition/${fhirID(identifier, isExtension)}`;
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

function cloneJSON(json) {
  return JSON.parse(JSON.stringify(json));
}

module.exports = {getSnapshotElement, getDifferentialElement, fhirID, fhirURL, shortID, valueAndFields, cloneJSON};