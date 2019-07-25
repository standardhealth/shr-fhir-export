const bunyan = require('bunyan');
const mdls = require('shr-models');
const common = require('./common');
const MVH = require('./multiVersionHelper');

var rootLogger = bunyan.createLogger({name: 'shr-fhir-export'});
var logger = rootLogger;
function setLogger(bunyanLogger) {
  rootLogger = logger = bunyanLogger;
}

class ExtensionExporter {
  constructor(_profileExporter, specifications, fhir, target, configuration) {
    this._profileExporter = _profileExporter;
    this._specs = specifications;
    this._fhir = fhir;
    this._target = target;
    this._config = configuration;
    this._extensionsMap = new Map();
    this._processTracker = new common.ProcessTracker();
  }

  // The process tracker is used to keep track of what profiles are currently being processed.  This allows us to
  // check for possible issues when looking up and using a profile that is currently mid-process.
  get processTracker() {
    return this._processTracker;
  }

  get extensions() {
    return Array.from(this._extensionsMap.values());
  }

  lookupExtension(identifier, createIfNeeded=true, warnIfExtensionIsProcessing=false) {
    let ext = this._extensionsMap.get(identifier.fqn);
    if (ext === undefined && createIfNeeded) {
      ext = this.createExtension(identifier);
    } else if (warnIfExtensionIsProcessing && this._processTracker.isActive(identifier)) {
      logger.warn('Using extension that is currently in the middle of processing: %s. ERROR_CODE:13055', common.fhirID(identifier, 'extension'));
    }
    return ext;
  }

  createExtension(identifier) {
    const lastLogger = logger;
    logger = rootLogger.child({ shrId: identifier.fqn });
    logger.debug('Start creating extension');
    this._processTracker.start(identifier.fqn, common.fhirID(identifier, 'extension'));
    try {
      let def = this._specs.dataElements.findByIdentifier(identifier);
      if (def === undefined && identifier.isPrimitive) {
        // We can cheat by creating a definition to represent the primitive value
        def = new mdls.DataElement(identifier, false)
          .withDescription(`The ${identifier.name} that represents the value of the element to which it is applied.`)
          .withValue(new mdls.IdentifiableValue(identifier).withMinMax(1,1));
      }

      const ext = this.getExtensionStarter(def);

      // Set the extension in the extensionsMap _before_ iterating over the fields in order to avoid
      // an infinite loop.  For example, if element A has field B, and element B has field A, then
      // during the creation of extension A, it will need to reference extension B.  If extension B
      // does not yet exist, it will try to create it.  When creating extension B, it will then iterate
      // over B's fields and check if extension A exists yet.  If A isn't in the extensionsMap, it will
      // try to create extension A again, starting the infinite loop.  We add the extension to the map
      // early to avoid this situation.
      this._extensionsMap.set(identifier.fqn, ext);

      // Now add all the snapshot and differential elements.  Since the extension is in the map by
      // reference, we shouldn't need to set it in the map again after.
      this.pushDefExtensionElements(ext, ext.snapshot.element[0].id, '', def);

      // Since we might have "unrolled" elements from a profile into this extension, we need to do
      // the same cleanup as in the profile exporter
      this._profileExporter.cleanupProfile(ext);

      return ext;
    } finally {
      this._processTracker.stop(identifier.fqn, common.fhirID(identifier, 'extension'));
      // Close out the logging for this mapping
      logger.debug('Done creating extension');
      logger = lastLogger;
    }
  }

  getExtensionStarter(def) {
    const ext = this._fhir.extensionTemplate;
    ext.id = common.fhirID(def.identifier, 'extension');
    ext.text.div = this.getTextDiv(def.identifier);
    ext.url = common.fhirURL(def.identifier, this._config.fhirURL, 'extension');
    ext.name = common.tokenize(def.identifier.name);
    MVH.setSdTitle(ext, common.fhirID(def.identifier));
    if (this._config.publisher) {
      ext.publisher = this._config.publisher;
    } else {
      delete(ext.publisher);
    }
    ext.contact = MVH.convertContactDetails(ext, this._config.contact);
    ext.identifier = [{ system: this._config.projectURL, value: def.identifier.fqn }],
    ext.date = this._config.publishDate || common.todayString();
    if (def.description) {
      ext.description = def.description.trim();
    } else {
      delete(ext.description);
    }

    return ext;
  }

  pushDefExtensionElements(extension, baseId, baseExpression, def) {
    this.setRootElement(extension, def);

    const valueX = extension.snapshot.element.find(e => e.path === 'Extension.value[x]');
    const valueXTypes = valueX.type.map(t => t.code);
    const [type, value] = this.getSimpleTypeAndValue(valueXTypes, def);

    // If 'type' is not defined, that means we can't represent this as a simple extension
    if (type === undefined) {
      for (const field of [def.value, ...def.fields]) {
        if (field === undefined) {
          continue;
        } else if (field instanceof mdls.IdentifiableValue) {
          this.pushExtensionSubExtensionElements(extension, baseId, def, field);
        } else if (field instanceof mdls.ChoiceValue) {
          // For now... we put the choice options at the same level as everything else
          // TODO: Take out the options that are individually mapped to other things?
          //       Is this necessary if we don't automagically create extensions for anything that does have a deeper mapping path present?
          const optExpressions = [];
          for (const opt of field.aggregateOptions) {
            if (opt instanceof mdls.IdentifiableValue) {
              // Need to clone and set min card to 0 since this is a choice option.  Will have to enforce that one
              // be picked via invariants.
              const newOpt = opt.clone().withConstraint(new mdls.CardConstraint(new mdls.Cardinality(0, opt.effectiveCard.max)));
              this.pushExtensionSubExtensionElements(extension, baseId, def, newOpt);
              optExpressions.push(this.appendExtensionExpression(baseExpression, opt.effectiveIdentifier));
            }
          }
          // NOTE: Don't generate out the constraints for FHIR DSTU2
          if (this._target !== 'FHIR_DSTU_2' && optExpressions.length > 1) {
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
            if (extension.differential.element[0].constraint === undefined) {
              extension.differential.element[0].constraint = [];
            }
            extension.differential.element[0].constraint.push(constraint);
          }
        } else if (field instanceof mdls.TBD) {
          continue;
        } else {
          logger.error('Unsupported field value type: %s. ERROR_CODE:13052', field.constructor.name);
        }
      }
      this.setURLElement(extension, def);
      this.zeroOutValueXElement(extension);
    } else {
      this.zeroOutExtensionElement(extension);
      this.setURLElement(extension, def);
      this.setValueXElement(extension, def, type, value);
    }
  }

  appendExtensionExpression(baseExpression, identifier) {
    if (baseExpression.length > 0) {
      return `${baseExpression}.extension('${common.shortID(identifier)}')`;
    }
    return `extension('${common.shortID(identifier)}')`;
  }

  /**
   * If this supports a simple extension, then determine its type (and other necessary data).
   * It is a simple type if one of the following is true:
   * a) it is an entry or abstract that maps to a FHIR resource/datatype (return 'Reference' and idValue)
   * b) it is an element that maps to one of the FHIR datatypes in value[x] (return target type and idValue)
   * c) it has a 0..1 or 1..1 choice value, no fields, and all choices map into value[x] (return '[x]' and choice value)
   * d) it has a 0..1 or 1..1 primitive value and no fields (return primitive type and idValue)
   * e) it has a 0..1 or 1..1 value whose definition meets one of these rules
   */
  getSimpleTypeAndValue(valueXTypes, def, defAsValue) {
    if (defAsValue == null) {
      defAsValue = new mdls.IdentifiableValue(def.identifier).withMinMax(1,1);
    }
    let type, value;
    const map = this._specs.maps.findByTargetAndIdentifier(this._target, def.identifier);
    if (map != null) {
      if (def.isEntry || def.isAbstract) {
        // Entries and abstracts should be represented as references to a resource/profile
        type = 'Reference';
        value = defAsValue;
      } else  {
        const targets = common.getFHIRTypeHierarchy(this._fhir, common.TargetItem.parse(map.targetItem).target);
        const target = targets.find(t => valueXTypes.indexOf(t) !== -1);
        if (target) {
          // Non-entries should map to one of the choice types
          type = target;
          value = defAsValue;
        }
      }
    } else if (def.value !== undefined && def.value.effectiveCard.max <= 1 && def.fields.length == 0) {
      if (def.value instanceof mdls.ChoiceValue && this.choiceSupportsValueX(def.value)) {
        value = def.value;
        type = '[x]';
      } else if (def.value instanceof mdls.IdentifiableValue) {
        if (def.value.effectiveIdentifier.isPrimitive) {
          value = def.value;
          type = def.value.effectiveIdentifier.name;
          if (type === 'concept') {
            type = 'CodeableConcept';
          } else if (type === 'xhtml') {
            // xhtml is a weird type in FHIR and needs to be treated as a string
            type = 'string';
          }
        } else {
          const valueDef = this._specs.dataElements.findByIdentifier(def.value.effectiveIdentifier);
          if (valueDef) {
            return this.getSimpleTypeAndValue(valueXTypes, valueDef, def.value);
          }
        }
      }
    }
    return [type, value];
  }

  setRootElement(extension, def) {
    const ssExt = extension.snapshot.element[0];
    ssExt.short = def.identifier.name;
    if (def.description && def.description.trim() !== '') {
      ssExt.definition = def.description.trim();
    } else {
      // definition is *required*, so put something there
      ssExt.definition = def.identifier.name;
    }

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

  zeroOutExtensionElement(extension) {
    const ssExt = extension.snapshot.element.find(e => e.path === 'Extension.extension');
    ssExt.max = '0';
    if (this._target === `FHIR_DSTU_2`) {
      // slicing wasn't in original FHIR Extension definition, so remove it
      delete ssExt.slicing;
    }

    const dfExt = {
      id: ssExt.id,
      path: ssExt.path,
      min: ssExt.min,
      max: ssExt.max
    };
    extension.differential.element.push(dfExt);
  }

  setURLElement(extension, def) {
    const ssURL = extension.snapshot.element.find(e => e.path === 'Extension.url');
    ssURL.fixedUri = common.fhirURL(def.identifier, this._config.fhirURL, 'extension');

    const dfURL = {
      id: ssURL.id,
      path: ssURL.path,
      type: ssURL.type,
      fixedUri: ssURL.fixedUri
    };
    // We changed the type only in R4, so delete it from the differential otherwise
    if (this._target === 'FHIR_DSTU_2' || this._target === 'FHIR_STU_3') {
      delete dfURL.type;
    }
    extension.differential.element.push(dfURL);
  }

  setValueXElement(extension, def, type, value) {
    const ucType = type.charAt(0).toUpperCase() + type.slice(1);
    const ssValueX = extension.snapshot.element.find(e => e.path === 'Extension.value[x]');
    const originalTypes = ssValueX.type;
    if (ucType !== '[x]') {
      ssValueX.id = ssValueX.id.replace('[x]', ucType);
      ssValueX.path = ssValueX.path.replace('[x]', ucType);
    }
    ssValueX.min = 1;
    ssValueX.type = [];
    const dfValue = {
      id: ssValueX.id,
      path: ssValueX.path,
      min: ssValueX.min,
      type: ssValueX.type
    };
    extension.differential.element.push(dfValue);

    if (value instanceof mdls.ChoiceValue) {
      for (const opt of value.aggregateOptions) {
        const t = MVH.convertType(extension, this.getTypeFromValue(opt, originalTypes));
        if (t === undefined) {
          continue;
        } else if (ssValueX.type.some(x => x.code == t.code && (MVH.typeProfile(x) && (MVH.typeProfile(x).some(tp => MVH.typeHasProfile(t, tp))) || (MVH.typeTargetProfile(x) && MVH.typeTargetProfile(x).some(tp => MVH.typeHasTargetProfile(t, tp)))))) {
          // TODO: Should we allow choices of codes w/ different value sets or require new VS be made?
          // This usually means we need some kind of composite valueset
        } else {
          if (t.profile && t.profile.length > 0) {
            // handling for STU3 since profile isn't an array
            const profiles = Array.isArray(t.profile) ? t.profile : [t.profile];
            profiles.forEach(p => MVH.addTypeProfile(extension, ssValueX.type, t.code, p));
          } else if (t.targetProfile && t.targetProfile.length > 0) {
            // handling for STU3 since targetProfile isn't an array
            const targetProfiles = Array.isArray(t.targetProfile) ? t.targetProfile : [t.targetProfile];
            targetProfiles.forEach(tp => MVH.addTypeTargetProfile(extension, ssValueX.type, t.code, tp));
          } else {
            if (!ssValueX.type.some(vt => vt.code === t.code && vt.profile == null && vt.targetProfile == null)) {
              ssValueX.type.push(t);
            }
          }
          this._profileExporter.applyConstraints(opt, extension, ssValueX, dfValue, false);
        }
      }
    } else if (value && value instanceof mdls.IdentifiableValue && ! value.effectiveIdentifier.isPrimitive) {
      // Set the profile or targetProfile if appropriate
      const profile = this._profileExporter.lookupProfile(value.effectiveIdentifier, true, true);
      if (type == 'Reference') {
        MVH.addTypeTargetProfile(extension, ssValueX.type, type, profile.url);
      } else if (common.isCustomProfile(profile) || profile.id !== type) {
        MVH.addTypeProfile(extension, ssValueX.type, type, profile.url);
      } else {
        if (!ssValueX.type.some(t => t.code === type && t.profile == null && t.targetProfile == null)) {
          ssValueX.type.push({code: type});
        }
      }
    } else {
      if (!ssValueX.type.some(t => t.code === type && t.profile == null && t.targetProfile == null)) {
        ssValueX.type.push({code: type});
      }
    }
    if (value instanceof mdls.IdentifiableValue) {
      this._profileExporter.applyConstraints(value, extension, ssValueX, dfValue, false);
    }

    // Validate that we haven't added any invalid types
    const invalidTypes = ssValueX.type.filter(newType => originalTypes.every(oldType => oldType.code !== newType.code));
    for (const invType of invalidTypes) {
      logger.error('Cannot create extension with value[x] type: %s', JSON.stringify(invType));
      ssValueX.type = ssValueX.type.filter(t => t != invType);
    }

    const cp = this._specs.contentProfiles.findByIdentifier(def.identifier);
    if (cp != null) {
      const cpRules = cp.rules.filter(r => {
        if (r.path[0].isValueKeyWord) {
          return true;
        } else if (value instanceof mdls.IdentifiableValue) {
          return r.path[0].equals(value.effectiveIdentifier);
        } else if (value instanceof mdls.ChoiceValue) {
          return value.aggregateOptions.some(opt => r.path[0].equals(opt));
        }
      });
      cpRules.forEach(r => {
        if (r.path.length === 1) {
          if (r.mustSupport) {
            ssValueX.mustSupport = dfValue.mustSupport = true;
          }
        } else {
          // Partial match: dive further into the element to get the full match.
          // Get the expected FHIR subpath for the remaining identifier path
          const targetSubPath = this._profileExporter.findTargetFHIRPath(r.path[0], r.path.slice(1));
          if (targetSubPath) {
            // The subpath was determined, so now get the "Value" for the tail of the path,
            // which is needed when getting the corresponding snapshot element
            const def = this._specs.dataElements.findByIdentifier(r.path[0]);
            const tailValue = this._profileExporter.findValueByPath(r.path.slice(1), def, false, []);
            // Get the deeper snapshot elements for each of the matched elements
            const targetPath = `${ssValueX.path}.${targetSubPath}`;
            // Convert to a field target so we can use an existing function
            const fieldTarget = new common.FieldTarget(targetPath.slice(targetPath.indexOf('.') + 1)); // Remove resource prefix
            const targetSS = this._profileExporter.getSnapshotElementForFieldTarget(extension, fieldTarget, tailValue);
            if (targetSS) {
              if (r.mustSupport) {
                const targetDF = common.getDifferentialElementById(extension, targetSS.id, true);
                targetSS.mustSupport = targetDF.mustSupport = true;
              }
            } else {
              logger.error('Could not find FHIR element with path %s for content profile rule with path %s.  ERROR_CODE:13063',
                targetPath, r.path.map(p => p.name).join('.'));
            }
          } else {
            logger.error('Could not find FHIR element for content profile rule with path %s.  ERROR_CODE:13064',
              r.path.map(p => p.name).join('.'));
          }
        }
      });
    }
  }

  zeroOutValueXElement(extension) {
    const ssValueX = extension.snapshot.element.find(e => e.path === 'Extension.value[x]');
    ssValueX.max = '0';

    const dfValue = {
      id: ssValueX.id,
      path: ssValueX.path,
      min: ssValueX.min,
      max: ssValueX.max,
    };
    extension.differential.element.push(dfValue);
  }

  pushExtensionSubExtensionElements(extension, baseId, def, field) {
    const baseExt = extension.snapshot.element.find(e => e.path === 'Extension.extension');
    if (this._target === `FHIR_DSTU_2`) {
      // DSTU2 didn't have slicing in original Extension.extension definition, so we need to add a diff for it
      let baseDfExt = common.getDifferentialElementById(extension, baseExt.id, false);
      if (baseDfExt == null) {
        const baseDfExt = {
          id: baseExt.id,
          path: baseExt.path,
          slicing: baseExt.slicing
        };
        extension.differential.element.push(baseDfExt);
      }
    }

    if (field.effectiveCard.max == 0) {
      // It doesn't make sense to profile *out* a sub-extension in a complex extension since the sub-extension isn't
      // there to begin with, so just skip it.
      return;
    }

    if (field.effectiveIdentifier && field.effectiveIdentifier._namespace === 'unknown') {
      logger.error('Unable to establish namespace for %s. ERROR_CODE:13045', field.effectiveIdentifier._name);
      return;
    }

    const subExt = this.lookupExtension(field.effectiveIdentifier);

    const fieldBaseId = `${baseId}.extension:${common.shortID(field.effectiveIdentifier)}`;
    // By convention (for now) modifiers have the word "Modifier" in their name
    const isModifier = (/modifier/i).test(field.effectiveIdentifier.name);

    const definition = field.effectiveIdentifier.isPrimitive ? (def.description ? def.description.trim() : undefined) : subExt.description;

    const ssExt = common.cloneJSON(baseExt);
    delete(ssExt.slicing);
    MVH.deleteEdComment(extension, ssExt);
    delete(ssExt.requirements);
    delete(ssExt.alias);
    ssExt.id = `${fieldBaseId}`;
    ssExt.path = this.getExtensionPathFromExtensionID(fieldBaseId);
    ssExt[MVH.nameOfEdSliceName(extension)] = common.shortID(field.effectiveIdentifier);
    ssExt.short = subExt.short;
    ssExt.definition = definition;
    ssExt.min = field.effectiveCard.min;
    ssExt.max = field.effectiveCard.max === undefined ? '*' : field.effectiveCard.max.toString();
    ssExt.type = [MVH.convertType(extension, { code: 'Extension', profile: [subExt.url] })];
    ssExt.isModifier = isModifier || ssExt.isModifier != null ? isModifier : undefined;
    ssExt.isModifierReason = isModifier ? definition : undefined;
    if (definition == null || definition == '') {
      // definition is *required*, so put something there
      ssExt.definition = field.effectiveIdentifier.name;
      // isModifierReason is required (R4) is isModifier is set
      if (isModifier) {
        ssExt.isModifierReason = `${field.effectiveIdentifier.name} modifies the meaning of the thing to which it is applied`;
      }
    }
    if (this._target !== `FHIR_R4`) {
      delete ssExt.isModifierReason;
    }

    const dfExt = common.cloneJSON(ssExt);

    // Splice it into the right location in the Extension definition
    let i = extension.snapshot.element.findIndex(e => e == baseExt) + 1;
    for ( ; i < extension.snapshot.element.length && extension.snapshot.element[i].path.startsWith(baseExt.path); i++);
    extension.snapshot.element.splice(i, 0, ssExt);
    extension.differential.element.push(dfExt);
    this._profileExporter.applyConstraints(field, extension, ssExt, dfExt, true);

    const cp = this._specs.contentProfiles.findByIdentifier(def.identifier);
    if (cp != null) {
      const cpRules = cp.rules.filter(r => {
        if (r.path[0].isValueKeyWord) {
          // Check if the field is the value or an option of the value choice (if applicable)
          const options = def.value instanceof mdls.ChoiceValue ? def.value.aggregateOptions : [def.value];
          return options.some(opt => opt.effectiveIdentifier && opt.effectiveIdentifier.equals(field.effectiveIdentifier));
        } else if (field instanceof mdls.IdentifiableValue) {
          return r.path[0].equals(field.effectiveIdentifier);
        } // that's it; current code paths won't ever allow a choice value to get into this logic
      });
      cpRules.forEach(r => {
        if (r.path.length === 1) {
          if (r.mustSupport) {
            ssExt.mustSupport = dfExt.mustSupport = true;
          }
        } else {
          // Partial match: dive further into the element to get the full match.
          // Get the target element for the remaining identifier path
          const targetSS = this._profileExporter.getElementInExtension(r.path, extension, ssExt);
          if (targetSS) {
            if (r.mustSupport) {
              const targetDF = common.getDifferentialElementById(extension, targetSS.id, true);
              targetSS.mustSupport = targetDF.mustSupport = true;
            }
          } else {
            logger.error('Could not find FHIR element subextension for content profile rule with path %s.  ERROR_CODE:13065',
              r.path.map(p => p.name).join('.'));
          }
        }
      });
    }
  }

  getExtensionPathFromExtensionID(id) {
    // Changes a:x.b:y.c.d:z to a.b.c.d
    return id.split('.').map(p => p.split(':')[0]).join('.');
  }

  // value[x] doesn't support choices that have extensions as elements, so we need to check for that
  choiceSupportsValueX(choice) {
    // TODO: This assumes choice options don't have their own cardinality.  This isn't true in SHR today, but
    // we're restricting it in SHR in the future.  No use going through the trouble of supporting it if it's going away.
    for (const opt of choice.aggregateOptions) {
      if (opt instanceof mdls.TBD) {
        continue;
      } else if (opt instanceof mdls.IdentifiableValue) {
        if (!opt.effectiveIdentifier.isPrimitive) {
          const map = this._specs.maps.findByTargetAndIdentifier(this._target, opt.effectiveIdentifier);
          if (map === undefined) {
            return false;
          }
        }
      } else {
        logger.error('Unsupported value type: %s. ERROR_CODE:13053', opt.constructor.name);
        return false;
      }
    }

    return true;
  }

  // NOTE: Type conversion will be done by the caller
  getTypeFromValue(value, originalTypes) {
    if (value && value instanceof mdls.IdentifiableValue) {
      if (value.effectiveIdentifier.isPrimitive) {
        let type = value.effectiveIdentifier.name;
        if (type === 'concept') {
          type = 'CodeableConcept';
        } else if (type === 'xhtml') {
          // xhtml is a weird type in FHIR and should be treated like a string instead
          type = 'string';
        }
        return { code: type };
      } else {
        const def = this._specs.dataElements.findByIdentifier(value.effectiveIdentifier);
        const [type, value2] = this.getSimpleTypeAndValue(originalTypes.map(t => t.code), def, value);
        if (value2 == null) {
          logger.error('Couldn\'t identify appropriate Extension.value[x] value for %s. Is it an attempt to reference a non-Entry?', value.effectiveIdentifier);
          return;
        }
        const map = this._specs.maps.findByTargetAndIdentifier(this._target, value2.effectiveIdentifier);
        if (map === undefined) {
          return;
        }
        const code = type;
        const profile = this._profileExporter.lookupProfile(map.identifier, true, true);
        if (code == 'Reference') {
          return { code: code, targetProfile: [profile.url] };
        } else if (common.isCustomProfile(profile) || profile.id !== type) {
          return { code: code, profile: [profile.url] };
        }
        return { code };
      }
    }
  }

  getTextDiv(identifier) {
    const def = this._specs.dataElements.findByIdentifier(identifier);
    let description;
    if (def && def.description) {
      description = def.description.trim();
    }
    return `<div xmlns="http://www.w3.org/1999/xhtml">
  <p><b>${common.escapeHTML(identifier.name)} Extension</b></p>
  <p>${common.escapeHTML(description)}</p>
</div>`;
  }
}

module.exports = {ExtensionExporter, setLogger};