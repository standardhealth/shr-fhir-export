/**
 * Gets the value of a property from a definition, looking at the fhir version to determine whether to get r2 or r3
 * @param {Object} rootDef - the definition to get the fhirVersion from
 * @param {Object} targetDef - the definition to get the property from
 * @param {string|function} r2NameOrFunction - the string name of the r2 property or a no-arg function to get the r2 property
 * @param {string|function} r3NameOrFunction - the string name of the r3 property or a no-arg function to get the r3 property
 * @returns {any} the value of the property in the definition
 */
function get(rootDef, targetDef, r2NameOrFunction, r3NameOrFunction) {
  if (rootDef.fhirVersion === '1.0.2') {
    return typeof r2NameOrFunction === 'string' ? targetDef[r2NameOrFunction] : r2NameOrFunction();
  }
  return typeof r3NameOrFunction === 'string' ? targetDef[r3NameOrFunction] : r3NameOrFunction();
}

/**
 * Sets the value of a property on a definition, looking at the fhir version to determine whether to set r2 or r3
 * @param {Object} rootDef - the definition to get the fhirVersion from
 * @param {Object} targetDef - the definition to set the property on
 * @param {any} value - the value to set
 * @param {string|function} r2NameOrFunction - the string name of the r2 property or a no-arg function to set the r2 property
 * @param {string|function} r3NameOrFunction - the string name of the r3 property or a no-arg function to set the r3 property
 */
function set(rootDef, targetDef, value, r2NameOrFunction, r3NameOrFunction) {
  if (rootDef.fhirVersion === '1.0.2') {
    if (typeof r2NameOrFunction === 'string') {
      targetDef[r2NameOrFunction] = value;
    } else {
      r2NameOrFunction();
    }
  } else {
    if (typeof r3NameOrFunction === 'string') {
      targetDef[r3NameOrFunction] = value;
    } else {
      r3NameOrFunction();
    }
  }
}

/**
 * Deletes a property on a definition, looking at the fhir version to determine whether to delete r2 or r3
 * @param {Object} rootDef - the definition to get the fhirVersion from
 * @param {Object} targetDef - the definition to delete the property from
 * @param {string|function} r2NameOrFunction - the string name of the r2 property or a no-arg function to delete the r2 property
 * @param {string|function} r3NameOrFunction - the string name of the r3 property or a no-arg function to delete the r3 property
 */
function del(rootDef, targetDef, r2NameOrFunction, r3NameOrFunction) {
  if (rootDef.fhirVersion === '1.0.2') {
    if (typeof r2NameOrFunction === 'string') {
      delete targetDef[r2NameOrFunction];
    } else {
      r2NameOrFunction();
    }
  } else {
    if (typeof r3NameOrFunction === 'string') {
      delete targetDef[r3NameOrFunction];
    } else {
      r3NameOrFunction();
    }
  }
}

/**
 * Gets the version-specific property name, looking at the fhir version to determine whether to get r2 or r3
 * @param {Object} rootDef - the definition to get the fhirVersionFrom
 * @param {string} r2Name - the name of the r2 property
 * @param {string} r3Name - the name of the r3 property
 * @returns {string} the version-specific property name
 */
function name(rootDef, r2Name, r3Name) {
  if (rootDef.fhirVersion === '1.0.2') {
    return r2Name;
  }
  return r3Name;
}

/**
 * Getter for R3 ElementDefinition sliceName and its equivalents
 * R2: name
 * R3: sliceName
 * @param {Object} structDef - the StructureDefinition the ElementDefinition belongs to
 * @param {Object} elDef - the ElementDefinition to get the sliceName for
 * @returns {string} the sliceName
 */
function edSliceName(structDef, elDef) {
  return get(structDef, elDef, 'name', 'sliceName');
}

/**
 * Setter for R3 ElementDefinition sliceName and its equivalents
 * R2: name
 * R3: sliceName
 * @param {Object} structDef - the StructureDefinition the ElementDefinition belongs to
 * @param {Object} elDef - the ElementDefinition to set the sliceName on
 * @param {string} sliceName - the sliceName to set
 */
function setEdSliceName(structDef, elDef, sliceName) {
  set(structDef, elDef, sliceName, 'name', 'sliceName');
}

/**
 * Delete R3 ElementDefinition sliceName and its equivalents
 * R2: name
 * R3: sliceName
 * @param {Object} structDef - the StructureDefinition the ElementDefinition belongs to
 * @param {Object} elDef - the ElementDefinition to delete the sliceName from
 */
function deleteEdSliceName(structDef, elDef) {
  del(structDef, elDef, 'name', 'sliceName');
}

/**
 * Get the version-specific property name for R3 ElementDefinition sliceName
 * R2: name
 * R3: sliceName
 * @param {Object} structDef - the StructureDefinition the ElementDefinition belongs to
 * @return {string} the version-specific name for the sliceName property
 */
function nameOfEdSliceName(structDef) {
  return name(structDef, 'name', 'sliceName');
}

/**
 * Getter for R3 StructureDefinition baseDefinition and its equivalents
 * R2: base
 * R3: baseDefinition
 * @param {Object} structDef - the StructureDefinition to get the baseDefinition for
 * @returns {string} the URI base definition
 */
function sdBaseDefinition(structDef) {
  return get(structDef, structDef, 'base', 'baseDefinition');
}

/**
 * Setter for R3 StructureDefinition baseDefinition and its equivalents
 * R2: base
 * R3: baseDefinition
 * @param {Object} structDef - the StructureDefinition to set the baseDefinition on
 * @param {string} uri - the URI to set as the baseDefinition
 */
function setSdBaseDefinition(structDef, uri) {
  set(structDef, structDef, uri, 'base', 'baseDefinition');
}

/**
 * Getter for R3 StructureDefinition keyword and its equivalents
 * R2: code
 * R3: keyword
 * @param {Object} structDef - the StructureDefinition to get the keyword for
 * @returns {Object} the keyword
 */
function sdKeyword(structDef) {
  return get(structDef, structDef, 'code', 'keyword');
}

/**
 * Setter for R3 StructureDefinition keyword and its equivalents
 * R2: code
 * R3: keyword
 * @param {Object} structDef - the StructureDefinition to set the keyword on
 * @param {Object} keyword - the keyword to set
 */
function setSdKeyword(structDef, keyword) {
  set(structDef, structDef, keyword, 'code', 'keyword');
}

/**
 * Getter for R3 StructureDefinition title and its equivalents
 * R2: display
 * R3: title
 * @param {Object} structDef - the StructureDefinition to get the title for
 * @returns {string} the title
 */
function sdTitle(structDef) {
  return get(structDef, structDef, 'display', 'title');
}

/**
 * Setter for R3 StructureDefinition title and its equivalents
 * R2: display
 * R3: title
 * @param {Object} structDef - the StructureDefinition to set the title on
 * @param {string} title - the title to set
 */
function setSdTitle(structDef, title) {
  set(structDef, structDef, title, 'display', 'title');
}

/**
 * Getter for R3 StructureDefinition type and its equivalents
 * R2: constrainedType or path of first snapshot element
 * R3: type
 * @param {Object} structDef - the StructureDefinition to get the type for
 * @returns {string} - the type
 */
function sdType(structDef) {
  const r2Func = () => {
    if (structDef.constrainedType != null) {
      return structDef.constrainedType;
    } else if (structDef.snapshot && structDef.snapshot.element && structDef.snapshot.element.length > 0) {
      return structDef.snapshot.element[0].path;
    }
    return '';
  };
  return get(structDef, structDef, r2Func, 'type');
}

/**
 * Setter for R3 StructureDefinition type and its equivalents
 * R2: constrainedType (but only if constraining)
 * R3: type
 * @param {Object} structDef - the StructureDefinition to set the type on
 * @param {string} type - the type to set
 */
function setSdType(structDef, type) {
  const r2Func = (structDef, value) => {
    // only set constrainedType if it really is constrained
    if (sdType(structDef) !== type) {
      structDef.constrainedType = type;
    }
  };
  set(structDef, structDef, type, r2Func, 'type');
}

/**
 * Getter for R3 ValueSet title and its equivalents
 * R2: name
 * R3: title
 * @param {Object} valueSet - the ValueSet to get the title for
 * @returns {string} the title
 */
function vsTitle(valueSet) {
  return get(valueSet, valueSet, 'name', 'title');
}

/**
 * Setter for R3 ValueSet title and its equivalents
 * R2: name
 * R3: title
 * @param {Object} valueSet - the ValueSet to set the title on
 * @param {string} title - the title to set
 */
function setVsTitle(valueSet, title) {
  set(valueSet, valueSet, title, 'name', 'title');
}

module.exports = { edSliceName, setEdSliceName, deleteEdSliceName, nameOfEdSliceName, sdBaseDefinition, setSdBaseDefinition, sdKeyword, setSdKeyword, sdTitle, setSdTitle, sdType, setSdType, vsTitle, setVsTitle };