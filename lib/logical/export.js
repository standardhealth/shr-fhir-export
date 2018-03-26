const bunyan = require('bunyan');
const mdls = require('shr-models');
const common = require('../common');
const StructureDefinition = require('./StructureDefinition');

const CODEABLE_CONCEPT_ID = new mdls.Identifier('shr.core', 'CodeableConcept');
const CODING_ID = new mdls.Identifier('shr.core', 'Coding');

var rootLogger = bunyan.createLogger({name: 'shr-fhir-models-export'});
var logger = rootLogger;
function setLogger(bunyanLogger) {
  rootLogger = logger = bunyanLogger;
}

class ModelsExporter {
  constructor(specifications, fhir, configuration = {}) {
    this._specs = specifications;
    this._fhir = fhir;
    this._config = configuration;
    this._modelsMap = new Map();
  }

  get models() {
    return Array.from(this._modelsMap.values()).map(m => m.toJSON());
  }

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

  exportModel(def) {
    // Setup a child logger to associate logs with the current element
    const lastLogger = logger;
    logger = rootLogger.child({ shrId: def.identifier.fqn });
    logger.debug('Start exporting element logical model');
    try {
      // We need to enhance the map so some implicit things are made explicit for easier processing
      const model = new StructureDefinition();
      // TODO: update ID and URL to not clash w/ profile ID and URL
      model.id = model.type = common.fhirID(def.identifier, 'model');
      model.text = this.getText(def);
      model.url = common.fhirURL(def.identifier, this._config.fhirURL, 'model');
      model.identifier = [{ system: this._config.projectURL, value: def.identifier.fqn }],
      model.name = def.identifier.name;
      model.title = `${this._config.projectShorthand} ${def.identifier.name} Logical Model`;
      // TODO: what should the status be?
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

  shortDescription(description) {
    if (description == null) {
      return description;
    }
    return description.split('\n').shift().trim();
  }

  aliases(value, excludeEffectiveIdentifier) {
    let aliases = [];
    if (value instanceof mdls.ChoiceValue) {
      const shortIDs = new Set();
      value.aggregateOptions.forEach((o) => this.aliases(o).forEach(o2 => shortIDs.add(o2)));
      aliases = Array.from(shortIDs);
    } else if (value instanceof mdls.IdentifiableValue) {
      aliases = [common.shortID(value.identifier, true)];
      aliases.push(...value.constraintsFilter.own.type.constraints.map(c => common.shortID(c.isA, true)));
    }
    if (excludeEffectiveIdentifier) {
      const shortID = common.shortID(value.effectiveIdentifier, true);
      aliases = aliases.filter(a => a != shortID);
    }
    return aliases;
  }

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

  applyCodeConstraint(model, value, el, constraint) {
    el.fixCode(constraint.code, this.shrPathToFhirPath(value, constraint.path), this.resolve.bind(this));
  }

  applyBooleanConstraint(model, value, el, constraint) {
    el.fixBoolean(constraint.value, this.shrPathToFhirPath(value, constraint.path), this.resolve.bind(this));
  }

  applyCardConstraint(model, value, el, constraint) {
    el.modifyCard(constraint.card.min, constraint.card.max, this.shrPathToFhirPath(value, constraint.path), this.resolve.bind(this));
  }

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

  applyIncludesTypeConstraint(model, value, el, constraint) {
    // For IncludesType constraints, we must make the value a "section header" (no type) instead.  This is
    // because we don't have true inheritance in the logical models, so we can't put sub-types as slices of a parent
    // type (like we do for profiles).  Instead, we must simplify and treat the element as a "section header" and
    // put each included type as an element in the section.  See Grahame's Structured Cancer Reporting models for an
    // example: http://fhir.hl7.org.au/fhir/rcpa/index.html
    // NOTE: Some of this code is very similar to applyTypeConstraint.  Consider refactoring.
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

  applyIncludesCodeConstraint(model, value, el, constraint) {
    el.fixCodeInList(constraint.code, this.shrPathToFhirPath(value, constraint.path), this.resolve.bind(this));
  }

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

  getConcepts(identifier) {
    const def = this._specs.dataElements.findByIdentifier(identifier);
    if (def && def.concepts) {
      return def.concepts.map(c => ({ system: c.system, code: c.code, display: c.display }));
    }
    return [];
  }

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

  toTypeArray(value) {
    if (value instanceof mdls.TBD) {
      return [];
    } else if (value instanceof mdls.ChoiceValue) {
      const nonTBDs = value.aggregateOptions.filter(o => !(o instanceof mdls.TBD));
      return nonTBDs.map(o => this.toSingleType(o));
    }
    return [this.toSingleType(value)];
  }

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
