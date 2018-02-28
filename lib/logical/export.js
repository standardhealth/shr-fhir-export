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
      model.url = common.fhirURL(def.identifier, this._config.fhirURL);
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
    } else {
      el = model.newElement(common.shortID(value.effectiveIdentifier));
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
    // For now, just do own constraints
    for (const c of value.constraintsFilter.own.constraints) {
      if (c instanceof mdls.ValueSetConstraint) {
        this.applyValueSetConstraint(model, value, el, c);
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

    el.applyBinding(vsURI, strength);
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

  toTypeArray(value) {
    const toType = (v) => {
      const id = v.effectiveIdentifier;
      if (id.isPrimitive || id.equals(CODEABLE_CONCEPT_ID) || id.equals(CODING_ID)) {
        return { code: id.name };
      } else if (v instanceof mdls.RefValue) {
        return { code: 'Reference', targetProfile: common.fhirURL(id, this._config.fhirURL) };
      }
      return { code: common.fhirURL(id, this._config.fhirURL) };
    };
    if (value instanceof mdls.TBD) {
      return undefined;
    } else if (value instanceof mdls.ChoiceValue) {
      const nonTBDs = value.aggregateOptions.filter(o => !(o instanceof mdls.TBD));
      return nonTBDs.map(o => toType(o));
    }
    return toType(value);
  }
}

module.exports = {ModelsExporter, setLogger};
