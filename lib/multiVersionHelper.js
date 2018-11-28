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
 * Gets the version-specific ContactDetail
 * @param {Object} rootDef - the definition to get the fhirVersionFrom
 * @param {Object} contactDetail - the ContactDetail to convert based on FHIR version
 * @returns {Object} the version-specific ContactDetail
 */
function convertContactDetail(rootDef, contactDetail) {
  if (rootDef.fhirVersion === '1.0.2') {
    if (contactDetail && contactDetail.telecom && contactDetail.telecom.some(t => t.system === 'url')) {
      const clone = JSON.parse(JSON.stringify(contactDetail));
      clone.telecom.forEach(t => {
        if (t.system === 'url') {
          t.system = 'other';
        }
      });
      return clone;
    }
  }
  return contactDetail;
}

/**
 * Gets the version-specific ContactDetails array
 * @param {Object} rootDef - the definition to get the fhirVersionFrom
 * @param {Object[]} contactDetails - the ContactDetails array to convert based on FHIR version
 * @returns {Object} the version-specific ContactDetails array
 */
function convertContactDetails(rootDef, contactDetails) {
  if (contactDetails && rootDef.fhirVersion === '1.0.2') {
    return contactDetails.map(c => convertContactDetail(rootDef, c));
  }
  return contactDetails;
}

/**
 * Getter for R3 ElementDefinition comment and its equivalents
 * R2: comments
 * R3: comment
 * @param {Object} structDef - the StructureDefinition the ElementDefinition belongs to
 * @param {Object} elDef - the ElementDefinition to get the comment for
 * @returns {string} the comment
 */
function edComment(structDef, elDef) {
  return get(structDef, elDef, 'comments', 'comment');
}

/**
 * Setter for R3 ElementDefinition comment and its equivalents
 * R2: comments
 * R3: comment
 * @param {Object} structDef - the StructureDefinition the ElementDefinition belongs to
 * @param {Object} elDef - the ElementDefinition to set the comment on
 * @param {string} comment - the comment to set
 */
function setEdComment(structDef, elDef, comment) {
  set(structDef, elDef, comment, 'comments', 'comment');
}

/**
 * Delete R3 ElementDefinition comment and its equivalents
 * R2: comments
 * R3: comment
 * @param {Object} structDef - the StructureDefinition the ElementDefinition belongs to
 * @param {Object} elDef - the ElementDefinition to delete the comment from
 */
function deleteEdComment(structDef, elDef) {
  del(structDef, elDef, 'comments', 'comment');
}

/**
 * Getter for R3 ElementDefinition contentReference and its equivalents
 * R2: nameReference
 * R3: contentReference
 * @param {Object} structDef - the StructureDefinition the ElementDefinition belongs to
 * @param {Object} elDef - the ElementDefinition to get the contentReference for
 * @returns {string} the contentReference
 */
function edContentReference(structDef, elDef) {
  const r2Func = () => {
    // In R3, a '#' prefix is used to reference local names, so we need to add it.
    return elDef.nameReference != null ? `#${elDef.nameReference}`: elDef.nameReference;
  };
  return get(structDef, elDef, r2Func, 'contentReference');
}

/**
 * Setter for R3 ElementDefinition contentReference and its equivalents
 * R2: nameReference
 * R3: contentReference
 * @param {Object} structDef - the StructureDefinition the ElementDefinition belongs to
 * @param {Object} elDef - the ElementDefinition to set the contentReference on
 * @param {string} contentReference - the contentReference to set
 */
function setEdContentReference(structDef, elDef, contentReference) {
  const r2Func = () => {
    // In R3, a '#' prefix is used to reference local names. We need to remove it for R2.
    if (contentReference != null && contentReference.startsWith('#')) {
      elDef.nameReference = contentReference.slice(1);
    } else {
      elDef.nameReference = contentReference;
    }
  };
  set(structDef, elDef, contentReference, r2Func, 'contentReference');
}

/**
 * Delete R3 ElementDefinition contentReference and its equivalents
 * R2: nameReference
 * R3: contentReference
 * @param {Object} structDef - the StructureDefinition the ElementDefinition belongs to
 * @param {Object} elDef - the ElementDefinition to delete the contentReference from
 */
function deleteEdContentReference(structDef, elDef) {
  del(structDef, elDef, 'nameReference', 'contentReference');
}

/**
 * Getter for R3 ElementDefinition discriminator and its equivalents.  DSTU2 represents
 * discriminator as 0..* string, but STU3 changed it to 0..* object.  This function will always
 * return an array of STU3-formatted objects.
 * R2: slicing.discriminator (string)
 * R3: slicing.discriminator (object)
 * @param {Object} structDef - the StructureDefinition the ElementDefinition belongs to
 * @param {Object} elDef - the ElementDefinition to get the discriminator for
 * @returns {Object[]} the array of object-formatted discriminators
 */
function edSlicingDiscriminator(structDef, elDef) {
  if (elDef.slicing == null) {
    return undefined;
  } else if (elDef.slicing.discriminator == null || structDef.fhirVersion !== '1.0.2') {
    // Return it as-is
    return elDef.slicing.discriminator;
  }
  // Else we need to convert it to an STU3-formatted discriminator object
  return elDef.slicing.discriminator.map(d => {
    let dObj = { type: 'value', path: d }; // default STU3 representation
    // change dObj when the discriminator has @type or @profile keyword
    if (d === '@type') {
      dObj = { type: 'type', path: '$this' };
    } else if (d === '@profile') {
      dObj = { type: 'profile', path: '$this' };
    } else if (d.endsWith('.@type')) {
      dObj = { type: 'type', path: d.slice(0, d.length-6) };
    } else if (d.endsWith('.@profile')) {
      dObj = { type: 'profile', path: d.slice(0, d.length-9) };
    }
    // change extension("...") to extension["..."]
    dObj.path = dObj.path.replace(/\(/g, '[');
    dObj.path = dObj.path.replace(/\)/g, ']');
    // can't easily insert "resolve()" where references are, but that shouldn't be necessary
    return dObj;
  });
}

/**
 * Setter for R3 ElementDefinition discriminator and its equivalents.  DSTU2 represents
 * discriminator as 0..* string, but STU3 changed it to 0..* object.  This function expects input
 * to always be an array of objects, but will convert to an array of strings for DSTU2.
 * R2: slicing.discriminator (string)
 * R3: slicing.discriminator (object)
 * @param {Object} structDef - the StructureDefinition the ElementDefinition belongs to
 * @param {Object} elDef - the ElementDefinition to set the comment on
 * @param {Object[]} discriminator - the array of discriminators to set
 */
function setEdSlicingDiscriminator(structDef, elDef, discriminator) {
  if (discriminator == null || structDef.fhirVersion !== '1.0.2') {
    // Set it as-is
    elDef.slicing.discriminator = discriminator;
  } else {
    // Else we need to convert it
    elDef.slicing.discriminator = discriminator.map(d => convertDiscriminator(structDef, d));
  }
}

/**
 * Converts an R3 ElementDefinition discriminator to the target FHIR version if necessary.  DSTU2
 * represents discriminator as a string, but STU3 changed it to an object.  This function expects
 * input to always be the object, but will convert to a string for DSTU2.
 * R2: discriminator (string)
 * R3: discriminator (object)
 * @param {Object} structDef - the StructureDefinition the discriminator will be a part of
 * @param {Object} discriminator - the STU3 object-formatted discriminator to convert
 * @returns {Object|string} the potentially-converted discriminator
 */
function convertDiscriminator(structDef, discriminator) {
  if (discriminator == null || structDef.fhirVersion !== '1.0.2') {
    // return as-is
    return discriminator;
  }
  // Else we need to convert it
  let dStr = discriminator.path; // default
  // First handle discriminator type (exists and pattern will be treated like value)
  if (discriminator.type === 'type') {
    dStr = discriminator.path === '$this' ? '@type' : `${discriminator.path}.@type`;
  } else if (discriminator.type === 'profile') {
    dStr = discriminator.path === '$this' ? '@profile' : `${discriminator.path}.@profile`;
  } else if (discriminator.path === '$this') {
    // If there is a different type (exists/pattern/value) w/ $this, just use empty string
    dStr = '';
  }
  // change extension["..."] to extension("...")
  dStr = dStr.replace(/\[/g, '(');
  dStr = dStr.replace(/\]/g, ')');
  // remove .resolve() since DSTU2 does this implicitly
  dStr = dStr.replace(/\.resolve\(\)/g, '');
  return dStr;
}

/**
 * Getter for R3 ElementDefinition sliceName and its equivalents. This is tricky because in DSTU2
 * the "name" property was used both as a slice name and as a non-slice identifier (to be used
 * with nameReference).  This means that presence of "name" doesn't necessarily mean it's a slice.
 * Furthermore, Argonaut populates "name" on every element.
 * R2: name
 * R3: sliceName
 * @param {Object} structDef - the StructureDefinition the ElementDefinition belongs to
 * @param {Object} elDef - the ElementDefinition to get the sliceName for
 * @returns {string} the sliceName
 */
function edSliceName(structDef, elDef) {
  const r2Func = () => {
    const name = elDef.name;
    if (name == null) {
      return name;
    }
    // To know if it is really a *slice* name, we need to see if there is an element with the same
    // path that has a *slicing* defined.  If not, this is just an identifier name and we
    // shouldn't return it as a slice name.
    if (structDef.snapshot.element.some(e => e.path === elDef.path && e.slicing != null)) {
      return name;
    }
    return undefined;
  };
  return get(structDef, elDef, r2Func, 'sliceName');
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
 * Converts an R3 ElementDefinition type to the target FHIR version if necessary.  DSTU2 has 0..* profile, but
 * STU3 has 0..1 profile.  In addition, STU3 introduced targetProfile.
 * R2: type ({code, profile[], aggregation[]})
 * R3: type ({code, profile, targetProfile, aggregation[], versioning})
 * @param {Object} structDef - the StructureDefinition the type will be a part of
 * @param {Object} type - the STU3 type to convert
 * @returns {Object} the potentially-converted type
 */
function convertType(structDef, type) {
  if (type == null || structDef.fhirVersion !== '1.0.2') {
    // return as-is
    return type;
  }
  // Else we need to convert it
  const newType = JSON.parse(JSON.stringify(type)); // clone it so we also reproduce any additional properties added
  // Main difference is that DSTU2 profile is an array and doesn't have separate targetProfile
  if (type.profile != null) {
    newType.profile = [type.profile];
  } else if (type.targetProfile != null) {
    newType.profile = [type.targetProfile];
  }
  return newType;
}

function typeProfile(type) {
  if (Array.isArray(type.profile)) {
    // It's DSTU2, so only return it if the code is not Reference (else it's really targetProfile).
    // Also drop anything after the first element in the array.
    return type.code !== 'Reference' && type.profile.length > 0 ? type.profile[0] : undefined;
  }
  return type.profile;
}

function setTypeProfile(structDef, type, profile) {
  const r2Func = () => {
    type.profile = [profile];
  };

  set(structDef, type, profile, r2Func, 'profile');
}

function typeTargetProfile(type) {
  if (type.targetProfile != null) {
    return type.targetProfile;
  } else if (type.code === 'Reference') {
    // Must be DSTU2, so return the profile instead
    return Array.isArray(type.profile) && type.profile.length > 0 ? type.profile[0] : undefined;
  }
}

function setTypeTargetProfile(structDef, type, targetProfile) {
  const r2Func = () => {
    type.profile = [targetProfile];
  };

  set(structDef, type, targetProfile, r2Func, 'targetProfile');
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
 * R2: constrainedType (intended only if constraining)
 * R3: type
 * @param {Object} structDef - the StructureDefinition to set the type on
 * @param {string} type - the type to set
 */
function setSdType(structDef, type) {
  set(structDef, structDef, type, 'constrainedType', 'type');
}

/**
 * Getter for R3 ValueSet identifier and its equivalents.  Note that in DSTU2 it is 0..1,
 * but in STU3 it is 0..*.
 * R2: identifier (0..1)
 * R3: identifier (0..*)
 * @param {Object} valueSet - the ValueSet to get the identifier array for
 * @returns {Object[]} the identifier array
 */
function vsIdentifier(valueSet) {
  if (isValueSetDSTU2(valueSet) && valueSet.identifier != null) {
    return [valueSet.identifier];
  }
  return valueSet.identifier;
}

/**
 * Setter for R3 ValueSet identifier array and its equivalents.  Note that in DSTU2 it is 0..1,
 * but in STU3 it is 0..*.
 * R2: identifier (0..1)
 * R3: identifier (0..*)
 * @param {Object} valueSet - the ValueSet to set the identifier array on
 * @param {Object[]} identifier - the identifier array to set
 */
function setVsIdentifier(valueSet, identifier) {
  if (isValueSetDSTU2(valueSet) && identifier && identifier.length > 0) {
    valueSet.identifier = identifier[0];
  } else {
    valueSet.identifier = identifier;
  }
}

/**
 * Getter for R3 ValueSet title and its equivalents
 * R2: name
 * R3: title
 * @param {Object} valueSet - the ValueSet to get the title for
 * @returns {string} the title
 */
function vsTitle(valueSet) {
  if (isValueSetDSTU2(valueSet)) {
    return valueSet.name;
  }
  return valueSet.title;
}

/**
 * Setter for R3 ValueSet title and its equivalents
 * R2: name
 * R3: title
 * @param {Object} valueSet - the ValueSet to set the title on
 * @param {string} title - the title to set
 */
function setVsTitle(valueSet, title) {
  if (isValueSetDSTU2(valueSet)) {
    valueSet.name = title;
  } else {
    valueSet.title = title;
  }
}

/**
 * ValueSet doesn't have fhirVersion, so we must detect its version another way
 * @param {Object} vs - the value set
 * @returns {boolean} true if it is DSTU2, false if it is STU3, undefined if we can't determine
 */
function isValueSetDSTU2(vs) {
  // If identifier exists, it's DSTU2 if it's not an array
  if (vs.identifier) {
    return !Array.isArray(vs.identifier);
  }
  // If it has any DSTU2 properties, then it's DSTU2
  if (vs.lockedDate || vs.codeSystem || vs.requirements || (vs.compose && vs.compose.import)) {
    return true;
  }
  // If it has any STU3-only properties, then it's not DSTU2
  if (vs.title || vs.jurisdiction || vs.purpose) {
    return false;
  }
  if (vs.compose) {
    if (vs.compose.lockedDate || vs.compose.inactive) {
      return false;
    }
    if (vs.compose.include) {
      if (vs.compose.include.some(i => i.valueSet || (i.concept && i.concept.some(c => c.designation)))) {
        return false;
      }
    }
  }
  if (vs.expansion && vs.expansion.contains.some(c => c.inactive != null || c.designation)) {
    return false;
  }
}

module.exports = { convertContactDetail, convertContactDetails, convertDiscriminator, convertType, edComment, setEdComment, deleteEdComment, edContentReference, setEdContentReference, deleteEdContentReference, edSliceName, setEdSliceName, deleteEdSliceName, nameOfEdSliceName, edSlicingDiscriminator, setEdSlicingDiscriminator, sdBaseDefinition, setSdBaseDefinition, sdKeyword, setSdKeyword, sdTitle, setSdTitle, sdType, setSdType, typeProfile, setTypeProfile, typeTargetProfile, setTypeTargetProfile, vsIdentifier, setVsIdentifier, vsTitle, setVsTitle, isValueSetDSTU2 };