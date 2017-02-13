const mdls = require('shr-models');
const common = require('./common');

class ExtensionExporter {
  constructor(specifications, fhir, target) {
    this._specs = specifications;
    this._fhir = fhir;
    this._target = target;
    this._extensionsMap = new Map();
    this._idCounter = 1;
  }

  get extensions() {
    return Array.from(this._extensionsMap.values());
  }

  lookupExtension(identifier) {
    const ext = this._extensionsMap.get(identifier.fqn);
    if (ext) {
      return ext;
    }
    return this.createExtension(identifier);
  }

  createExtension(identifier) {
    const def = this._specs.dataElements.findByIdentifier(identifier);

    const ext = common.cloneJSON(this._fhir.extensionTemplate);
    ext.id = common.fhirID(def.identifier, true);
    ext.url = common.fhirURL(def.identifier, true);
    // TODO: What is difference between name and title?
    ext.name = ext.title = `Standard Health Record ${def.identifier.name} Extension`;
    ext.date = new Date().toISOString();
    if (def.description) {
      ext.description = def.description;
    } else {
      delete(ext.description);
    }

    // TODO: Do we need to add contextType and context?

    const baseId = `Extension:${common.shortID(def.identifier)}`;
    this.pushDefExtensionElements(ext, baseId, '', def);
    this._extensionsMap.set(identifier.fqn, ext);

    // TODO: Add extension to profile
    return ext;
  }

  pushDefExtensionElements(extension, baseId, baseExpression, def, card=new mdls.Cardinality(0)) {
    this.pushExtensionBaseElement(extension, baseId, def, card);
    this.pushExtensionIdElement(extension, baseId);

    // If this supports a simple extension, then determine its type (and other necessary data)
    let type, profileIdentifier, choice;
    const map = this._specs.maps.findByTargetAndIdentifier(this._target, def.identifier);
    if (typeof map !== 'undefined') {
      type = 'Reference';
      profileIdentifier = map.identifier;
    } else if (typeof def.value !== 'undefined' && def.value.effectiveCard.max <= 1 && def.fields.length == 0) {
      card = def.value.effectiveCard;
      if (def.value instanceof mdls.ChoiceValue && this.choiceSupportsValueX(def.value)) {
        type = '[x]';
        choice = def.value;
      } else if (def.value instanceof mdls.IdentifiableValue) {
        if (def.value.identifier.isPrimitive) {
          type = def.value.identifier.name;
        } else {
          const valMap = this._specs.maps.findByTargetAndIdentifier(this._target, def.value.identifier);
          if (typeof valMap !== 'undefined') {
            type = 'Reference';
            profileIdentifier = valMap.identifier;
          }
        }
      }
    }

    // If 'type' is not defined, that means we can't represent this as a simple extension
    if (typeof type === 'undefined') {
      this.pushExtensionSlicedExtensionsElement(extension, baseId);
      for (const field of [def.value, ...def.fields]) {
        if (typeof field === 'undefined') {
          continue;
        } else if (field instanceof mdls.IdentifiableValue) {
          this.pushExtensionSubExtensionElements(extension, baseId, baseExpression, def, field);
        } else if (field instanceof mdls.ChoiceValue) {
          // For now... we put the choice options at the same level as everything else
          // TODO: Take out the options that are individually mapped to other things?
          const optExpressions = [];
          for (const opt of field.aggregateOptions) {
            if (opt instanceof mdls.IdentifiableValue) {
              // Need to clone and set min card to 0 since this is a choice option.  Will have to enforce that one
              // be picked via invariants.
              const newOpt = opt.clone().withConstraint(new mdls.CardConstraint(new mdls.Cardinality(0, opt.effectiveCard.max)));
              this.pushExtensionSubExtensionElements(extension, baseId, baseExpression, def, newOpt);
              optExpressions.push(this.appendExtensionExpression(baseExpression, opt.identifier));
            }
          }
          if (optExpressions.length > 1) {
            const choiceNum = 1 + extension.snapshot.element[0].constraint.filter(c => c.key.startsWith('choice-')).length;
            const constraint = {
              key: `choice-${choiceNum}`,
              severity: 'error',
              human: `${extension.id} SHALL have either `,
              expression: '( '
            };
            for (let i=0; i < optExpressions.length; i++) {
              if (i > 0) {
                constraint.human += ' or ';
                constraint.expression += ' | ';
              }
              constraint.human += optExpressions[i];
              constraint.expression += `${optExpressions[i]}.url`;
            }
            const distinctCountComparison = field.effectiveCard.min == 0 ? '<= 1' : '== 1';
            constraint.expression += ` ).distinct().count() ${distinctCountComparison}`;
            extension.snapshot.element[0].constraint.push(constraint);
            if (typeof extension.differential.element[0].constraint === 'undefined') {
              extension.differential.element[0].constraint = [];
            }
            extension.differential.element[0].constraint.push(constraint);
          }
        } else if (field instanceof mdls.TBD) {
          continue;
        } else {
          console.error('Unsupported field value type: ', field.constructor.name);
        }
      }
      this.pushExtensionURLElement(extension, baseId, def);
      this.pushExtensionNoValueXElement(extension, baseId);
    } else {
      this.pushExtensionNoExtensionsElement(extension, baseId);
      this.pushExtensionURLElement(extension, baseId, def);
      this.pushExtensionValueXElement(extension, baseId, type, card, profileIdentifier, choice);
    }
  }

  appendExtensionExpression(baseExpression, identifier) {
    if (baseExpression.length > 0) {
      return `${baseExpression}.extension('${common.shortID(identifier)}')`;
    }
    return `extension('${common.shortID(identifier)}')`;
  }

  pushExtensionBaseElement(extension, baseId, def, card=new mdls.Cardinality(0)) {
    const ssExt = {
      id: `${baseId}`,
      path: `${this.getExtensionPathFromExtensionID(baseId)}`,
      short: def.identifier.isPrimitive ? def.identifier.name : `Standard Health Record ${def.identifier.name} Extension`,
      definition: def.description,
      min: card.min,
      max: typeof card.max === 'undefined' ? '*' : card.max.toString(),
      base: { path: 'Extension', min: 0, max: '1' },
      condition: [],
      constraint: []
    };
    if (ssExt.path == 'Extension') {
      // We're at very root of extension, so add the conditions and constraints
      ssExt.condition.push('ele-1');
      ssExt.constraint.push({
        key: 'ele-1',
        severity: 'error',
        human: 'All FHIR elements must have a @value or children',
        expression: 'children().count() > id.count()',
        xpath: '@value|f:*|h:div',
        source: 'Element'
      }, {
        key: 'ext-1',
        severity: 'error',
        human: 'Must have either extensions or value[x], not both',
        expression: 'extension.exists() != value.exists()',
        xpath: 'exists(f:extension)!=exists(f:*[starts-with(local-name(.), \'value\')])',
        source: 'Extension'
      });
    } else {
      delete(ssExt.condition);
      delete(ssExt.constraint);
    }
    extension.snapshot.element.push(ssExt);
    const dfExt = {
      id: ssExt.id,
      path: ssExt.path,
      short: ssExt.short,
      definition: ssExt.definition,
      min: ssExt.min,
      max: ssExt.max
    };
    extension.differential.element.push(dfExt);
  }

  pushExtensionIdElement(extension, baseId) {
    const ssExt = {
      id: `${baseId}.id`,
      path: `${this.getExtensionPathFromExtensionID(baseId)}.id`,
      representation: ['xmlAttr'],
      short: 'xml:id (or equivalent in JSON)',
      definition: 'unique id for the element within a resource (for internal references). This may be any string value that does not contain spaces.',
      min: 0,
      max: '1',
      base: { path: 'Element.id', min: 0, max: '1' },
      type: [{ code: 'string' }],
      mapping: [{ identity: 'rim', map: 'N/A' }]
    };
    extension.snapshot.element.push(ssExt);
    // ids apparently don't need to go into the differential
  }

  pushExtensionNoExtensionsElement(extension, baseId) {
    const ssExt = {
      id: `${baseId}.extension:extension`,
      path: `${this.getExtensionPathFromExtensionID(baseId)}.extension`,
      sliceName: 'extension',
      short: 'Extension',
      definition: 'An Extension',
      min: 0,
      max: '0',
      base: { path: 'Element.extension', min: 0, max: '*' },
      type: [{ code: 'Extension' }]
    };
    extension.snapshot.element.push(ssExt);
    const dfExt = {
      id: ssExt.id,
      path: ssExt.path,
      sliceName: ssExt.sliceName,
      max: ssExt.max
    };
    extension.differential.element.push(dfExt);
  }

  pushExtensionSlicedExtensionsElement(extension, baseId) {
    const ssExt = {
      id: `${baseId}.extension`,
      path: `${this.getExtensionPathFromExtensionID(baseId)}.extension`,
      slicing: {
        id: (this._idCounter++).toString(),
        discriminator: ['url'],
        ordered: false,
        rules: 'open'
      },
      short: 'Extension',
      definition: 'An Extension',
      min: 0,
      max: '*',
      base: { path: 'Element.extension', min: 0, max: '*' },
      type: [{ code: 'Extension' }]
    };
    extension.snapshot.element.push(ssExt);
    // extension.extension apparently doesn't need to go into the differential
  }

  pushExtensionURLElement(extension, baseId, def) {
    const ssURL = {
      id: `${baseId}.url`,
      path: `${this.getExtensionPathFromExtensionID(baseId)}.url`,
      representation: ['xmlAttr'],
      short: 'identifies the meaning of the extension',
      definition: 'Source of the definition for the extension code - a logical name or a URL.',
      comments: 'The definition may point directly to a computable or human-readable definition of the extensibility codes, or it may be a logical URI as declared in some other specification. The definition SHALL be a URI for the Structure Definition defining the extension.',
      min: 1,
      max: '1',
      base: { path: 'Extension.url', min: 1, max: '1' },
      type: [{ code: 'uri' }],
      fixedUri: baseId.indexOf('.') == -1 ? common.fhirURL(def.identifier, true) : common.shortID(def.identifier),
      mapping: [{ identity: 'rim', map: 'N/A' }]
    };
    extension.snapshot.element.push(ssURL);
    const dfURL = {
      id: ssURL.id,
      path: ssURL.path,
      type: ssURL.type,
      fixedUri: ssURL.fixedUri
    };
    extension.differential.element.push(dfURL);
  }

  pushExtensionValueXElement(extension, baseId, type, card=new mdls.Cardinality(1,1), profileIdentifier, choice) {
    const ucType = type.charAt(0).toUpperCase() + type.slice(1);
    const ssValue = {
      id: `${baseId}.value${ucType}`,
      path: `${this.getExtensionPathFromExtensionID(baseId)}.value${ucType}`,
      short: 'Value of extension',
      definition: 'Value of extension - may be a resource or one of a constrained set of the data types (see Extensibility in the spec for list).',
      min: card.min,
      max: typeof card.max === 'undefined' ? '*' : card.max.toString(),
      base: { path: 'Extension.value[x]', min: 0, max: '1' },
      type: [],
      mapping: [{ identity: 'rim', map: 'N/A' }]
    };
    if (typeof choice !== 'undefined') {
      ssValue.type.push(...this.getChoiceOptionTypes(choice));
    } else if (typeof profileIdentifier !== 'undefined') {
      ssValue.type.push({ code: type, targetProfile: common.fhirURL(profileIdentifier, false) });
    } else {
      ssValue.type.push({ code: type});
    }
    extension.snapshot.element.push(ssValue);
    const dfValue = {
      id: ssValue.id,
      path: ssValue.path,
      min: ssValue.min,
      type: ssValue.type
    };
    extension.differential.element.push(dfValue);
  }

  pushExtensionNoValueXElement(extension, baseId) {
    const ssValue = {
      id: `${baseId}.value[x]`,
      path: `${this.getExtensionPathFromExtensionID(baseId)}.value[x]`,
      short: 'Value of extension',
      definition: 'Value of extension - may be a resource or one of a constrained set of the data types (see Extensibility in the spec for list).',
      min: 0,
      max: 0,
      base: { path: 'Extension.value[x]', min: 0, max: '1' },
      type: [
        { code: 'base64Binary' }, { code: 'boolean' }, { code: 'code' }, { code: 'date' }, { code: 'dateTime' },
        { code: 'decimal' }, { code: 'id' }, { code: 'instant' }, { code: 'integer' }, { code: 'markdown' },
        { code: 'oid' }, { code: 'positiveInt' }, { code: 'string' }, { code: 'time' }, { code: 'unsignedInt' },
        { code: 'uri' }, { code: 'Address' }, { code: 'Age' }, { code: 'Annotation' }, { code: 'Attachment' },
        { code: 'CodeableConcept' }, { code: 'Coding' }, { code: 'ContactPoint' }, { code: 'Count' },
        { code: 'Distance' }, { code: 'Duration' }, { code: 'HumanName' }, { code: 'Identifier' }, { code: 'Money' },
        { code: 'Period' }, { code: 'Quantity' }, { code: 'Range' }, { code: 'Ratio' }, { code: 'Reference' },
        { code: 'SampledData' }, { code: 'Signature' }, { code: 'Timing' }, { code: 'Meta' }
      ],
      mapping: [{ identity: 'rim', map: 'N/A' }]
    };
    extension.snapshot.element.push(ssValue);
    const dfValue = {
      id: ssValue.id,
      path: ssValue.path,
      min: ssValue.min,
      max: ssValue.max,
    };
    extension.differential.element.push(dfValue);
  }

  pushExtensionSubExtensionElements(extension, baseId, baseExpression, def, field) {
    if (field.identifier.isPrimitive) {
      // This can only be in the value... so hijack the def and ovverride it's identifier with this one
      // TODO: Is there a better way?  Should we actually use the real primitive's definitions?
      const primDef = new mdls.DataElement(field.identifier, false);
      primDef.description = def.description;
      primDef.value = new mdls.IdentifiableValue(field.identifier).withMinMax(1, 1);
      const primBaseId = `${baseId}.extension:${field.identifier.name}`;
      const primBaseExpression = this.appendExtensionExpression(baseExpression, field.identifier);
      this.pushDefExtensionElements(extension, primBaseId, primBaseExpression, primDef, field.effectiveCard);
      return;
    }

    const subExt = this.lookupExtension(field.identifier);
    const fieldBaseId = `${baseId}.extension:${common.shortID(field.identifier)}`;

    const ssExt = {
      id: `${fieldBaseId}`,
      path: `${this.getExtensionPathFromExtensionID(fieldBaseId)}`,
      sliceName: common.shortID(field.identifier),
      short: subExt.short,
      definition: subExt.definition,
      min: field.effectiveCard.min,
      max: typeof field.effectiveCard.max === 'undefined' ? '*' : field.effectiveCard.max.toString(),
      base: { path: 'Extension.extension', min: 0, max: '1' },
      type: [{ code: 'Extension', profile: subExt.url }],
      mapping: [{ identity: 'rim', map: 'N/A' }]
    };
    extension.snapshot.element.push(ssExt);

    const dfExt = {
      id: ssExt.id,
      path: ssExt.path,
      sliceName: ssExt.path,
      short: ssExt.short,
      definition: ssExt.definition,
      min: ssExt.min,
      max: ssExt.max,
      type: ssExt.type
    };
    extension.differential.element.push(dfExt);
  }

  getExtensionPathFromExtensionID(id) {
    // Changes a:x.b:y.c.d:z to a.b.c.d
    return id.split('.').map(p => p.split(':')[0]).join('.');
  }

  // value[x] doesn't support choices that have extensions as elements, so we need to check for that
  choiceSupportsValueX(choice) {
    // TODO: This assumes choice options don't have their own cardinality.  This isn't true in SHR today, but
    // we're considering restricting it in SHR.  No use going through the trouble of supporting it if it's going away.
    for (const opt of choice.aggregateOptions) {
      if (opt instanceof mdls.TBD) {
        continue;
      } else if (opt instanceof mdls.IdentifiableValue) {
        if (!opt.identifier.isPrimitive) {
          const map = this._specs.maps.findByTargetAndIdentifier(this._target, opt.identifier);
          if (typeof map === 'undefined') {
            return false;
          }
        }
      } else {
        console.error(`Unsupported value type: ${opt.constructor.name}`);
        return false;
      }
    }

    return true;
  }

  getChoiceOptionTypes(choice) {
    // TODO: This assumes choice options don't have their own cardinality.  This isn't true in SHR today, but
    // we're considering restricting it in SHR.  No use going through the trouble of supporting it if it's going away.
    const types = [];
    for (const opt of choice.aggregateOptions) {
      if (opt instanceof mdls.TBD) {
        continue;
      } else if (opt instanceof mdls.IdentifiableValue) {
        if (opt.identifier.isPrimitive) {
          types.push({ code: opt.identifier.name });
        } else {
          const map = this._specs.maps.findByTargetAndIdentifier(this._target, opt.identifier);
          if (typeof map === 'undefined') {
            console.error('Trying to make choice option for non-mapped element', opt.identifier.fqn);
            continue;
          }
          types.push({ code: 'Reference', targetProfile: common.fhirURL(map.identifier) });
        }
      } else {
        console.error(`Unsupported value type: ${opt.constructor.name}`);
      }
    }
    return types;
  }
}

module.exports = {ExtensionExporter};