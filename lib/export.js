const mdls = require('shr-models');
const load = require('./load');

function exportToFHIR(specifications) {
  const exporter = new FHIRExporter(specifications);
  return exporter.export();
}

const TARGET = 'FHIR_STU_3';

class FHIRExporter {
  constructor(specifications) {
    this._specs = specifications;
    this._fhir = load(TARGET);
    this._profiles = [];
    this._extensionsMap = new Map();
    this._errors = [];
    this._idCounter = 1;
  }

  export() {
    for (const entry of this._specs.dataElements.all) {
      const map = this._specs.maps.findByTargetAndIdentifier(TARGET, entry.identifier);
      if (typeof map === 'undefined') {
        //console.log(`No Mapping for ${entry.identifier.fqn}`);
        continue;
      }
      // console.log(mappingAsText(map, true));
      this.mappingToProfile(map);
    }
    return {
      profiles: this._profiles,
      extensions: this._extensionsMap.values(),
      errors: this._errors
    };
  }

  mappingToProfile(map) {
    const def = this._fhir.find(map.targetItem);
    if (typeof def === 'undefined') {
      console.error(`Invalid FHIR target: ${map.targetItem}`);
      return;
    }
    const profile = cloneJSON(def);
    delete(profile.meta);
    delete(profile.extension);
    delete(profile.text);
    profile.id = fhirID(map.identifier);
    profile.text = this.getText(map);
    profile.url = fhirURL(map.identifier);
    profile.name = `Standard Health Record ${map.identifier.name} Profile`;
    profile.description = this.getDescription(map.identifier);
    profile.publisher = 'The MITRE Corporation: Standard Health Record Initiative';
    profile.contact = [{
      telecom: [{
        system: 'url',
        value: 'http://www.standardhealthrecord.org'
      }]
    }];
    profile.date = new Date().toISOString(),
    profile.baseDefinition = def.url;
    profile.derivation = 'constraint';
    profile.differential = { element: [] };
    this.processFieldMappings(map, profile);
    this.addExtensions(map, profile);

    this._profiles.push(profile);
  }

  getText(map) {
    return {
      status: 'additional',
      div:
`<div xmlns="http://www.w3.org/1999/xhtml">
  <p><b>Standard Health Record ${map.identifier.name} Profile</b></p>
  <p>${this.getDescription(map.identifier)}</p>
  <p><b>Mapping</b></p>
  <p><pre>${mappingAsText(map, true)}</pre></p>
</div>`
    };
  }

  getDescription(identifier) {
    const def = this._specs.dataElements.findByIdentifier(identifier);
    if (def) {
      return def.description;
    }
  }

  processFieldMappings(map, profile) {
    for (const rule of map.rules) {
      if (rule instanceof mdls.TargetCardinalityMappingRule) {
        this.processTargetCardinalityMappingRule(map, rule, profile);
      } else if (rule.sourcePath.some(p => p instanceof mdls.TBD)) {
        continue;
      } else if (rule instanceof mdls.FieldToFieldMappingRule) {
        this.processFieldToFieldMappingRule(map, rule, profile);
      }
    }
  }

  processFieldToFieldMappingRule(map, rule, profile) {
    // TODO: Support slicing (somehow)
    const ss = this.getSnapshotElement(profile, rule.targetPath);
    if (typeof ss === 'undefined') {
      this._errors.push(new FHIRExportError(`${profile.id}: Cannot apply field mapping to ${profile.type}.  Invalid target path: ${targetPathToString(rule.targetPath)}`));
      return;
    }
    let df = this.getDifferentialElement(profile, rule.targetPath);
    if (typeof df === 'undefined') {
      df = {
        id: ss.id,
        path: ss.path
      };
    }

    // First handle cardinality.  This can be tricky when we're talking about deep paths in the source path or target
    // path, since they will essentially have aggregate cardinalities.  If there is a 1:1 alignment between path
    // components from the source and target (i.e., they have the same number of path components, and each source
    // path component maps to the corresponding target path compoent), then the cardinalities should match up well --
    // but if there is not alignment, then aggregation comes into play (e.g., if "Foo.Bar maps to baz", then the
    // cardinality of baz has to be whatever the total min/max number of Bars is possible.  For example, 0..* Foo with
    // 1..1 Bar, or 1..1 Foo with 0.* Bar, both require 0..* baz).
    if (rule.sourcePath.length == 1) {
      // Simplest case -- just apply the sourcePath's cardinality
      const sourceCard = this.getEffectiveCardinality(map.identifier, rule.sourcePath);
      this.applyCardinality(profile, sourceCard, ss, df);
    } else if (rule.sourcePath.length == rule.targetPath.length) {
      // Test if it is a 1:1 mapping for each component in the path (except we don't have to check the last one)
      let isMatch = true;
      for (let i=0; i < rule.sourcePath.length - 1; i++) {
        const sp = rule.sourcePath.slice(0, i+1);
        const tp = rule.targetPath.slice(0, i+1);
        if (!map.rulesFilter.fieldToField.withSourcePath(sp).withTargetPath(tp).hasRules) {
          isMatch = false;
          break;
        }
      }
      if (isMatch) {
        const sourceCard = this.getEffectiveCardinality(map.identifier, rule.sourcePath);
        this.applyCardinality(profile, sourceCard, ss, df);
      } else {
        // TODO: Handle this
        // console.log('NONMatching paths', map.identifier.fqn, sourcePathToString(rule.sourcePath), targetPathToString(rule.targetPath));
      }
    } else {
      // TODO: Handle this
      // console.log('NONMatching paths', map.identifier.fqn, sourcePathToString(rule.sourcePath), targetPathToString(rule.targetPath));
    }

    if (Object.keys(df).length > 2) {
      profile.differential.element.push(df);
    }
  }

  processTargetCardinalityMappingRule(map, rule, profile) {
    const ss = this.getSnapshotElement(profile, rule.targetPath);
    if (typeof ss === 'undefined') {
      this._errors.push(new FHIRExportError(`${profile.id}: Cannot apply cardinality constraint to ${profile.type}.  Invalid target path: ${targetPathToString(rule.targetPath)}`));
      return;
    }
    let df = this.getDifferentialElement(profile, rule.targetPath);
    if (typeof df === 'undefined') {
      df = {
        id: ss.id,
        path: ss.path
      };
    }
    this.applyCardinality(profile, rule.cardinality, ss, df);

    if (Object.keys(df).length > 2) {
      profile.differential.element.push(df);
    }
  }

  applyCardinality(profile, card, snapshotEl, differentialEl) {
    const ssCard = this.getElementCardinality(snapshotEl);
    if (ssCard && !card.fitsWithinCardinalityOf(ssCard)) {
      this._errors.push(new FHIRExportError(`${profile.id}: Cannot apply cardinality to ${snapshotEl.path} since ${card.toString()} does not fit inside ${ssCard.toString()}`));
    } else if (!ssCard.equals(card)) {
      snapshotEl.min = differentialEl.min = card.min;
      snapshotEl.max = differentialEl.max = typeof card.max !== 'undefined' ? card.max.toString() : '*';
    }
  }

  addExtensions(map, profile) {
    // Start simple (for now) -- just find base-level fields that are not mapped
    let hasExtensions = false;
    const def = this._specs.dataElements.findByIdentifier(map.identifier);
    for (const field of valueAndFields(def)) {
      if (field instanceof mdls.IdentifiableValue) {
        if (field.identifier.isPrimitive) {
          // ?
        } else if (!map.rules.some(r => r.sourcePath && r.sourcePath.length > 0 && r.sourcePath[0].equals(field.identifier))) {
          hasExtensions = true;
          this.addExtension(map, profile, field);
        }
        // TODO: Should also dive into elements that are mapped and check if their sub-fields are mapped (recursively)
      } else {
        // TODO: Support choices
      }
    }

    if (hasExtensions) {
      const ssEl = this.getSnapshotElement(profile, ['extension']);
      ssEl.slicing = {
        id: (this._idCounter++).toString(),
        discriminator: ['url'],
        ordered: false,
        rules: 'open'
      };
      // Apparently this does not need to be added to the differential
    }
  }

  addExtension(map, profile, field) {
    const ext = this.lookupExtension(field.identifier);
    const ssEl = cloneJSON(this.getSnapshotElement(profile, ['extension']));
    ssEl.id = `${ssEl.id}:${shortID(field.identifier)}`;
    ssEl.sliceName = shortID(field.identifier);
    ssEl.min = field.effectiveCard.min;
    ssEl.max = typeof field.effectiveCard.max === 'undefined' ? '*' : field.effectiveCard.max.toString();
    ssEl.type = [{ code : 'Extension', profile : ext.url }];
    // TODO: Do we need to add the condition and constraints here?
    ssEl.mustSupport = true;
    ssEl.isModifier = false;
    ssEl.isSummary = false;
    this.insertExtensionElementInList(ssEl, profile.snapshot.element);

    const dfEl = {
      id: ssEl.id,
      path: ssEl.path,
      sliceName: ssEl.sliceName,
      min: ssEl.min,
      max: ssEl.max,
      type: ssEl.type,
      mustSupport: ssEl.mustSupport,
      isModifier: ssEl.isModifier,
      isSummary: ssEl.isSummary
    };
    this.insertExtensionElementInList(dfEl, profile.differential.element);
    profile.differential.element.push(dfEl);

    return;
  }

  insertExtensionElementInList(extElement, elements) {
    let inserted = false;
    const priorPaths = ['id', 'meta', 'implicitRules', 'language', 'text', 'contained', 'extension'];
    for (let i=0; i < elements.length; i++) {
      const pathParts = elements[i].path.split('.');
      if (pathParts.length > 1 && priorPaths.indexOf(pathParts[1]) == -1) {
        elements.splice(i, 0, extElement);
        inserted = true;
        break;
      }
    }
    if (!inserted) {
      // Just insert it at the end
      elements.push(extElement);
    }
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

    const ext = cloneJSON(this._fhir.extensionTemplate);
    ext.id = fhirID(def.identifier, true);
    ext.url = fhirURL(def.identifier, true);
    // TODO: What is difference between name and title?
    ext.name = ext.title = `Standard Health Record ${def.identifier.name} Extension`;
    ext.date = new Date().toISOString();
    if (def.description) {
      ext.description = def.description;
    } else {
      delete(ext.description);
    }

    // TODO: Do we need to add contextType and context?

    const baseId = `Extension:${shortID(def.identifier)}`;
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
    const map = this._specs.maps.findByTargetAndIdentifier(TARGET, def.identifier);
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
          const valMap = this._specs.maps.findByTargetAndIdentifier(TARGET, def.value.identifier);
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
          for (const opt of this.aggregateChoiceOptions(field)) {
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
      return `${baseExpression}.extension('${shortID(identifier)}')`;
    }
    return `extension('${shortID(identifier)}')`;
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
      fixedUri: baseId.indexOf('.') == -1 ? fhirURL(def.identifier, true) : shortID(def.identifier),
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
      ssValue.type.push({ code: type, targetProfile: fhirURL(profileIdentifier, false) });
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
    const fieldBaseId = `${baseId}.extension:${shortID(field.identifier)}`;

    const ssExt = {
      id: `${fieldBaseId}`,
      path: `${this.getExtensionPathFromExtensionID(fieldBaseId)}`,
      sliceName: shortID(field.identifier),
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

  aggregateChoiceOptions(choice) {
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

  // value[x] doesn't support choices that have extensions as elements, so we need to check for that
  choiceSupportsValueX(choice) {
    // TODO: This assumes choice options don't have their own cardinality.  This isn't true in SHR today, but
    // we're considering restricting it in SHR.  No use going through the trouble of supporting it if it's going away.
    for (const opt of this.aggregateChoiceOptions(choice)) {
      if (opt instanceof mdls.TBD) {
        continue;
      } else if (opt instanceof mdls.IdentifiableValue) {
        if (!opt.identifier.isPrimitive) {
          const map = this._specs.maps.findByTargetAndIdentifier(TARGET, opt.identifier);
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
    for (const opt of this.aggregateChoiceOptions(choice)) {
      if (opt instanceof mdls.TBD) {
        continue;
      } else if (opt instanceof mdls.IdentifiableValue) {
        if (opt.identifier.isPrimitive) {
          types.push({ code: opt.identifier.name });
        } else {
          const map = this._specs.maps.findByTargetAndIdentifier(TARGET, opt.identifier);
          if (typeof map === 'undefined') {
            console.error('Trying to make choice option for non-mapped element', opt.identifier.fqn);
            continue;
          }
          types.push({ code: 'Reference', targetProfile: fhirURL(map.identifier) });
        }
      } else {
        console.error(`Unsupported value type: ${opt.constructor.name}`);
      }
    }
    return types;
  }

  getSnapshotElement(profile, targetPath) {
    // TODO: If path isn't in snapshot, but is valid by drilling into a type, what then?
    const path = `${profile.type}.${targetPath.join('.')}`;
    for (const el of profile.snapshot.element) {
      if (el.path == path) {
        return el;
      }
    }
  }

  getDifferentialElement(profile, targetPath) {
    // TODO: If path isn't in differential, but is valid by drilling into a type, what then?
    const path = `${profile.type}.${targetPath.join('.')}`;
    for (const el of profile.differential.element) {
      if (el.path == path) {
        return el;
      }
    }
  }

  getEffectiveCardinality(elementIdentifier, path) {
    if (path.length == 0) {
      return;
    }

    let match;
    const def = this._specs.dataElements.findByIdentifier(elementIdentifier);
    for (const value of valueAndFields(def)) {
      if (value instanceof mdls.IdentifiableValue) {
        if (value.identifier.equals(path[0])) {
          match = value;
          break;
        }
      } else if (value instanceof mdls.ChoiceValue) {
        // TODO: Support choices of choices
        for (const opt of value.options) {
          if (opt.identifier.equals(path[0])) {
            const card = aggregateCardinality(value.effectiveCard, opt.effectiveCard);
            match = opt.clone();
            match.addConstraint(new mdls.CardConstraint(card));
          }
        }
      }
    }

    if (path.length == 1) {
      return match.effectiveCard;
    } else {
      // Check if there are any deep path card constraints defined
      const cardConstraints = match.constraintsFilter.withPath(path.slice(1)).card.constraints;
      if (cardConstraints.length > 0) {
        return cardConstraints[cardConstraints.length - 1].card;
      }
      // No deep path card constraints, so try at the next level of the path
      return this.getEffectiveCardinality(match.identifier, path.slice(1));
    }
  }

  getElementCardinality(element) {
    if (typeof element.min != 'undefined' && typeof element.max != 'undefined') {
      if (element.max == '*') {
        return new mdls.Cardinality(element.min);
      }
      return new mdls.Cardinality(element.min, parseInt(element.max, 10));
    }
  }
}

function cloneJSON(json) {
  return JSON.parse(JSON.stringify(json));
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

function aggregateCardinality(...card) {
  if (card.length == 0) {
    return;
  }
  const min = card.reduce((val, current) => val * current.min, 1);
  const max = card.reduce((val, current) => {
    if (val == 0 || current.max == 0) {
      return 0;
    } else if (typeof val === 'undefined' || typeof current.max == 'undefined') {
      return; // keep it undefined (e.g. unbounded)
    } else {
      return val * current.max;
    }
  }, 1);
  return new mdls.Cardinality(min, max);
}

function mappingAsText(map, simple=false) {
  let text = `${map.identifier.fqn} maps to ${map.targetItem}:\n`;
  for (const rule of map.rules) {
    if (rule instanceof mdls.FieldToFieldMappingRule) {
      text += `  ${sourcePathToString(rule.sourcePath, simple)} maps to ${targetPathToString(rule.targetPath)}\n`;
    } else if (rule instanceof mdls.FieldToURLMappingRule) {
      text += `  ${sourcePathToString(rule.sourcePath, simple)} maps to ${rule.targetURL}\n`;
    } else if (rule instanceof mdls.TargetCardinalityMappingRule) {
      text += `  ${targetPathToString(rule.targetPath)} is ${rule.cardinality.toString()}\n`;
    } else {
      text += `  Unknown mapping rule: ${rule.constructor.name}\n`;
    }
  }
  return text;
}

function sourcePathToString(path, simple) {
  const path2 = path.map(p => {
    if (p instanceof mdls.TBD) {
      return `TBD "${p.text}"`;
    }
    return simple ? p.name : `"${p.fqn}"`;
  });
  return path2.join('.');
}

function targetPathToString(path) {
  return path.join('.');
}

class FHIRExportError extends Error {
  constructor(message = 'FHIR export error') {
    super(message);
    this.message = message;   // from Error
    this.name = 'FHIRExportError'; // from Error
  }
}

module.exports = {exportToFHIR, FHIRExporter};