const bunyan = require('bunyan');
const mdls = require('shr-models');
const common = require('../common');
const StructureDefinition = require('./StructureDefinition');

// Constants used in various places throughout the code
const CODEABLE_CONCEPT_ID = new mdls.Identifier('shr.core', 'CodeableConcept');
const CODING_ID = new mdls.Identifier('shr.core', 'Coding');

var rootLogger = bunyan.createLogger({name: 'shr-fhir-models-export'});
var logger = rootLogger;
function setLogger(bunyanLogger) {
  rootLogger = logger = bunyanLogger;
}

/**
 * The primary class responsible for exporting SHR elements to FHIR logical models.  This class holds pointers to the
 * SHR specifications, FHIR definitions, configuration, and the logical models it has processed thus far.
 */
class ModelsExporter {
  constructor(specifications, fhir, configuration = {}) {
    this._specs = specifications;
    this._fhir = fhir;
    this._config = configuration;
    this._modelsMap = new Map();
  }

  /**
   * Gets the exported logical models as an array of JSON FHIR structure definitions.
   * @returns {Object[]} JSON FHIR structure definitions representing the exported logical models
   */
  get models() {
    return Array.from(this._modelsMap.values()).map(m => m.toJSON());
  }

  /**
   * Kicks off the export process based on the parameters passed into the class's constructor.
   * @returns {Object[]} JSON FHIR structure definitions representing the exported logical models
   */
  export() {
    // Iterate through the elements and export each to a logical model
    for (const element of this._specs.dataElements.all) {
      // Skip CodeableConcept and Coding since we'll use FHIR's built-in datatypes for those
      if (CODEABLE_CONCEPT_ID.equals(element.identifier) || CODING_ID.equals(element.identifier)) {
        continue;
      }
      try {
        this.exportModel(element);
      } catch (e) {
        logger.error('Unexpected error exporting element to FHIR Logical Model. ERROR_CODE:XXXXX', e);
      }
    }

    return this.models;
  }

  /**
   * Exports a specific SHR DataElement as a FHIR logical model
   * @param {Object} def - the DataElement to export as a logical model
   * @returns {StructureDefinition} the exported logical model as an instance of the StructureDefinition class
   */
  exportModel(def) {
    // Setup a child logger to associate logs with the current element
    const lastLogger = logger;
    logger = rootLogger.child({ shrId: def.identifier.fqn });
    logger.debug('Start exporting element logical model');
    try {
      const model = new StructureDefinition();
      model.id = model.type = common.fhirID(def.identifier, 'model');
      model.text = this.getText(def);
      model.url = common.fhirURL(def.identifier, this._config.fhirURL, 'model');
      model.identifier = [{ system: this._config.projectURL, value: def.identifier.fqn }],
      model.name = `${def.identifier.name}Model`;
      model.title = `${this._config.projectShorthand} ${def.identifier.name} Logical Model`;
      model.status = 'draft';
      model.date = this._config.publishDate || common.todayString();
      model.publisher = this._config.publisher;
      model.contact = this._config.contact;
      model.description = this.getDescription(def.identifier);
      if (!model.description) {
        // It's required to have a definition on the root element.  Normally setting model.description would do it
        // for us, but if model.description is null, we must do it ourselves.
        model.elements[0].short = model.elements[0].definition = def.identifier.name;
      }
      // Set the keywords if this element has Concepts defined
      const keywords = this.getConcepts(def.identifier);
      if (keywords && keywords.length) {
        model.keyword = keywords;
      }
      model.kind = 'logical';
      model.abstract = false;
      model.baseDefinition = 'http://hl7.org/fhir/StructureDefinition/Element';
      model.derivation = 'specialization';
      if (def.value) {
        this.addElement(model, def.value, true);
      }
      for (const field of def.fields) {
        this.addElement(model, field, false);
      }

      // The publisher requires each structure to have at least one field, so add a dummy field if necessary
      if (model.elements.length === 1) {
        const dummy = model.newElement('intentionallyBlank');
        dummy.short = 'Workaround for limitation in IG publisher: StructureDefinitions must have at least one field';
        dummy.definition = dummy.short;
        dummy.min = 0;
        dummy.max = '0';
        dummy.mustSupport = false;
        dummy.isModifier = false;
        dummy.isSummary = false;
      }

      this._modelsMap.set(model.id, model);

      return model;
    } finally {
      // Close out the logging for this mapping
      logger.debug('Done exporting element logical model');
      logger = lastLogger;
    }
  }

  /**
   * Adds an SHR DataElement's value or field to the StructureDefinition model as an ElementDefinition
   * @param {StructureDefinition} model - the StructureDefinition to add the element to
   * @param {Object} value - the SHR Value object representing the value/field to add as an element to the model
   * @param {boolean} isValue - a flag indicating if the passed in `value` is the DataElement's value field
   */
  addElement(model, value, isValue=false) {
    // TODO: If choice is restricted to single item, don't make it value[x]
    let el;
    if (value instanceof mdls.TBD) {
      return;
    } else if (isValue) {
      const name = value instanceof mdls.ChoiceValue ? 'value[x]' : 'value';
      el = model.newElement(name);
      const parentDescription = model.description ? common.lowerFirst(model.description) : 'the logical model instance';
      el.short = `${common.capitalize(common.valueName(value))} representing ${this.shortDescription(parentDescription)}`;
      el.definition = `${common.capitalize(common.valueName(value))} representing ${parentDescription}`;
      el.alias = this.aliases(value, false);
    } else {
      el = model.newElement(common.shortID(value.effectiveIdentifier, true));
      const aliases = this.aliases(value, true);
      if (aliases.length) {
        el.alias = aliases;
      }
      const description = this.getDescription(value.effectiveIdentifier, value.effectiveIdentifier.name);
      el.short = this.shortDescription(description);
      el.definition = description;
    }
    // Set the type
    el.type = this.toTypeArray(value);
    // Set the card
    const card = value.effectiveCard;
    el.min = card.min;
    el.max = card.isMaxUnbounded ? '*' : `${card.max}`;
    // Set the codes if this element has Concepts defined
    if (value instanceof mdls.IdentifiableValue) {
      const codes = this.getConcepts(value.effectiveIdentifier);
      if (codes && codes.length) {
        el.code = codes;
      }
    }
    // Set the things we keep the same for everything
    el.mustSupport = false;
    el.isModifier = false;
    el.isSummary = false;
    // Apply constraints
    this.applyConstraints(model, value, el);
  }

  /**
   * Shortens a description by truncating it at the first newline. This is used when assigning to an ElementDefinition's
   * 'short' property, which generally shows up in the differential/snapshot table of the published IG.
   * @param {string} description - the description to shorten
   * @returns {string} the shortened string
   */
  shortDescription(description) {
    if (description == null) {
      return description;
    }
    return description.split('\n').shift().trim();
  }

  /**
   * Derives aliases for a given SHR Value object.  These are typically based on the Value object's identifier and type
   * constraints, but in the case of choices, will also include all valid options provided by the choice.
   * @param {Object} value - the SHR Value object to derive aliases from
   * @param {boolean} [excludeEffectiveIdentifier] - if set to true, will not use the effectiveIdentifier as an alias.
   *   This is done when the primary id is based on the effectiveIdentifier, so we don't need an alias for it.
   * @returns {string[]} an array of aliases associated with the passed in Value
   */
  aliases(value, excludeEffectiveIdentifier) {
    let aliases = [];
    if (value instanceof mdls.ChoiceValue) {
      const shortIDs = new Set();
      value.aggregateOptions.forEach((o) => this.aliases(o).forEach(o2 => shortIDs.add(o2)));
      aliases = Array.from(shortIDs);
    } else if (value instanceof mdls.IdentifiableValue) {
      aliases = [common.shortID(value.identifier, true)];
      // TODO: Should this also consider the constraint history?
      aliases.push(...value.constraintsFilter.own.type.constraints.map(c => common.shortID(c.isA, true)));
    }
    if (excludeEffectiveIdentifier) {
      const shortID = common.shortID(value.effectiveIdentifier, true);
      aliases = aliases.filter(a => a != shortID);
    }
    return aliases;
  }

  /**
   * Inspects an SHR Value object for constraints and applies all appropriate constraints to the associated
   * StructureDefinition element (or its children, as appropriate).
   * @param {StructureDefinition} model - the StructureDefinition to which to apply the constraints
   * @param {Object} value - the SHR Value object potentiall containing constraints to be applied
   * @param {Object} el - the ElementDefinition associated with the SHR Value object
   */
  applyConstraints(model, value, el) {
    // First apply the type constraints and includes type constraints because they build
    // out some structure and affect the types, then do the rest
    for (const c of value.constraintsFilter.type.constraints) {
      this.applyTypeConstraint(model, value, el, c);
    }
    for (const c of value.constraintsFilter.includesType.constraints) {
      this.applyIncludesTypeConstraint(model, value, el, c);
    }
    // Handle the other (less destructive) constraints
    for (const c of value.constraintsFilter.valueSet.constraints) {
      this.applyValueSetConstraint(model, value, el, c);
    }
    for (const c of value.constraintsFilter.code.constraints) {
      this.applyCodeConstraint(model, value, el, c);
    }
    for (const c of value.constraintsFilter.includesCode.constraints) {
      this.applyIncludesCodeConstraint(model, value, el, c);
    }
    for (const c of value.constraintsFilter.boolean.constraints) {
      this.applyBooleanConstraint(model, value, el, c);
    }
    for (const c of value.constraintsFilter.card.constraints) {
      this.applyCardConstraint(model, value, el, c);
    }

    // If the value is a choice, then there may be constraints on the individual options
    if (value instanceof mdls.ChoiceValue) {
      // If any of the choices options have constraints, we'll need to slice the choice to constrain the elements
      if (value.aggregateOptions.some(o => o.constraints && o.constraints.length > 0)) {
        el.sliceIt('type', '$this');
      }
      for (let o of value.aggregateOptions) {
        if (o instanceof mdls.TBD || o.constraints.length === 0) {
          continue;
        }

        if (o.constraints.some(c => c instanceof mdls.IncludesTypeConstraint)) {
          // It's not feasible to apply includes type constraints in a choice, since a choice cannot contain
          // a backbone element or a "section header" (typeless element).  Filter out the includesType constraints.
          // TODO: Log it
          o = o.clone();
          o.constraints = o.constraints.filter(c => !(c instanceof mdls.IncludesTypeConstraint));
        }
        // Create the individual slice to apply the constraints to
        const slice = el.newSlice(o.effectiveIdentifier.name, this.toSingleType(o));
        const description = this.getDescription(o.effectiveIdentifier, o.effectiveIdentifier.name);
        slice.short = this.shortDescription(description);
        slice.definition = description;
        this.applyConstraints(model, o, slice);
      }
    }
  }

  /**
   * Given an SHR Value object and a path (Identifier[]) relative to that object, calculates and returns what the
   * associated FHIR path would be in a FHIR StructureDefinition logical model.  This function is pretty simple
   * except that it also normalizes SHR CodeableConcept and Coding to a FHIR Coding representation.
   * @param {Object} value - the SHR Value Object that is the root of the path
   * @param {Object[]} path - an array of SHR Identifiers representing the SHR path from the value
   * @returns {string} - the dot-separated FHIR path corresponding to the passed in path
   */
  shrPathToFhirPath(value, path) {
    if (path.length === 0) {
      return '';
    }

    let fhirPath = path.map(id => common.shortID(id, true)).join('.');

    // Now we need to do some "fixing" to account for swapping CodeableConcept for Coding
    // and swapping the SHR definitions (w/ different field names) with FHIR definitions
    const valueIsCodeableConcept = value.possibleIdentifiers.some(id => id.equals(CODEABLE_CONCEPT_ID));
    const valueIsCoding = value.possibleIdentifiers.some(id => id.equals(CODING_ID));
    if (valueIsCodeableConcept || valueIsCoding || /(coding|codeableConcept)/.test(fhirPath)) {
      // (1) If it contains codeableConcept.coding, we can chop out the codeableConcept part
      fhirPath = fhirPath.replace(/codeableConcept\.coding/g, 'coding');

      // (2) If the value is a CodeableConcept and coding is the first part of the path,
      // then we can chop out the first coding part
      if (valueIsCodeableConcept) {
        fhirPath = fhirPath.replace(/^coding\.?/, '');
      }

      // (3) If it contains any coding.*, we need to rename the coding property to match FHIR
      fhirPath = fhirPath.replace(/coding\.codeSystem/g, 'coding.system');
      fhirPath = fhirPath.replace(/coding\.codeSystemVersion/g, 'coding.version');
      fhirPath = fhirPath.replace(/coding\.displayText/g, 'coding.display');

      // (4) If the value is a CodeableConcept or Coding, we need to rename the first part of the path
      if (valueIsCodeableConcept || valueIsCoding) {
        fhirPath = fhirPath.replace(/^codeSystem/, 'system');
        fhirPath = fhirPath.replace(/^codeSystemVersion/, 'version');
        fhirPath = fhirPath.replace(/^displayText/, 'display');
      }
    }

    return fhirPath;
  }

  /**
   * Applies a Value Set constraint to the given element or to a child of the element when the constraint specifies
   * a sub-path.
   * @param {StructureDefinition} model - the StructureDefinition to which this constraint should be applied
   * @param {Object} value - the SHR Value object that defined this constraint
   * @param {Object} el - the ElementDefinition corresponding to the SHR Value Object
   * @param {Object} constraint - the constraint to apply
   * @returns {Object} the ElementDefinition to which this constraint was applied
   */
  applyValueSetConstraint(model, value, el, constraint) {
    // TODO: Some of this code is copied from profile exporter.  We should consolidate when appropriate.
    const vsURI = constraint.valueSet;
    if (vsURI.startsWith('urn:tbd')) {
      // Skip TBD value set
      return;
    }

    let strength = 'required';
    if (constraint.isRequired) {
      strength = 'required';
    } else if (constraint.isExtensible) {
      strength = 'extensible';
    } else if (constraint.isPreferred) {
      strength = 'preferred';
    } else if (constraint.isExample) {
      strength = 'example';
    } else {
      logger.error('Unsupported binding strength: %s. ERROR_CODE:13027', constraint.bindingStrength);
      return;
    }

    el.bindToVS(vsURI, strength, this.shrPathToFhirPath(value, constraint.path), this.resolve.bind(this));
  }

  /**
   * Applies a fixed code constraint to the given element or to a child of the element when the constraint specifies
   * a sub-path.
   * @param {StructureDefinition} model - the StructureDefinition to which this constraint should be applied
   * @param {Object} value - the SHR Value object that defined this constraint
   * @param {Object} el - the ElementDefinition corresponding to the SHR Value Object
   * @param {Object} constraint - the constraint to apply
   * @returns {Object} the ElementDefinition to which this constraint was applied
   */
  applyCodeConstraint(model, value, el, constraint) {
    el.fixCode(constraint.code, this.shrPathToFhirPath(value, constraint.path), this.resolve.bind(this));
  }

  /**
   * Applies a fixed boolean constraint to the given element or to a child of the element when the constraint specifies
   * a sub-path.
   * @param {StructureDefinition} model - the StructureDefinition to which this constraint should be applied
   * @param {Object} value - the SHR Value object that defined this constraint
   * @param {Object} el - the ElementDefinition corresponding to the SHR Value Object
   * @param {Object} constraint - the constraint to apply
   * @returns {Object} the ElementDefinition to which this constraint was applied
   */
  applyBooleanConstraint(model, value, el, constraint) {
    el.fixBoolean(constraint.value, this.shrPathToFhirPath(value, constraint.path), this.resolve.bind(this));
  }

  /**
   * Applies a cardinality constraint to the given element or to a child of the element when the constraint specifies
   * a sub-path.
   * @param {StructureDefinition} model - the StructureDefinition to which this constraint should be applied
   * @param {Object} value - the SHR Value object that defined this constraint
   * @param {Object} el - the ElementDefinition corresponding to the SHR Value Object
   * @param {Object} constraint - the constraint to apply
   * @returns {Object} the ElementDefinition to which this constraint was applied
   */
  applyCardConstraint(model, value, el, constraint) {
    el.modifyCard(constraint.card.min, constraint.card.max, this.shrPathToFhirPath(value, constraint.path), this.resolve.bind(this));
  }

  /**
   * Applies a type constraint to the given element or to a child of the element when the constraint specifies
   * a sub-path.  Note that when this is a nested path, it will result in parent elements being converted to a
   * "section header" (no type) or "BackboneElement".  We can't constraint nested elements to subtypes the normal way
   * because these logical models don't support true inheritance.
   * @param {StructureDefinition} model - the StructureDefinition to which this constraint should be applied
   * @param {Object} value - the SHR Value object that defined this constraint
   * @param {Object} el - the ElementDefinition corresponding to the SHR Value Object
   * @param {Object} constraint - the constraint to apply
   * @returns {Object} the ElementDefinition to which this constraint was applied
   */
  applyTypeConstraint(model, value, el, constraint) {
    if (!constraint.onValue && (constraint.path == null || constraint.path.length == 0)) {
      // Direct type constraints are already handled since we use effectiveType when building the models
      return;
    }

    // This constraint is nested (e.g. onValue or has path), so we must make it a backbone element instead.  This is
    // because we don't have true inheritance in the logical models, so we can't constrain the type of something in
    // an already defined model (because then it ceases to be that model).  Instead, we must simplify and treat the
    // element as an inner structure defined inline in this model and then constrain the nested type inside it.
    // See Grahame's Structured Cancer Reporting models for examples: http://fhir.hl7.org.au/fhir/rcpa/index.html
    if (el.type && el.type.length > 1) {
      // Here be dragons.  Reducing a choice to a "BackboneElement" is probably precarious!
      // TODO: Log this
    }

    // For a nested constraint on the value, we need to expand out the current element first (before wiping type)
    let currentEl = el;
    const elFhirPath = this.shrPathToFhirPath(value, constraint.path);
    const elPath = elFhirPath === '' ? [] : elFhirPath.split('.');
    if (constraint.onValue) {
      // We need to determine if it should be 'value' or 'value[x]'
      const parentID = constraint.path.length ? constraint.path[constraint.path.length-1] : value.effectiveIdentifier;
      const parent = this._specs.dataElements.findByIdentifier(parentID);
      if (parent && parent.value && parent.value instanceof mdls.ChoiceValue) {
        elPath.push('value[x]');
      } else {
        elPath.push('value');
      }
    }
    // Walk the path.  Every parent element in the chain needs to have its type changed to BackboneElement.
    for (let i=0; i < elPath.length; i++) {
      // Find the child *before* we change the type (otherwise it's hard to find the child)
      // NOTE: this also unfolds all of the child elements
      const child = currentEl.findChild(elPath[i], this.resolve.bind(this));
      currentEl.type = [{ code: 'BackboneElement' }];
      // Since we're now inlining this element anonymously, we need to reset all the `base` properties
      currentEl.resetBase();
      currentEl.children().forEach(c => c.resetBase());
      // Set the current element to the child for the next iteration
      currentEl = child;
    }
    // Now we're at the element to constrain type on, so change the type-related fields

    // Set the type
    const newType = constraint.isA;
    const tcValue = currentEl.type[0].code === 'Reference' ? new mdls.RefValue(newType) : new mdls.IdentifiableValue(newType);
    currentEl.type = this.toTypeArray(tcValue);

    // Adjust the aliases / id / path as necessary
    const shortName = common.shortID(newType, true);
    if (/.*\.value(\[x\])?(:[^\.]+)?$/.test(currentEl.id)) {
      // We don't need to change the id/path; we just need to change the alias
      if (/.*\.value\[x\](:[^\.]+)?$/.test(currentEl.id)) {
        // It's a choice.  Since we're narrowing it to one thing, we should unslice it.
        currentEl = currentEl.unSliceIt(shortName);
        currentEl.alias = [ shortName ];
        // If it's value[x] with a single type, normalize the choice
        currentEl.normalizeChoice(shortName);
      } else {
        // We don't need to change the id/path; we just need to add the alias
        if (currentEl.alias == null) {
          currentEl.alias = [];
        }
        if (!currentEl.alias.includes(shortName)) {
          currentEl.alias.push(shortName);
        }
      }
    } else {
      // We need to adjust the id in this and all subpaths (path is automatically adjusted based on id)
      const oldID = currentEl.id;
      const newID = currentEl.id.replace(/\.[^\.:]+(:[^\.]+)?$/, `.${shortName}$1`);
      currentEl.children().forEach(c => c.id.replace(oldID, newID));
      currentEl.id = newID;
    }

    const description = this.getDescription(newType, newType.name);
    currentEl.short = this.shortDescription(description);
    currentEl.definition = description;

    // Set the codes if this element has Concepts defined
    const codes = this.getConcepts(newType);
    if (codes && codes.length) {
      currentEl.code = codes;
    } else {
      currentEl.code = undefined;
    }
  }

  /**
   * Applies an "includes type" constraint to the given element or to a child of the element when the constraint
   * specifies a sub-path.  Note that this will result in some elements being converted to a "section header" (no type)
   * or "BackboneElement".  We can't constraint nested elements to subtypes the normal way because these logical models
   * don't support true inheritance.
   * @param {StructureDefinition} model - the StructureDefinition to which this constraint should be applied
   * @param {Object} value - the SHR Value object that defined this constraint
   * @param {Object} el - the ElementDefinition corresponding to the SHR Value Object
   * @param {Object} constraint - the constraint to apply
   * @returns {Object} the ElementDefinition to which this constraint was applied
   */
  applyIncludesTypeConstraint(model, value, el, constraint) {
    // For IncludesType constraints, we must make the value a "section header" (no type) instead.  This is
    // because we don't have true inheritance in the logical models, so we can't put sub-types as slices of a parent
    // type (like we do for profiles).  Instead, we must simplify and treat the element as a "section header" and
    // put each included type as an element in the section.  See Grahame's Structured Cancer Reporting models for an
    // example: http://fhir.hl7.org.au/fhir/rcpa/index.html
    // NOTE: Some of this code is very similar to applyTypeConstraint.  Consider refactoring.

    // If the includes type is zeroed out, then don't produce anything.  Act as if it never existed.
    if (constraint.card.isZeroedOut) {
      return;
    }

    if (el.type && el.type.length > 1) {
      // Here be dragons.  Reducing a choice to a "section header" or "BackboneElement" is probably precarious!
      // TODO: Log this
    }

    if (!constraint.onValue && (constraint.path == null || constraint.path.length == 0)) {
      // It is a direct constraint, make the type null (indicating it is a "section header")
      el.type = undefined;
      el.resetBase();
      // A "section header" can only be 0..1 or 1..1, so fix cardinality as appropriate.
      // Any includesType with a min card > 0 means the "section header" is required.
      if (el.min > 1 || constraint.card.min > 0) {
        el.min = 1;
      }
      el.max = '1';
    } else {
      // It is a nested constraint on the value, so we need to expand out the current element first (before wiping type)
      let currentEl = el;
      const elFhirPath = this.shrPathToFhirPath(value, constraint.path);
      const elPath = elFhirPath === '' ? [] : elFhirPath.split('.');
      if (constraint.onValue) {
        // We need to determine if it should be 'value' or 'value[x]'
        const parentID = constraint.path.length ? constraint.path[constraint.path.length-1] : value.effectiveIdentifier;
        const parent = this._specs.dataElements.findByIdentifier(parentID);
        if (parent && parent.value && parent.value instanceof mdls.ChoiceValue) {
          elPath.push('value[x]');
        } else {
          elPath.push('value');
        }
      }
      // Walk the path, making each part a backbone element until we get to the "section header"
      for (let i=0; i < elPath.length; i++) {
        // NOTE: this also unfolds all of the child elements
        const child = currentEl.findChild(elPath[i], this.resolve.bind(this));
        currentEl.type = [{ code: 'BackboneElement' }];
        // Since we're now inlining this element anonymously, we need to reset all the `base` properties
        currentEl.resetBase();
        currentEl.children().forEach(c => c.resetBase());
        if (i == elPath.length-1) {
          // We're at the tail of the path, so make the type null (indicating it is a "section header")
          child.type = undefined;
          // A "section header" can only be 0..1 or 1..1, so fix cardinality as appropriate.
          // Any includesType with a min card > 0 means the "section header" is required.
          if (child.min > 1 || constraint.card.min > 0) {
            child.min = 1;
          }
          child.max = '1';
        } else {
          currentEl = child;
        }
      }
    }

    // Now that we've built out the path, process the actual includesType constraint.
    // NOTE: A refactoring brought the code above and code below together.  There may be a more seamless way to
    // integrate them together.  A task for a rainy day.

    // For easier processing, normalize 'onValue' out and put it in the path
    if (constraint.onValue) {
      constraint = constraint.clone();
      constraint.onValue = false;
      constraint.path.push(new mdls.Identifier('', 'Value'));
    }
    if (constraint.path.length > 0) {
      const fhirPath = this.shrPathToFhirPath(value, constraint.path);
      const valueChildEl = el.findChild(fhirPath, this.resolve.bind(this));
      const valueConstraint = new mdls.IncludesTypeConstraint(constraint.isA.clone(), constraint.card.clone());
      let listValue;
      if (constraint.path.length == 0) {
        listValue = value;
      } else {
        const id = constraint.path.length == 1 ? value.effectiveIdentifier : constraint.path[constraint.path.length-2];
        const def = this._specs.dataElements.findByIdentifier(id);
        if (def) {
          const tailId = constraint.path[constraint.path.length-1];
          if (tailId.namespace === '' && tailId.name === 'Value') {
            listValue = def.value;
          } else {
            listValue = common.valueAndFields(def).find(f => constraint.path[constraint.path.length-1].equals(f.effectiveIdentifier));
          }
        }
      }

      if (listValue) {
        this.applyIncludesTypeConstraint(model, listValue, valueChildEl, valueConstraint);
      }
      return;
    }

    // TODO: This can probably be DRYer (much is similar to addElement method)
    const child = el.newChildElement(common.shortID(constraint.isA, true));
    model.addElement(child);
    child.min = constraint.card.min;
    child.max = constraint.card.isMaxUnbounded ? '*' : `${constraint.card.max}`;
    const description = this.getDescription(constraint.isA, constraint.isA.name);
    child.short = this.shortDescription(description);
    child.definition = description;
    // Set the type
    const newType = constraint.isA;
    const itcValue = value instanceof mdls.RefValue ? new mdls.RefValue(newType) : new mdls.IdentifiableValue(newType);
    child.type = this.toTypeArray(itcValue);
    // Set the codes if this element has Concepts defined
    const codes = this.getConcepts(newType);
    if (codes && codes.length) {
      child.code = codes;
    }
    // Set the things we keep the same for everything
    child.mustSupport = false;
    child.isModifier = false;
    child.isSummary = false;
  }

  /**
   * Applies an "includes code" constraint to the given element or to a child of the element when the constraint
   * specifies a sub-path.  Note that this does not use the usually approach (slicing) because FHIR forbids repeated
   * paths in logical models.
   * @param {StructureDefinition} model - the StructureDefinition to which this constraint should be applied
   * @param {Object} value - the SHR Value object that defined this constraint
   * @param {Object} el - the ElementDefinition corresponding to the SHR Value Object
   * @param {Object} constraint - the constraint to apply
   * @returns {Object} the ElementDefinition to which this constraint was applied
   */
  applyIncludesCodeConstraint(model, value, el, constraint) {
    // Unfortunately, we can't use the normal approach here since logical models don't allow paths to be repeated.
    // See: https://github.com/standardhealth/ballot/issues/21
    // el.fixCodeInList(constraint.code, this.shrPathToFhirPath(value, constraint.path), this.resolve.bind(this));

    // Instead, establish the fixed code via a constraint/invariant
    let elToConstrain = el;
    if (constraint.path && constraint.path.length > 0) {
      elToConstrain = el.findChild(this.shrPathToFhirPath(value, constraint.path), this.resolve.bind(this));
    }
    if (!elToConstrain) {
      // Invalid path.  Log this.
      return;
    }

    // Sometimes IncludesCode is used on a non-list element and the repetition actually occurs further up the path.
    // In this case, we need to put the constraint on the repeatable element, but refer to the nested code element
    // in the expression.  Find the repeatable element by walking up the path.
    let repeatableEL;
    for (repeatableEL = elToConstrain;
         repeatableEL && (repeatableEL.base.max === '1' || repeatableEL.base.max === '0');
         repeatableEL = repeatableEL.parent());
    if (!repeatableEL) {
      // Invalid path.  Log this.
      return;
    }
    let prefixPath = '';
    if (repeatableEL.path !== elToConstrain.path) {
      // The repeatable is a parent path, so find the relative path from parent to child and add the dot at the end
      prefixPath = elToConstrain.path.slice(repeatableEL.path.length+1) + '.';
    }


    if (repeatableEL.constraint == null) {
      repeatableEL.constraint = [];
    }

    const invariant = {
      key: `${repeatableEL.path.split('.').pop()}-${repeatableEL.constraint.length + 1}`,
      severity: 'error',
      human: '',
      expression: ''
    };
    const code = constraint.code;
    const display = code.display ? ` (${code.display})` : '';
    if (elToConstrain.type.some(t => t.code === 'CodeableConcept')) {
      if (code.system) {
        invariant.human = `There must exist a ${prefixPath}coding with system '${code.system}' and code '${code.code}'${display}.`;
        invariant.expression = `${prefixPath}coding.where(system = '${code.system}' and code = '${code.code}').exists()`;
      } else {
        invariant.human = `There must exist a ${prefixPath}coding with and code '${code.code}'${display}.`;
        invariant.expression = `${prefixPath}coding.where(code = '${code.code}').exists()`;
      }
    } else if (elToConstrain.type.some(t => t.code === 'Coding')) {
      if (code.system) {
        invariant.human = `There must exist a pairing of ${prefixPath}system '${code.system}' and ${prefixPath}code '${code.code}'${display}.`;
        invariant.expression = `${prefixPath}where(system = '${code.system}' and code = '${code.code}').exists()`;
      } else {
        invariant.human = `There must exist a ${prefixPath}code '${code.code}'.${display}`;
        invariant.expression = `${prefixPath}where(code = '${code.code}').exists()`;
      }
    } else if (elToConstrain.type.some(t => t.code === 'code')) {
      const suffix = prefixPath === '' ? '.' : ` at ${prefixPath}`;
      invariant.human = `There must exist a value of '${code.code}'${display}${suffix}`;
      invariant.expression = `${prefixPath}where($this = '${code.code}').exists()`;
    } else {
      // Not something we can fix a code on
      return;
    }

    repeatableEL.constraint.push(invariant);
  }

  /**
   * Returns a narrative object pertaining to the SHR DataElement that was passed in.
   * @param {Object} def - The SHR DataElement from which to derive the text narrative
   * @returns {{status: string, div: string}} the narrative object representing the text
   */
  getText(def) {
    return {
      status: 'generated',
      div:
`<div xmlns="http://www.w3.org/1999/xhtml">
  <p><b>${common.escapeHTML(this._config.projectShorthand + ' ' + def.identifier.name)} Logical Model</b></p>
  <p>${common.escapeHTML(this.getDescription(def.identifier))}</p>
</div>`
    };
  }

  /**
   * Returns a description for the given SHR Identifier, or the default text if no description is found.
   * @param {Object} identifier - the SHR Identifier to use to look up a description
   * @param {string} [defaultText] - default text if no description is found
   * @returns {string} the description
   */
  getDescription(identifier, defaultText) {
    const def = this._specs.dataElements.findByIdentifier(identifier);
    let description;
    if (def && def.description) {
      description = def.description.trim();
    }
    if (defaultText && (typeof description === 'undefined' || description == null || description == '')) {
      description = defaultText.trim();
    }
    return description;
  }

  /**
   * Returns an array of code objects representing the concepts associated with an SHR DataElement definition
   * @param {Object} identifier - the SHR Identifier representinf the data element defining its concepts
   * @return {{system: string, code: string, display?: string}[]} the concepts as code objects
   */
  getConcepts(identifier) {
    const def = this._specs.dataElements.findByIdentifier(identifier);
    if (def && def.concepts) {
      return def.concepts.map(c => ({ system: c.system, code: c.code, display: c.display }));
    }
    return [];
  }

  /**
   * Returns a FHIR type object pertaining to the passed in SHR IdentifiableValue object.  Note that ChoiceValue
   * objects should not be passed into this function.
   * @param {Object} value - the SHR IdentifiableValue object to extract a type from
   * @returns {{code: string, targetProfile?: string}} the FHIR type object
   */
  toSingleType(value) {
    const id = value.effectiveIdentifier;
    if (id.equals(CODEABLE_CONCEPT_ID) || id.equals(CODING_ID)) {
      // In a logical model, there is no meaningful difference between CodeableConcept and Coding
      // so just make it a Coding for simplicity.
      return { code: 'Coding' };
    } else if (id.isPrimitive) {
      return { code: id.name };
    } else if (value instanceof mdls.RefValue) {
      return { code: 'Reference', targetProfile: common.fhirURL(id, this._config.fhirURL, 'model') };
    }
    return { code: common.fhirURL(id, this._config.fhirURL, 'model') };
  }

  /**
   * Returns an array of FHIR type objects pertaining to the passed in SHR Value object.
   * @param {Object} value - the SHR Value object to extract the types from
   * @returns {{code: string, targetProfile?: string}[]} a list of FHIR type objects
   */
  toTypeArray(value) {
    if (value instanceof mdls.TBD) {
      return [];
    } else if (value instanceof mdls.ChoiceValue) {
      const nonTBDs = value.aggregateOptions.filter(o => !(o instanceof mdls.TBD));
      return nonTBDs.map(o => this.toSingleType(o));
    }
    return [this.toSingleType(value)];
  }

  /**
   * Resolves a FHIR type to a StructureDefinition representing the type
   * @param {{code: string, profile?: string, targetProfile?: string, aggregation?: string[], versioning?: string}} type - the FHIR type to resolve
   * @returns {StructureDefinition} the StructureDefinition representing the type
   */
  resolve(type) {
    type = common.typeToString(type);

    const re = new RegExp(`${this._config.fhirURL}/StructureDefinition/([a-z].*)-([A-Z].*)-model`);
    const localMatches = re.exec(type);
    if (localMatches) {
      const [ns, name] = [localMatches[1].replace(/-/g, '.'), localMatches[2]];
      // NOTE: possible recursion here!
      // TODO: Caching
      return this.exportModel(this._specs.dataElements.find(ns, name));
    }
    const def = this._fhir.find(type);
    if (def && def.resourceType === 'StructureDefinition') {
      return StructureDefinition.fromJSON(def);
    }
    return def;
  }
}

module.exports = {ModelsExporter, setLogger};
