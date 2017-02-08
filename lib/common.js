const mdls = require('shr-models');

function getSnapshotElement(profile, targetPath) {
  return getElement(profile.type, profile.snapshot.element, targetPath);
}

function getDifferentialElement(profile, targetPath) {
  return getElement(profile.type, profile.differential.element, targetPath);
}

function getElement(targetItem, elements, targetPath) {
  // TODO: If path isn't in elements, but is valid by drilling into a type, what then?
  const path = `${targetItem}.${targetPath.join('.')}`;
  for (const el of elements) {
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

function aggregateChoiceOptions(choice) {
  const options = [];
  for (const opt of choice.options) {
    if (opt instanceof mdls.ChoiceValue) {
      options.push(...this.aggregateChoiceOptions(opt));
    } else {
      options.push(opt);
    }
  }
  return options;
}

function cloneJSON(json) {
  return JSON.parse(JSON.stringify(json));
}

module.exports = {getSnapshotElement, getDifferentialElement, getElement, fhirID, fhirURL, shortID, valueAndFields, aggregateChoiceOptions, cloneJSON};