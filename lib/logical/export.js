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
      model.name = `${this._config.projectShorthand} ${def.identifier.name} Logical Model`;
      // TODO: what should the status be?
      model.status = 'draft';
      model.date = this._config.publishDate || common.todayString();
      model.publisher = this._config.publisher;
      model.contact = this._config.contact;
      model.description = this.getDescription(def.identifier);
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
      el.definition = `${common.capitalize(common.valueName(value))} representing ${common.lowerFirst(model.description)}`;
      if (value instanceof mdls.ChoiceValue) {
        el.alias = value.aggregateOptions.filter(o => o instanceof mdls.IdentifiableValue).map(o => common.shortID(o.effectiveIdentifier));
      } else if (value instanceof mdls.IdentifiableValue) {
        el.alias = [common.shortID(value.effectiveIdentifier)];
      }
    } else {
      el = model.newElement(common.shortID(value.effectiveIdentifier, true));
      const description = this.getDescription(value.effectiveIdentifier);
      if (description) {
        el.definition = description;
      }
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

  applyConstraints(model, value, el) {
    // SPECIAL HANDLING FOR INCLUDES TYPE CONSTRAINTS:
    // If the value has IncludesType constraints, then we must make it a "section header" (no type) instead.  This is
    // because we don't have true inheritance in the logical models, so we can't put sub-types as slices of a parent
    // type (like we do for profiles).  Instead, we must simplify and treat the element as a "section header" and
    // put each included type as an element in the section.  See Grahame's Structured Cancer Reporting models for an
    // example: http://fhir.hl7.org.au/fhir/rcpa/index.html
    if (value.constraintsFilter.includesType.hasConstraints) {
      if (el.type.length > 1) {
        // Here be dragons.  Reducing a choice to a "section header" or "BackboneElement" is probably precarious!
        // TODO: Log this
      }

      const own = value.constraintsFilter.own.includesType.constraints.filter(c => !c.onValue);
      const onValue = value.constraintsFilter.includesType.constraints.filter(c => c.path.length == 0 && c.onValue);
      if (own.length && onValue.length) {
        // There is no reasonable way to represent this.
        // TODO: Log this
      }

      if (own.length) {
        el.type = undefined;
        // If all includes types are optional, then section is optional.  Otherwise it is required.
        el.min = 0;
        if (value.constraintsFilter.includesType.constraints.some(c => c.card.min > 0)) {
          el.min = 1;
        }
        el.max = '1';
      } else if (onValue.length) {
        // For a nested constraint on the value, we need to expand out the current element first (before wiping type)
        const child = el.findChild('value', this.resolve.bind(this));
        el.type = ['BackboneElement'];
        child.type = undefined;
        // If all includes types are optional, then section is optional.  Otherwise it is required.
        child.min = 0;
        if (onValue.some(c => c.card.min > 0)) {
          child.min = 1;
        }
        child.max = '1';
      }
    }

    for (const c of value.constraints) {
      if (c instanceof mdls.ValueSetConstraint) {
        this.applyValueSetConstraint(model, value, el, c);
      } else if (c instanceof mdls.CodeConstraint) {
        this.applyCodeConstraint(model, value, el, c);
      } else if (c instanceof mdls.BooleanConstraint) {
        this.applyBooleanConstraint(model, value, el, c);
      } else if (c instanceof mdls.CardConstraint) {
        this.applyCardConstraint(model, value, el, c);
      } else if (c instanceof mdls.IncludesTypeConstraint) {
        this.applyIncludesTypeConstraint(model, value, el, c);
      }
    }
    // If the value is a choice, then there may be constraints on the individual options
    if (value instanceof mdls.ChoiceValue) {
      // If any of the choices options have constraints, we'll need to slice the choice to constrain the elements
      if (value.aggregateOptions.some(o => o.constraints && o.constraints.length > 0)) {
        el.sliceIt('type', '$this');
      }
      for (const o of value.aggregateOptions) {
        if (o instanceof mdls.TBD || o.constraints.length === 0) {
          continue;
        }
        // Create the individual slice to apply the constraints to
        const slice = el.newSlice(o.effectiveIdentifier.name, this.toSingleType(o));
        for (const c of o.constraints) {
          if (c instanceof mdls.ValueSetConstraint) {
            this.applyValueSetConstraint(model, o, slice, c);
          } else if (c instanceof mdls.CodeConstraint) {
            this.applyCodeConstraint(model, o, slice, c);
          } else if (c instanceof mdls.BooleanConstraint) {
            this.applyBooleanConstraint(model, o, slice, c);
          } else if (c instanceof mdls.CardConstraint) {
            this.applyCardConstraint(model, o, slice, c);
          }
        }
      }
    }
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

    el.bindToVS(vsURI, strength, constraint.path.map(id => common.shortID(id, true)).join('.'), this.resolve.bind(this));
  }

  applyCodeConstraint(model, value, el, constraint) {
    el.fixCode(constraint.code, constraint.path.map(id => common.shortID(id, true)).join('.'), this.resolve.bind(this));
  }

  applyBooleanConstraint(model, value, el, constraint) {
    el.fixBoolean(constraint.value, constraint.path.map(id => common.shortID(id, true)).join('.'), this.resolve.bind(this));
  }

  applyCardConstraint(model, value, el, constraint) {
    el.modifyCard(constraint.card.min, constraint.card.max, constraint.path.map(id => common.shortID(id, true)).join('.'), this.resolve.bind(this));
  }

  applyIncludesTypeConstraint(model, value, el, constraint) {
    if (constraint.path && constraint.path.length > 0) {
      // Right now, only handle *own* includes type constraints
      return;
    } else if (constraint.onValue) {
      const valueChild = el.findChild('value', this.resolve.bind(this));
      const valueConstraint = new mdls.IncludesTypeConstraint(constraint.isA.clone(), constraint.card.clone());
      const def = this._specs.dataElements.findByIdentifier(constraint.isA);
      if (def && def.value) {
        this.applyIncludesTypeConstraint(model, def.value, valueChild, valueConstraint);
      }
      return;
    }
    // TODO: This can probably be DRYer (much is similar to addElement method)
    const child = el.newChildElement(common.shortID(constraint.isA, true));
    child.min = constraint.card.min;
    child.max = constraint.card.isMaxUnbounded ? '*' : `${constraint.card.max}`;
    model.elements.push(child);
    const description = this.getDescription(constraint.isA);
    if (description) {
      child.definition = description;
    }
    // Set the type
    const itcValue = value instanceof mdls.RefValue ? new mdls.RefValue(constraint.isA) : new mdls.IdentifiableValue(constraint.isA);
    child.type = this.toTypeArray(itcValue);
    // Set the codes if this element has Concepts defined
    if (value instanceof mdls.IdentifiableValue) {
      const codes = this.getConcepts(constraint.isA);
      if (codes && codes.length) {
        child.code = codes;
      }
    }
    // Set the things we keep the same for everything
    child.mustSupport = false;
    child.isModifier = false;
    child.isSummary = false;
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
    if (id.isPrimitive || id.equals(CODEABLE_CONCEPT_ID) || id.equals(CODING_ID)) {
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
