const {intendedIndexInList} = require('./insertElement');
/**
 * Gets the value of a property from a definition, looking at the fhir version to determine whether to get r2, r3, or r4
 * @param {Object} rootDef - the definition to get the fhirVersion from
 * @param {Object} targetDef - the definition to get the property from
 * @param {string|function} r2NameOrFunction - the string name of the r2 property or a no-arg function to get the r2 property
 * @param {string|function} r3NameOrFunction - the string name of the r3 property or a no-arg function to get the r3 property
 * @param {string|function} r4NameOrFunction - the string name of the r4 property or a no-arg function to get the r4 property.
 *   If not provided, defaults to r3NameOrFunction
 * @returns {any} the value of the property in the definition
 */
function get(rootDef, targetDef, r2NameOrFunction, r3NameOrFunction, r4NameOrFunction = r3NameOrFunction) {
  if (sdIsDSTU2(rootDef)) {
    return typeof r2NameOrFunction === 'string' ? targetDef[r2NameOrFunction] : r2NameOrFunction();
  } else if (sdIsSTU3(rootDef)) {
    return typeof r3NameOrFunction === 'string' ? targetDef[r3NameOrFunction] : r3NameOrFunction();
  }
  return typeof r4NameOrFunction === 'string' ? targetDef[r4NameOrFunction] : r4NameOrFunction();
}

/**
 * Sets the value of a property on a definition, looking at the fhir version to determine whether to set r2, r3, or r4
 * @param {Object} rootDef - the definition to get the fhirVersion from
 * @param {Object} targetDef - the definition to set the property on
 * @param {any} value - the value to set
 * @param {string|function} r2NameOrFunction - the string name of the r2 property or a no-arg function to set the r2 property
 * @param {string|function} r3NameOrFunction - the string name of the r3 property or a no-arg function to set the r3 property
 * @param {string|function} r4NameOrFunction - the string name of the r4 property or a no-arg function to set the r4 property.
 *   If not provided, defaults to r3 function.
 */
function set(rootDef, targetDef, value, r2NameOrFunction, r3NameOrFunction, r4NameOrFunction = r3NameOrFunction) {
  if (sdIsDSTU2(rootDef)) {
    if (typeof r2NameOrFunction === 'string') {
      targetDef[r2NameOrFunction] = value;
    } else {
      r2NameOrFunction();
    }
  } else if (sdIsSTU3(rootDef)) {
    if (typeof r3NameOrFunction === 'string') {
      targetDef[r3NameOrFunction] = value;
    } else {
      r3NameOrFunction();
    }
  } else {
    if (typeof r4NameOrFunction === 'string') {
      targetDef[r4NameOrFunction] = value;
    } else {
      r4NameOrFunction();
    }
  }
}

/**
 * Deletes a property on a definition, looking at the fhir version to determine whether to delete r2, r3, or r4
 * @param {Object} rootDef - the definition to get the fhirVersion from
 * @param {Object} targetDef - the definition to delete the property from
 * @param {string|function} r2NameOrFunction - the string name of the r2 property or a no-arg function to delete the r2 property
 * @param {string|function} r3NameOrFunction - the string name of the r3 property or a no-arg function to delete the r3 property
 * @param {string|function} r4NameOrFunction - the string name of the r4 property or a no-arg function to delete the r4 property.
 *   If not provided, defaults to r3NameOrFunction
 */
function del(rootDef, targetDef, r2NameOrFunction, r3NameOrFunction, r4NameOrFunction = r3NameOrFunction) {
  if (sdIsDSTU2(rootDef)) {
    if (typeof r2NameOrFunction === 'string') {
      delete targetDef[r2NameOrFunction];
    } else {
      r2NameOrFunction();
    }
  } else if (sdIsSTU3(rootDef)) {
    if (typeof r3NameOrFunction === 'string') {
      delete targetDef[r3NameOrFunction];
    } else {
      r3NameOrFunction();
    }
  } else {
    if (typeof r4NameOrFunction === 'string') {
      delete targetDef[r4NameOrFunction];
    } else {
      r4NameOrFunction();
    }
  }
}

/**
 * Gets the version-specific property name, looking at the fhir version to determine whether to get r2, r3, or r4
 * @param {Object} rootDef - the definition to get the fhirVersionFrom
 * @param {string} r2Name - the name of the r2 property
 * @param {string} r3Name - the name of the r3 property
 * @param {string} r4Name - the name of the r4 property. Defaults to r3Name if not provided.
 * @returns {string} the version-specific property name
 */
function name(rootDef, r2Name, r3Name, r4Name = r3Name) {
  if (sdIsDSTU2(rootDef)) {
    return r2Name;
  } else if (sdIsSTU3(rootDef)) {
    return r3Name;
  }
  return r4Name;
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
  if (contactDetails && sdIsDSTU2(rootDef)) {
    return contactDetails.map(c => convertContactDetail(rootDef, c));
  }
  return contactDetails;
}

/**
 * Getter for R3/R4 ElementDefinition comment and its equivalents
 * R2:    comments
 * R3/R4: comment
 * @param {Object} structDef - the StructureDefinition the ElementDefinition belongs to
 * @param {Object} elDef - the ElementDefinition to get the comment for
 * @returns {string} the comment
 */
function edComment(structDef, elDef) {
  return get(structDef, elDef, 'comments', 'comment');
}

/**
 * Setter for R3/R4 ElementDefinition comment and its equivalents
 * R2:    comments
 * R3/R4: comment
 * @param {Object} structDef - the StructureDefinition the ElementDefinition belongs to
 * @param {Object} elDef - the ElementDefinition to set the comment on
 * @param {string} comment - the comment to set
 */
function setEdComment(structDef, elDef, comment) {
  set(structDef, elDef, comment, 'comments', 'comment');
}

/**
 * Delete R3/R4 ElementDefinition comment and its equivalents
 * R2:    comments
 * R3/R4: comment
 * @param {Object} structDef - the StructureDefinition the ElementDefinition belongs to
 * @param {Object} elDef - the ElementDefinition to delete the comment from
 */
function deleteEdComment(structDef, elDef) {
  del(structDef, elDef, 'comments', 'comment');
}

/**
 * Getter for R4 ElementDefinition binding.valueSet and its equivalents
 * R2/R3: binding.valueSetReference.reference or binding.valueSetUri
 * R4:    binding.valueSet
 * @param {Object} structDef - the StructureDefinition the ElementDefinition belongs to
 * @param {Object} elDef - the ElementDefinition to get the binding valueset for
 * @param {boolean} stripVersion - indicates if the version should be stripped from the canonical (default: false)
 * @returns {string} the binding value set
 */
function edBindingValueSet(structDef, elDef, stripVersion = false) {
  const bind = elDef.binding;
  if (bind == null) {
    return undefined;
  }
  if (sdIsDSTU2(structDef) || sdIsSTU3(structDef)) {
    return bind.valueSetReference ? bind.valueSetReference.reference : bind.valueSetUri;
  }
  if (bind.valueSet && stripVersion) {
    const barIdx = bind.valueSet.indexOf('|');
    if (barIdx !== -1) {
      return bind.valueSet.slice(0, barIdx);
    }
  }
  return bind.valueSet;
}

/**
 * Setter for R4 ElementDefinition binding.strength, binding.valueSet and their equivalents
 * R2/R3: binding.strength; binding.valueSetReference.reference or binding.valueSetUri
 * R4:    binding.strength; binding.valueSet
 * @param {Object} structDef - the StructureDefinition the ElementDefinition belongs to
 * @param {Object} elDef - the ElementDefinition to set the binding strength and value set on
 * @param {string} bindingStrength - the binding strength to set
 * @param {string} bindingValueSet - the binding value set to set
 */
function setEdBindingStrenghtAndValueSet(structDef, elDef, bindingStrength, bindingValueSet) {
  if (sdIsDSTU2(structDef) || sdIsSTU3(structDef)) {
    elDef.binding = {
      strength: bindingStrength,
      valueSetReference: { reference: bindingValueSet }
    };
  } else {
    elDef.binding = {
      strength: bindingStrength,
      valueSet: bindingValueSet
    };
  }
}

/**
 * Getter for R3/R4 ElementDefinition contentReference and its equivalents
 * R2:    nameReference
 * R3/R4: contentReference
 * @param {Object} structDef - the StructureDefinition the ElementDefinition belongs to
 * @param {Object} elDef - the ElementDefinition to get the contentReference for
 * @returns {string} the contentReference
 */
function edContentReference(structDef, elDef) {
  const r2Func = () => {
    // In R3/R4, a '#' prefix is used to reference local names, so we need to add it.
    return elDef.nameReference != null ? `#${elDef.nameReference}`: elDef.nameReference;
  };
  return get(structDef, elDef, r2Func, 'contentReference');
}

/**
 * Setter for R3/R4 ElementDefinition contentReference and its equivalents
 * R2:    nameReference
 * R3/R4: contentReference
 * @param {Object} structDef - the StructureDefinition the ElementDefinition belongs to
 * @param {Object} elDef - the ElementDefinition to set the contentReference on
 * @param {string} contentReference - the contentReference to set
 */
function setEdContentReference(structDef, elDef, contentReference) {
  const r2Func = () => {
    // In R3/R4, a '#' prefix is used to reference local names. We need to remove it for R2.
    if (contentReference != null && contentReference.startsWith('#')) {
      elDef.nameReference = contentReference.slice(1);
    } else {
      elDef.nameReference = contentReference;
    }
  };
  set(structDef, elDef, contentReference, r2Func, 'contentReference');
}

/**
 * Delete R3/R4 ElementDefinition contentReference and its equivalents
 * R2:    nameReference
 * R3/R4: contentReference
 * @param {Object} structDef - the StructureDefinition the ElementDefinition belongs to
 * @param {Object} elDef - the ElementDefinition to delete the contentReference from
 */
function deleteEdContentReference(structDef, elDef) {
  del(structDef, elDef, 'nameReference', 'contentReference');
}

/**
 * Getter for R3/R4 ElementDefinition discriminator and its equivalents.  DSTU2 represents
 * discriminator as 0..* string, but STU3 changed it to 0..* object.  This function will always
 * return an array of STU3/R4-formatted objects.
 * R2:    slicing.discriminator (string)
 * R3/R4: slicing.discriminator (object)
 * @param {Object} structDef - the StructureDefinition the ElementDefinition belongs to
 * @param {Object} elDef - the ElementDefinition to get the discriminator for
 * @returns {Object[]} the array of object-formatted discriminators
 */
function edSlicingDiscriminator(structDef, elDef) {
  if (elDef.slicing == null) {
    return undefined;
  } else if (elDef.slicing.discriminator == null || !sdIsDSTU2(structDef)) {
    // Return it as-is
    return elDef.slicing.discriminator;
  }
  // Else we need to convert it to an STU3/R4-formatted discriminator object
  return elDef.slicing.discriminator.map(d => {
    let dObj = { type: 'value', path: d }; // default STU3/R4 representation
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
 * Setter for R3/R4 ElementDefinition discriminator and its equivalents.  DSTU2 represents
 * discriminator as 0..* string, but STU3 changed it to 0..* object.  This function expects input
 * to always be an array of objects, but will convert to an array of strings for DSTU2.
 * R2:    slicing.discriminator (string)
 * R3/R4: slicing.discriminator (object)
 * @param {Object} structDef - the StructureDefinition the ElementDefinition belongs to
 * @param {Object} elDef - the ElementDefinition to set the comment on
 * @param {Object[]} discriminator - the array of discriminators to set
 */
function setEdSlicingDiscriminator(structDef, elDef, discriminator) {
  if (discriminator == null || !sdIsDSTU2(structDef)) {
    // Set it as-is
    elDef.slicing.discriminator = discriminator;
  } else {
    // Else we need to convert it
    elDef.slicing.discriminator = discriminator.map(d => convertDiscriminator(structDef, d));
  }
}

/**
 * Converts an R3/R4 ElementDefinition discriminator to the target FHIR version if necessary.  DSTU2
 * represents discriminator as a string, but STU3 changed it to an object.  This function expects
 * input to always be the object, but will convert to a string for DSTU2.
 * R2:    discriminator (string)
 * R3/R4: discriminator (object)
 * @param {Object} structDef - the StructureDefinition the discriminator will be a part of
 * @param {Object} discriminator - the STU3/R4 object-formatted discriminator to convert
 * @returns {Object|string} the potentially-converted discriminator
 */
function convertDiscriminator(structDef, discriminator) {
  if (discriminator == null || !sdIsDSTU2(structDef)) {
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
 * Getter for R3/R4 ElementDefinition sliceName and its equivalents. This is tricky because in DSTU2
 * the "name" property was used both as a slice name and as a non-slice identifier (to be used
 * with nameReference).  This means that presence of "name" doesn't necessarily mean it's a slice.
 * Furthermore, Argonaut populates "name" on every element.
 * R2:    name
 * R3/R4: sliceName
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
    // To know if it is really a *slice* name, we need to see if there is a previous element with the same
    // path -- and in the same subtree -- that has a *slicing* defined.  If not, this is just an identifier
    // name and we shouldn't return it as a slice name.
    let elDefIdx = structDef.snapshot.element.findIndex(e => e === elDef);
    if (elDefIdx === -1) {
      // element hasn't been inserted into the list, so find where it *should* be inserted
      elDefIdx = intendedIndexInList(elDef, structDef.snapshot.element);
    }
    // Iterate the elements backward from the elDef, looking for one with a matching path & a slicing
    for (let i = elDefIdx - 1; i >= 0; i--) {
      const prevEl = structDef.snapshot.element[i];
      // if the path is shorter than elDef's path, then any matching paths before this are in a different
      // sub-tree, so they don't count.
      if (!prevEl.path.startsWith(elDef.path)) {
        return undefined;
      }
      // If it has a matching path and a slicing, it's a real slice -- return the name!
      if (elDef.path === prevEl.path && prevEl.slicing != null) {
        return name;
      }
    }
    return undefined;
  };
  return get(structDef, elDef, r2Func, 'sliceName');
}

/**
 * Setter for R3/R4 ElementDefinition sliceName and its equivalents
 * R2:    name
 * R3/R4: sliceName
 * @param {Object} structDef - the StructureDefinition the ElementDefinition belongs to
 * @param {Object} elDef - the ElementDefinition to set the sliceName on
 * @param {string} sliceName - the sliceName to set
 */
function setEdSliceName(structDef, elDef, sliceName) {
  set(structDef, elDef, sliceName, 'name', 'sliceName');
}

/**
 * Delete R3/R4 ElementDefinition sliceName and its equivalents
 * R2:    name
 * R3/R4: sliceName
 * @param {Object} structDef - the StructureDefinition the ElementDefinition belongs to
 * @param {Object} elDef - the ElementDefinition to delete the sliceName from
 */
function deleteEdSliceName(structDef, elDef) {
  del(structDef, elDef, 'name', 'sliceName');
}

/**
 * Get the version-specific property name for R3/R4 ElementDefinition sliceName
 * R2:    name
 * R3/R4: sliceName
 * @param {Object} structDef - the StructureDefinition the ElementDefinition belongs to
 * @return {string} the version-specific name for the sliceName property
 */
function nameOfEdSliceName(structDef) {
  return name(structDef, 'name', 'sliceName');
}

/**
 * Converts an R4 ElementDefinition type to the target FHIR version if necessary.
 * R2: type ({code, profile[], aggregation[]})
 * R3: type ({code, profile, targetProfile, aggregation[], versioning})
 * R4: type ({code, profile[], targetProfile[], aggregation[], versioning})
 * @param {Object} structDef - the StructureDefinition the type will be a part of
 * @param {Object} type - the R4 type to convert
 * @returns {Object} the potentially-converted type
 */
function convertType(structDef, type) {
  if (type == null || !(sdIsDSTU2(structDef) || sdIsSTU3(structDef))) {
    // return as-is
    return type;
  }
  // Else we need to convert it
  const newType = JSON.parse(JSON.stringify(type)); // clone it so we also reproduce any additional properties added
  if (sdIsDSTU2(structDef)) {
    // Main difference is that DSTU2 doesn't have separate targetProfile
    if (type.targetProfile != null && type.targetProfile.length > 0) {
      if (newType.profile == null) {
        newType.profile = [];
      }
      newType.profile.push(...type.targetProfile);
    }
    delete(newType.targetProfile);
  } else if (sdIsSTU3(structDef)) {
    // Main difference is that STU3 has 0..1 profile and 0..1 targetProfile
    // NOTE -- we are potentially DROPPING profiles
    // TODO: Should we change this to return an array of types?
    if (type.profile && type.profile.length > 0) {
      newType.profile = type.profile[0];
    } else {
      delete(newType.profile);
    }
    if (type.targetProfile && type.targetProfile.length > 0) {
      newType.targetProfile = type.targetProfile[0];
    } else {
      delete(newType.targetProfile);
    }
  }
  return newType;
}

/**
 * Gets the type profile converted to R4 format
 * @param {Object} type - the type to extract the profile from
 * @returns {Object[]|null} the profiles on the type
 */
function typeProfile(type) {
  if (type == null || type.profile == null) {
    return undefined;
  } else if (!Array.isArray(type.profile)) {
    // STU3.  Wrap it in an array
    return [type.profile];
  }
  // DSTU2 or R4.  In DSTU2, profile is also used for target profiles, so we need to ensure it's not really a reference.
  return type.code !== 'Reference' ? type.profile : undefined;
}

/**
 * Determines if the type has the given ProfileURI listed as a profile
 * @param {Object} type - the type to check the profileURI on
 * @param {string} profileURI - the profileURI to check for
 * @returns {boolean} true if the type has the profile, false otherwise
 */
function typeHasProfile(type, profileURI) {
  const typeProfiles = typeProfile(type);
  return typeProfiles != null && typeProfiles.includes(profileURI);
}

/**
 * Sets the type profile according to the target format
 * @param {Object} structDef - the StructureDefinition containing the type on which we'll set the profile
 * @param {Object} type - the type to set the profile attribute on
 * @param {string} profile - the profile to set on the type
 */
function setTypeProfile(structDef, type, profile) {
  const r2r4Func = () => {
    type.profile = profile != null ? [profile] : undefined;
  };

  set(structDef, type, profile, r2r4Func, 'profile', r2r4Func);
}

/**
 * Adds the type and/or profile according to the target format
 * @param {Object} structDef - the StructureDefinition containing the types to which we'll add the type/profile
 * @param {Object} types - the types to add the type/profile to
 * @param {string} code - the code for the type to add
 * @param {string} profile - the profile of the type to add
 * @param {number} [index] - where to add the type (if applicable)
 */
function addTypeProfile(structDef, types, code, profile, index) {
  let typeToAdd;
  if (sdIsDSTU2(structDef)) {
    // DSTU2: Each profile gets its own type (and profile is array)
    const fullMatch = types.find(t => t.code === code && t.profile && t.profile.length == 1 && t.profile[0] === profile);
    if (fullMatch) {
      // nothing to add -- it's already there
      return fullMatch;
    }
    typeToAdd = {code, profile: [profile]};
  } else if (sdIsSTU3(structDef)) {
    // STU3: Each profile gets its own type (and profile is singular)
    const fullMatch = types.find(t => t.code === code && t.profile === profile);
    if (fullMatch) {
      // nothing to add -- it's already there
      return fullMatch;
    }
    typeToAdd = {code, profile};
  } else {
    // R4: If the code already exists on a type, just add the profile to the existing type
    const type = types.find(t => t.code === code);
    if (type) {
      type.profile = type.profile || [];
      // Only add it if it doesn't exist already
      if (!type.profile.some(p => p === profile)) {
        type.profile.push(profile);
      }
      // Don't assign typeToAdd since we added it to an existing one, just return
      return type;
    } else {
      typeToAdd = {code, profile: [profile]};
    }
  }
  if (typeToAdd) {
    if (index != null) {
      types.splice(index, 0, typeToAdd);
    } else {
      types.push(typeToAdd);
    }
    return typeToAdd;
  }
}

/**
 * Gets the type targetProfile converted to R4 format
 * @param {Object} type - the type to extract the typeTargetProfile from
 * @returns {Object[]|null} the targetProfiles on the type
 */
function typeTargetProfile(type) {
  if (type == null) {
    return undefined;
  } else if (type.targetProfile == null) {
    // This could be either because there is no targetProfile or its DSTU2 and we need to check profile.
    // If the type.code is Reference and there is a type.profile, we assume DSTU2 and return that, else undefined.
    return type.code === 'Reference' ? type.profile : undefined;
  } else if (!Array.isArray(type.targetProfile)) {
    // STU3. Wrap it in an array
    return [type.targetProfile];
  }
  // R4.  Return it directly
  return type.targetProfile;
}

/**
 * Determines if the type has the given ProfileURI listed as a targetProfile
 * @param {Object} type - the type to check the profileURI on
 * @param {string} profileURI - the profileURI to check for
 * @returns {boolean} true if the type has the targetProfile, false otherwise
 */
function typeHasTargetProfile(type, profileURI) {
  const typeTargetProfiles = typeTargetProfile(type);
  return typeTargetProfiles != null && typeTargetProfiles.includes(profileURI);
}

/**
 * Sets the type targetProfile according to the target format
 * @param {Object} structDef - the StructureDefinition containing the type on which we'll set the targetProfile
 * @param {Object} type - the type to set the targetProfile attribute on
 * @param {string} targetProfile - the targetProfile to set on the type
 */
function setTypeTargetProfile(structDef, type, targetProfile) {
  const r2Func = () => {
    type.profile = type.code === 'Reference' && targetProfile != null ? [targetProfile] : undefined;
  };
  const r4Func = () => {
    type.targetProfile = targetProfile != null ? [targetProfile] : undefined;
  };

  set(structDef, type, targetProfile, r2Func, 'targetProfile', r4Func);
}

/**
 * Adds the type and/or targetProfile according to the target format
 * @param {Object} structDef - the StructureDefinition containing the types to which we'll add the type/targetProfile
 * @param {Object} types - the types to add the type/profile to
 * @param {string} code - the code for the type to add
 * @param {string} targetProfile - the targetProfile of the type to add
 * @param {number} [index] - where to add the type (if applicable)
 */
function addTypeTargetProfile(structDef, types, code, targetProfile, index) {
  let typeToAdd;
  if (sdIsDSTU2(structDef)) {
    // DSTU2: Each targetProfile gets its own type, profile is array, and use profile (not targetProfile)
    const fullMatch = types.find(t => t.code === code && t.profile && t.profile.length == 1 && t.profile[0] === targetProfile);
    if (fullMatch) {
      // nothing to add -- it's already there
      return fullMatch;
    }
    typeToAdd = {code, profile: [targetProfile]};
  } else if (sdIsSTU3(structDef)) {
    // STU3: Each targetProfile gets its own type (and targetProfile is singular)
    const fullMatch = types.find(t => t.code === code && t.targetProfile === targetProfile);
    if (fullMatch) {
      // nothing to add -- it's already there
      return fullMatch;
    }
    typeToAdd = {code, targetProfile};
  } else {
    // R4: If the code already exists on a type, just add the targetProfile to the existing type
    const type = types.find(t => t.code === code);
    if (type) {
      type.targetProfile = type.targetProfile || [];
      // Only add it if it doesn't exist already
      if (!type.targetProfile.some(p => p === targetProfile)) {
        type.targetProfile.push(targetProfile);
      }
      // Don't assign typeToAdd since we added it to an existing one, just return
      return type;
    } else {
      typeToAdd = {code, targetProfile: [targetProfile]};
    }
  }
  if (typeToAdd) {
    if (index != null) {
      types.splice(index, 0, typeToAdd);
    }
    types.push(typeToAdd);
    return typeToAdd;
  }
}

/**
 * Getter for R3/R4 StructureDefinition baseDefinition and its equivalents
 * R2:    base
 * R3/R4: baseDefinition
 * @param {Object} structDef - the StructureDefinition to get the baseDefinition for
 * @returns {string} the URI base definition
 */
function sdBaseDefinition(structDef) {
  return get(structDef, structDef, 'base', 'baseDefinition');
}

/**
 * Setter for R3/R4 StructureDefinition baseDefinition and its equivalents
 * R2:    base
 * R3/R4: baseDefinition
 * @param {Object} structDef - the StructureDefinition to set the baseDefinition on
 * @param {string} uri - the URI to set as the baseDefinition
 */
function setSdBaseDefinition(structDef, uri) {
  set(structDef, structDef, uri, 'base', 'baseDefinition');
}

/**
 * Getter for R3/R4 StructureDefinition keyword and its equivalents
 * R2:    code
 * R3/R4: keyword
 * @param {Object} structDef - the StructureDefinition to get the keyword for
 * @returns {Object} the keyword
 */
function sdKeyword(structDef) {
  return get(structDef, structDef, 'code', 'keyword');
}

/**
 * Setter for R3/R4 StructureDefinition keyword and its equivalents
 * R2:    code
 * R3/R4: keyword
 * @param {Object} structDef - the StructureDefinition to set the keyword on
 * @param {Object} keyword - the keyword to set
 */
function setSdKeyword(structDef, keyword) {
  set(structDef, structDef, keyword, 'code', 'keyword');
}

/**
 * Getter for R3/R4 StructureDefinition title and its equivalents
 * R2:    display
 * R3/R4: title
 * @param {Object} structDef - the StructureDefinition to get the title for
 * @returns {string} the title
 */
function sdTitle(structDef) {
  return get(structDef, structDef, 'display', 'title');
}

/**
 * Setter for R3/R4 StructureDefinition title and its equivalents
 * R2:    display
 * R3/R4: title
 * @param {Object} structDef - the StructureDefinition to set the title on
 * @param {string} title - the title to set
 */
function setSdTitle(structDef, title) {
  set(structDef, structDef, title, 'display', 'title');
}

/**
 * Getter for R3/R4 StructureDefinition type and its equivalents
 * R2:    constrainedType or path of first snapshot element
 * R3/R4: type
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
 * Setter for R3/R4 StructureDefinition type and its equivalents
 * R2:    constrainedType (intended only if constraining)
 * R3/R4: type
 * @param {Object} structDef - the StructureDefinition to set the type on
 * @param {string} type - the type to set
 */
function setSdType(structDef, type) {
  set(structDef, structDef, type, 'constrainedType', 'type');
}

/**
 * Getter for R3/R4 ValueSet identifier and its equivalents.  Note that in DSTU2 it is 0..1,
 * but in STU3/R4 it is 0..*.
 * R2:    identifier (0..1)
 * R3/R4: identifier (0..*)
 * @param {Object} valueSet - the ValueSet to get the identifier array for
 * @returns {Object[]} the identifier array
 */
function vsIdentifier(valueSet) {
  if (valueSet.identifier != null && ! Array.isArray(valueSet.identifier)) {
    return [valueSet.identifier];
  }
  return valueSet.identifier;
}

/**
 * Setter for R3/R4 ValueSet identifier array and its equivalents.  Note that in DSTU2 it is 0..1,
 * but in STU3/R4 it is 0..*.
 * R2:    identifier (0..1)
 * R3/R4: identifier (0..*)
 * @param {Object} valueSet - the ValueSet to set the identifier array on
 * @param {Object[]} identifier - the identifier array to set
 * @param {String} target - the target version (FHIR_R4, FHIR_STU_3, or FHIR_DSTU_2)
 */
function setVsIdentifier(valueSet, identifier, target) {
  if (target === 'FHIR_DSTU_2') {
    if (identifier && identifier.length > 0) {
      valueSet.identifier = identifier[0];
    } else {
      valueSet.identifier = undefined;
    }
  } else {
    valueSet.identifier = identifier;
  }
}

/**
 * Getter for R3/R4 ValueSet title and its equivalents
 * R2:    name
 * R3/R4: title
 * @param {Object} valueSet - the ValueSet to get the title for
 * @param {String} target - the target version (FHIR_R4, FHIR_STU_3, or FHIR_DSTU_2)
 * @returns {string} the title
 */
function vsTitle(valueSet, target) {
  if (target === 'FHIR_DSTU_2') {
    return valueSet.name;
  }
  return valueSet.title;
}

/**
 * Setter for R3/R4 ValueSet title and its equivalents
 * R2:    name
 * R3/R4: title
 * @param {Object} valueSet - the ValueSet to set the title on
 * @param {String} target - the target version (FHIR_R4, FHIR_STU_3, or FHIR_DSTU_2)
 * @param {string} title - the title to set
 */
function setVsTitle(valueSet, title, target) {
  if (target === 'FHIR_DSTU_2') {
    valueSet.name = title;
  } else {
    valueSet.title = title;
  }
}

/**
 * Getter for R4 CodeSystem identifier and its equivalents.  Note that in STU3 it is 0..1,
 * but in R4 it is 0..*.
 * R3     identifier (0..1)
 * R4:    identifier (0..*)
 * @param {Object} codeSystem - the CodeSystem to get the identifier array for
 * @returns {Object[]} the identifier array
 */
function csIdentifier(codeSystem) {
  if (codeSystem.identifier != null && ! Array.isArray(codeSystem.identifier)) {
    return [codeSystem.identifier];
  }
  return codeSystem.identifier;
}

/**
 * Setter for R4 CodeSystem identifier array and its equivalents.  Note that in STU3 it is 0..1,
 * but in R4 it is 0..*.
 * R3:    identifier (0..1)
 * R4:    identifier (0..*)
 * @param {Object} codeSystem - the codeSystem to set the identifier array on
 * @param {Object[]} identifier - the identifier array to set
 * @param {String} target - the target version (FHIR_R4, FHIR_STU_3, or FHIR_DSTU_2)
 */
function setCsIdentifier(codeSystem, identifier, target) {
  if (target === 'FHIR_STU_3') {
    if (identifier && identifier.length > 0) {
      codeSystem.identifier = identifier[0];
    } else {
      codeSystem.identifier = undefined;
    }
  } else {
    codeSystem.identifier = identifier;
  }
}

/**
 * Tests if the structure definition is DSTU2
 * @param {Object} structDef - the structure definition to extract the FHIR version from
 * @returns {boolean} true if the structure definition is DSTU2, false otherwise
 */
function sdIsDSTU2(structDef) {
  return structDef && structDef.fhirVersion === '1.0.2';
}

/**
 * Tests if the structure definition is STU3
 * @param {Object} structDef - the structure definition to extract the FHIR version from
 * @returns {boolean} true if the structure definition is DSTU2, false otherwise
 */
function sdIsSTU3(structDef) {
  return structDef && (structDef.fhirVersion === '3.0.0' || structDef.fhirVersion === '3.0.1');
}

module.exports = { convertContactDetail, convertContactDetails, convertDiscriminator, convertType, edComment, setEdComment, deleteEdComment, edContentReference, setEdContentReference, deleteEdContentReference, edBindingValueSet, setEdBindingStrenghtAndValueSet, edSliceName, setEdSliceName, deleteEdSliceName, nameOfEdSliceName, edSlicingDiscriminator, setEdSlicingDiscriminator, sdBaseDefinition, setSdBaseDefinition, sdKeyword, setSdKeyword, sdTitle, setSdTitle, sdType, setSdType, typeProfile, typeHasProfile, setTypeProfile, addTypeProfile, typeTargetProfile, typeHasTargetProfile, setTypeTargetProfile, addTypeTargetProfile, vsIdentifier, setVsIdentifier, vsTitle, setVsTitle, csIdentifier, setCsIdentifier };