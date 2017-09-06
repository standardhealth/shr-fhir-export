const bunyan = require('bunyan');
const mdls = require('shr-models');
const load = require('./load');
const common = require('./common');
const {CodeSystemExporter} = require('./codeSystems');
const {ValueSetExporter} = require('./valueSets');
const {ExtensionExporter} = require('./extensions');
const {exportIG} = require('./ig');

const TARGET = 'FHIR_STU_3';
const ENTRY_ID = new mdls.Identifier('shr.base', 'Entry');

// The following two constants toggle advanced developer features, usually not needed
// or wanted (since they cause performance degradation).
const TRACK_UNMAPPED_PATHS = false;
const REPORT_PROFILE_INDICATORS = false;

var rootLogger = bunyan.createLogger({name: 'shr-fhir-export'});
var logger = rootLogger;
function setLogger(bunyanLogger) {
  rootLogger = logger = bunyanLogger;
  require('./extensions.js').setLogger(logger);
}

const allowedConversions = {
  'boolean': ['code'],
  'dateTime': ['date', 'instant'],
  'shr.core.CodeableConcept': ['code']
};

function exportToFHIR(specifications) {
  const exporter = new FHIRExporter(specifications);
  return exporter.export();
}

class FHIRExporter {
  constructor(specifications) {
    this._specs = specifications;
    this._fhir = load(TARGET);
    this._codeSystemExporter = new CodeSystemExporter(this._specs, this._fhir);
    this._valueSetExporter = new ValueSetExporter(this._specs, this._fhir);
    this._extensionExporter = new ExtensionExporter(this, this._specs, this._fhir, TARGET);
    this._profiles = [];
    if (REPORT_PROFILE_INDICATORS) {
      this._profileIndicators = new Map();
    }
    if (TRACK_UNMAPPED_PATHS) {
      this._unmappedPaths = new Map();
    }
  }

  export() {
    this._codeSystemExporter.export();
    this._valueSetExporter.export();
    // Prime the extension exporter with primitive value extensions
    for (const p of mdls.PRIMITIVES) {
      this._extensionExporter.lookupExtension(new mdls.PrimitiveIdentifier(p));
    }
    // Create mappings to Basic for all unmapped entries
    for (const entry of this._specs.dataElements.entries) {
      const map = this._specs.maps.findByTargetAndIdentifier(TARGET, entry.identifier);
      if (typeof map === 'undefined') {
        this._specs.maps.add(new mdls.ElementMapping(entry.identifier, TARGET, 'Basic'));
      }
    }
    // Iterate through the elements and do the mappings
    for (const element of this._specs.dataElements.all) {
      const map = this._specs.maps.findByTargetAndIdentifier(TARGET, element.identifier);
      if (typeof map === 'undefined') {
        continue;
      } else if (typeof this.lookupProfile(map.identifier, false) !== 'undefined') {
        continue;
      }
      this.mappingToProfile(map);
    }

    if (TRACK_UNMAPPED_PATHS) {
      // Log out the unmapped paths
      // First build a reverse map where the unmapped fields are the key.  This allows us to consolidate
      // all the unmapped fields that probably derive from the same baseclass.
      const reverseMap = new Map();
      for (const [key, value] of this._unmappedPaths) {
        const text = unmappedPathTreeAsText(value);
        if (text === '') {
          continue;
        } else if (!reverseMap.has(text)) {
          reverseMap.set(text, []);
        }
        reverseMap.get(text).push(key);
      }
      for (const [text, elements] of reverseMap) {
        logger.info('Unmapped fields in [ %s ]:\n%s', elements.join(', '), text);
      }
    }

    if (REPORT_PROFILE_INDICATORS) {
      // A file showing profiles that have fixed values -- useful for trying to guess the profile, as in the FHIR Scorecard.
      const indicatorJSON = {};
      for (const [, p] of this._profileIndicators) {
        if (p.hasFixedValues) {
          indicatorJSON[p.profileURL] = p.toJSON();
        }
      }
      logger.info('Profile Indicators JSON:', JSON.stringify(indicatorJSON, null, 2));
    }

    return {
      profiles: this._profiles,
      extensions: this._extensionExporter.extensions,
      valueSets: this._valueSetExporter.valueSets,
      codeSystems: this._codeSystemExporter.codeSystems,
    };
  }

  mappingToProfile(map) {
    // Setup a child logger to associate logs with the current map
    const lastLogger = logger;
    logger = rootLogger.child({ shrId: map.identifier.fqn, target: map.targetItem });
    logger.debug('Start mapping element');
    try {
      // We need to enhance the map so some implicit things are made explicit for easier processing
      const originalMap = map;
      map = this.enhanceMap(map);

      const profileID = common.fhirID(map.identifier);
      const profileURL = common.fhirURL(map.identifier);
      if (REPORT_PROFILE_INDICATORS) {
        this._profileIndicators.set(profileID, new ProfileIndicators(profileURL, map.targetItem));
      }

      const def = this._fhir.find(map.targetItem);
      if (typeof def === 'undefined') {
        logger.error('Invalid FHIR target: %s', map.targetItem);
        return;
      }
      const profile = common.cloneJSON(def);
      delete(profile.meta);
      delete(profile.extension);
      profile.id = profileID;
      profile.text = this.getText(originalMap);
      profile.url = profileURL;
      profile.identifier = [{ system: 'http://standardhealthrecord.org', value: map.identifier.fqn }],
      profile.name = `SHR ${map.identifier.name} Profile`;
      profile.description = this.getDescription(map.identifier);
      profile.publisher = 'The MITRE Corporation: Standard Health Record Collaborative';
      profile.contact = [{
        telecom: [{
          system: 'url',
          value: 'http://www.standardhealthrecord.org'
        }]
      }];
      profile.date = new Date().toISOString(),
      profile.baseDefinition = def.url;
      profile.derivation = 'constraint';
      for (const ssEl of profile.snapshot.element) {
        ssEl.id = ssEl.id.replace(new RegExp(`^${map.targetItem}`), `${map.targetItem}:${profileID}`);
      }
      const rootSS = profile.snapshot.element[0];
      rootSS.short = profile.name;
      rootSS.definition = this.getDescription(map.identifier, rootSS.definition);
      profile.differential = { element: [{
        id : rootSS.id,
        path : rootSS.path,
        short : rootSS.short,
        definition : rootSS.definition,
        mustSupport : rootSS.mustSupport,
        isModifier : rootSS.isModifier,
        isSummary : rootSS.isSummary
      }] };
      if (TRACK_UNMAPPED_PATHS) {
        this._unmappedPaths.set(map.identifier.fqn, this.buildUnmappedPathsTree(map.identifier));
      }
      this.processMappingRules(map, profile);
      this.addExtensions(map, profile);
      if (map.targetItem == 'Basic') {
        this.setCodeOnBasic(map, profile);
      }

      // When SHR specifies a choice value, remove the others!
      for (const el of profile.snapshot.element) {
        if (el.path.endsWith('[x]') || (el.type && el.type.length > 1)) {
          const shrSelected = el.type.filter(t => t._shrSelected).map(t => {
            delete(t._shrSelected); // Remove the special marker
            return t;
          });
          if (shrSelected.length > 0 && shrSelected.length < el.type.length) {
            el.type = shrSelected;
            // Do it in differential too
            let df = common.getDifferentialElementById(profile, el.id);
            if (typeof df === 'undefined') {
              df = { id: el.id, path: el.path };
              profile.differential.element.push(df);
            }
            df.type = el.type;
          }
        }
      }

      // If there are extensions, update the base extension element(s)
      for (const extType of ['extension', 'modifierExtension']) {
        if (profile.differential.element.filter(e => e.path == `${profile.type}.${extType}`).length > 0) {
          // Apparently we only need to modify the snapshot (based on published IGs and examples)
          const ssEl = common.getSnapshotElement(profile, extType);
          common.addSlicingToBaseElement(ssEl, null, 'value', 'url');
        }
      }

      // Sort the differentials to be in the same order as the snapshots
      profile.differential.element.sort((a, b) => {
        const aI = profile.snapshot.element.findIndex(e => e.id == a.id);
        const bI = profile.snapshot.element.findIndex(e => e.id == b.id);
        return aI - bI;
      });

      // Add missing intermediate paths (needed by the IG Publisher)
      const fixedDifferentials = [];
      let lastIdParts = [];
      for (const dfEl of profile.differential.element) {
        const idParts = dfEl.id.split('.');
        for (let i=0; i < (idParts.length - 1); i++) {
          if (lastIdParts.length <= i || lastIdParts[i] != idParts[i]) {
            // This is a missing path that must be added
            fixedDifferentials.push({
              id: idParts.slice(0, i+1).join('.'),
              path: dfEl.path.split('.').slice(0, i+1).join('.')
            });
            lastIdParts = idParts.slice(0, i+1);
          }
        }
        fixedDifferentials.push(dfEl);
        lastIdParts = idParts;
      }
      profile.differential.element = fixedDifferentials;

      // Perform additional QA
      this.additionalQA(profile);

      this._profiles.push(profile);
      return profile;
    } finally {
      // Close out the logging for this mapping
      logger.debug('Done mapping element');
      logger = lastLogger;
    }
  }

  // NOTE: This function only called if TRACK_UNMAPPED_PATHS is set to true
  buildUnmappedPathsTree(identifier, lineage = new Map()) {
    const tree = new Map();
    lineage.set(identifier.fqn, true);
    const def = this._specs.dataElements.findByIdentifier(identifier);
    for (const field of common.valueAndFields(def)) {
      if (field.identifier && field.identifier._namespace === 'unknown') {
        continue;
      }
      this.addFieldToUnmappedPathsTree(field, tree, lineage);
    }
    return tree;
  }

  // NOTE: This function only called if TRACK_UNMAPPED_PATHS is set to true
  addFieldToUnmappedPathsTree(field, tree, lineage) {
    if (field instanceof mdls.IdentifiableValue) {
      if (field.identifier instanceof mdls.TBD) {
        return;
      } else if (field.identifier.isPrimitive) {
        tree.set(field.identifier.fqn, true);
      } else if (lineage.has(field.identifier.fqn)) {
        // escape infinite recursion by not drilling deeper
        tree.set(field.identifier.fqn, true);
      } else {
        tree.set(field.identifier.fqn, this.buildUnmappedPathsTree(field.identifier, new Map(lineage)));
      }
    } else if (field instanceof mdls.ChoiceValue) {
      for (const opt of field.aggregateOptions) {
        this.addFieldToUnmappedPathsTree(opt, tree, lineage);
      }
    }
  }

  // NOTE: This function only called if TRACK_UNMAPPED_PATHS is set to true
  removeMappedPath(def, sourcePath) {
    let map = this._unmappedPaths.get(def.identifier.fqn);
    for (let i=0; i < sourcePath.length; i++) {
      const p = sourcePath[i];
      // For now, don't deal with Entry.*
      if (p.name === 'Entry') {
        return;
      } else if (i == sourcePath.length-1) {
        map.set('_has_mapped_children', true);
        map.delete(p.fqn);
      } else {
        map.set('_has_mapped_children', true);
        map = map.get(p.fqn);
      }
      if (typeof map === 'undefined' || !(map instanceof Map)) {
        // TODO: To avoid infinite recursion, recursive elements get mapped to true instead of another Map.
        // This means we can't really track the mapping deeper than that.  One example: Observation.Components.Observation.ObservationTypeCode
        //logger.error('Cannot flag path as mapped');
        return;
      }
    }
  }

  getText(map) {
    return {
      status: 'generated',
      div:
`<div xmlns="http://www.w3.org/1999/xhtml">
  <p><b>SHR ${common.escapeHTML(map.identifier.name)} Profile</b></p>
  <p>${common.escapeHTML(this.getDescription(map.identifier))}</p>
  <p><b>SHR Mapping Summary</b></p>
  <p><pre>${common.escapeHTML(mappingAsText(map, true))}</pre></p>
</div>`
    };
  }

  getDescription(identifier, defaultText) {
    const def = this._specs.dataElements.findByIdentifier(identifier);
    let description;
    if (def) {
      description = def.description;
    }
    if (defaultText && (typeof description === 'undefined' || description == null || description == '')) {
      description = defaultText;
    }
    return description;
  }

  setCodeOnBasic(map, profile) {
    const ssEl = common.getSnapshotElement(profile, 'code');
    if (typeof ssEl.fixedCodeableConcept === 'undefined' && typeof ssEl.patternCodeableConcept === 'undefined') {
      const dfEl = common.getSnapshotElement(profile, 'code');
      ssEl.patternCodeableConcept = dfEl.patternCodeableConcept = {
        coding: [ { system: 'http://standardhealthrecord.org/fhir/basic-resource-type', code: profile.id }]
      };
      if (REPORT_PROFILE_INDICATORS) {
        this.addFixedValueIndicator(profile, ssEl.path, ssEl.patternCodeableConcept);
      }
    }
  }

  enhanceMap(map) {
    // We're going to mess with things, so let's just clone the mapping now!
    map = map.clone();

    // Some mapping rules indicate to slice using an "includes" strategy.  This means to slice on the
    // IncludesTypeConstraints.  To implement this, we expand the one mapping rule to many (one per IncludesType).
    // In the new rules, the original identifier is replaced by the IncludesType identifier.  For example, given:
    //   PanelMembers.Observation maps to related.target (slice at = related; slice on = target.reference.resolve(); slice on type = profile; slice strategy = includes)
    // This will become:
    //   PanelMembers.Observation maps to related.target
    //   PanelMembers.BRCA1Variant maps to related.target (slice at = related; slice on = target.reference.resolve(); slice on type = profile)
    //   PanelMembers.BRCA2Variant maps to related.target (slice at = related; slice on = target.reference.resolve(); slice on type = profile)
    // The other code in the exporter has also been modified to be able to resolve this type of path.
    // NOTE: You can't use this path notation (replacing original identifier with includestype) in the mapping file
    // itself, as shr-expand doesn't know how to deal with it.  This is why we do it automagically here instead.
    // In the future we should determine what is the approved way to reference an includetype in a path.
    // The following block of code does the expansion as noted above:
    const newRules = [];
    const def = this._specs.dataElements.findByIdentifier(map.identifier);
    for (const rule of map.rules) {
      newRules.push(rule);
      if (!(rule instanceof mdls.FieldMappingRule)) {
        continue;
      }
      const t = FieldTarget.parse(rule.target);
      // We only care about expanding rules using the "includes" strategy
      if (t.hasSliceStrategyCommand() && t.findSliceStrategyCommand().value == 'includes') {
        if (typeof def === 'undefined') {
          continue;
        }
        // NOTE: This code only supports cases where the includesTypes is at the tail of a path.  Supporting other
        // cases gets quite tricky and should only be attempted when a use case arises.
        const sourceValue = this.findValueByPath(rule.sourcePath, def);
        if (typeof sourceValue === 'undefined' || typeof def === 'undefined') {
          continue;
        }
        const includes = sourceValue.constraintsFilter.includesType.constraints;
        if (includes.length > 0) {
          // We'll keep track of the lower cardinalities so we can update the containing array's cardinality as
          // necessary.  For example, if PanelMembers.Observations includes 1..1 BRAC1Variant and 1..1 BRAC2Variant,
          // then we know the array it maps two must have at least a lower cardinality of 2 (1 + 1 = 2).
          let minCard = 0;
          const includesTypeRules = [];
          for (const incl of includes) {
            if (incl.path.length > 0) {
              logger.error('Splicing on include type constraints with paths is not supported');
              continue;
            }
            // Substitute the original identifier in the path with the includesType identifier instead
            const newSourcePath = rule.sourcePath.slice();
            newSourcePath[newSourcePath.length-1] = incl.isA;
            if (incl.card && incl.card.min) {
              minCard += incl.card.min;
            }
            // Create and store a new rule, but remove "slice strategy" from the commands since it only applies to parent
            includesTypeRules.push(new mdls.FieldMappingRule(newSourcePath, new FieldTarget(t.target, t.commands.filter(c => c.key != 'slice strategy')).toRuleTarget()));
          }
          // When we slice on something that has IncludesType constraints, the intention is not to make the base
          // type a slice.  Only the includes types should be slices.  So, *remove* the slice commands from the base.
          newRules[newRules.length-1] = new mdls.FieldMappingRule(rule.sourcePath, t.target);
          // Now we modify the cardinality of what we're slicing (if necessary) to ensure the slices all fit
          if (minCard > 0) {
            let cardTarget = t.target;
            // If we said to slice *at* a different level than the target, then that's where the card should be applied
            if (t.hasSliceAtCommand()) {
              cardTarget = t.findSliceAtCommand().value;
            }
            // Now we need to find the original cardinality in the FHIR definition so we can modify as appropriate
            const fhirDef = this._fhir.find(map.targetItem);
            const ss = common.getSnapshotElement(fhirDef, cardTarget);
            let fhirCard = getFHIRElementCardinality(ss);
            if (fhirCard.min < minCard) {
              // Insert the new CardinalityMappingRule above the base rule so it is applied first
              newRules.splice(newRules.length-1, 0, new mdls.CardinalityMappingRule(cardTarget, new mdls.Cardinality(minCard, fhirCard.max)));
            }
          }
          // Now add the new rules we just created based on the includes types!
          newRules.push(...includesTypeRules);
        } else {
          // The strategy says to slice on includes, but there are none, so modify the rule to remove slicing commands.
          // We don't want to slice on something that has no slices defined!
          newRules[newRules.length-1] = new mdls.FieldMappingRule(rule.sourcePath, t.target);
        }
      }
    }
    map.rules = newRules;

    const sliceOnMap = new Map();
    const sliceAtMap = new Map();
    const sliceTargetStack = new Stack();
    const sliceNameStack = new Stack();
    let i=0;
    for (const rule of map.rules) {
      rule._i = i++; // Helps maintain original order of "equivalent" rules when sorting
      if (!(rule instanceof mdls.FieldMappingRule)) {
        continue;
      }
      const t = FieldTarget.parse(rule.target);
      while (!sliceTargetStack.isEmpty() && !t.target.startsWith(sliceTargetStack.peekLast())) {
        sliceTargetStack.pop();
        sliceNameStack.pop();
      }

      if (t.hasSliceOnCommand()) {
        // Start a new slice group (or continue if it's the same as the last slice group)
        const sliceOn = t.findSliceOnCommand().value;
        sliceOnMap.set(t.target, sliceOn);
        if (t.hasSliceAtCommand()) {
          const sliceAt = t.findSliceAtCommand().value;
          sliceAtMap.set(t.target, sliceAt);
        }
        if (t.target != sliceTargetStack.peekLast()) {
          sliceTargetStack.push(t.target);
        } else {
          // Since we're in the same slice group, pop the last slice name to make room for the next
          sliceNameStack.pop();
        }

        // Start a new slice!
        const sliceName = common.fhirID(rule.sourcePath[rule.sourcePath.length-1]);
        t.addInSliceCommand(`${sliceTargetStack.peekLast()}[${sliceName}]`);
        sliceNameStack.push(sliceName);
      } else if (!sliceTargetStack.isEmpty() && t.target == sliceTargetStack.peekLast()) {
        // Associate with current slice group
        t.addSliceOnCommand(sliceOnMap.get(t.target));

        // Add slice at if applicable
        if (sliceAtMap.has(t.target)) {
          t.addSliceAtCommand(sliceAtMap.get(t.target));
        }

        // Start a new slice in the slice group!
        const sliceName = common.fhirID(rule.sourcePath[rule.sourcePath.length-1]);
        t.addInSliceCommand(`${sliceTargetStack.peekLast()}[${sliceName}]`);
        sliceNameStack.pop();
        sliceNameStack.push(sliceName);
      } else if (!sliceTargetStack.isEmpty() && t.target.startsWith(sliceTargetStack.peekLast())) {
        // Put it in the slice
        t.addInSliceCommand(`${sliceTargetStack.peekLast()}[${sliceNameStack.peekLast()}]`);
      }
      rule._target = t.toRuleTarget(); // BAD BAD BAD
    }

    // We want to process the rules by order of their targets to ensure parent targets are processed before children.
    // This is because it will make a difference when determining aggregate cardinalities.
    map.rules.sort((a, b) => {
      // First sort such that FieldMappingRules always go last.  This way any FixedValueMappingRules or
      // CardinalityMappingRules will be applied before the FieldMappingRules might duplicate things into slices.
      const aIsFieldMappingRule = a instanceof mdls.FieldMappingRule;
      const bIsFieldMappingRule = b instanceof mdls.FieldMappingRule;
      if (aIsFieldMappingRule && !bIsFieldMappingRule) {
        return 1;
      } else if (bIsFieldMappingRule && !aIsFieldMappingRule) {
        return -1;
      }
      const aTarget = FieldTarget.parse(a.target).target;
      const bTarget = FieldTarget.parse(b.target).target;
      if (aTarget < bTarget) {
        return -1;
      } else if (aTarget > bTarget) {
        return 1;
      } else if (a._i < b._i) {
        return -1;
      }
      // We know a._i and b._i can't be equal, so b goes before a
      return 1;
    });

    return map;
  }

  processMappingRules(map, profile) {
    // First, try to detect elements that need to be sliced
    this.detectElementsNeedingSlices(map, profile);

    // Now process the rules
    for (const rule of map.rules) {
      // Setup a child logger to associate logs with the current map
      const lastLogger = logger;
      logger = logger.child({ mappingRule: rule.toString() });
      logger.debug('Start mapping rule');
      try {
        if (rule instanceof mdls.CardinalityMappingRule) {
          this.processCardinalityMappingRule(map, rule, profile);
        } else if (rule instanceof mdls.FixedValueMappingRule) {
          this.processFixedValueMappingRule(map, rule, profile);
        } else if (rule.sourcePath.some(p => p instanceof mdls.TBD)) {
          continue;
        } else if (rule instanceof mdls.FieldMappingRule) {
          if (rule.target.startsWith('http://') || rule.target.startsWith('https://')) {
            this.processFieldToURLMappingRule(map, rule, profile);
          } else {
            this.processFieldToFieldMappingRule(map, rule, profile);
          }
        }
      } finally {
        logger.debug('Done mapping rule');
        logger = lastLogger;
      }
    }
  }

  detectElementsNeedingSlices(map, profile) {
    // TODO: Find elements that have includesType but are not sliced?  Maybe a rainy day activity.
    // Note -- this function should only be called after the map has been "enhanced"
    const unslicedMap = new Map();
    for (const rule of map.rulesFilter.field.rules) {
      const t = FieldTarget.parse(rule.target);
      if (!t.hasInSliceCommand()) {
        const count = unslicedMap.has(t.target) ? unslicedMap.get(t.target) + 1 : 1;
        unslicedMap.set(t.target, count);
      }
    }
    const targets = Array.from(unslicedMap.keys()).filter(k => unslicedMap.get(k) > 1);
    for (const t of targets) {
      const isRepeatedRoot = targets.every(other => t == other || !t.startsWith(other));
      if (isRepeatedRoot) {
        // The root is repeated, so may require slicing, but first check if it might map cleanly into the target types
        const numMappings = unslicedMap.get(t);
        const ssEl = this.getSnapshotElementForFieldTarget(profile, FieldTarget.parse(t));
        if (typeof ssEl !== 'undefined' && (typeof ssEl.type === 'undefined' || ssEl.type.length < numMappings)) {
          // The target either has no types or fewer types than defined mapping rules, so it must be sliced
          logger.error('Slicing required to disambiguate multiple mappings to %s', t);
        }
      }
    }
  }

  processFieldToURLMappingRule(map, rule, profile) {
    const def = this._specs.dataElements.findByIdentifier(map.identifier);
    if (rule.sourcePath.length > 1) {
      // TODO: If part of the sourcepath points to a BackboneElement, should we put the extension there?  How does that
      // affect cardinality? Do we need a way in the mapping grammar to place extensions at certain points?
      logger.info('Deep path mapped to extension, but extension placed at root level.');
    }
    if (TRACK_UNMAPPED_PATHS) {
      this.removeMappedPath(def, rule.sourcePath);
    }
    this.addExtension(def, profile, rule.sourcePath, rule.target);
  }

  processFieldToFieldMappingRule(map, rule, profile) {
    const def = this._specs.dataElements.findByIdentifier(map.identifier);
    if (typeof def === 'undefined') {
      logger.error('Invalid source path');
      return;
    }

    const sourceValue = this.findValueByPath(rule.sourcePath, def);
    if (typeof sourceValue === 'undefined') {
      // This only happens in cases where a base class defined a mapping, but the subclass
      // constrained out that path so it no longer exists.  So... we can safely ignore it!
      return;
    }

    // If this sourceValue came from an includesType, and there was a "slice at" command,
    // then the includeType cardinality needs to be set at the base of the slice.
    const t = FieldTarget.parse(rule.target);
    let sliceAtCard;
    if (sourceValue._derivedFromIncludesTypeConstraint && t.hasSliceAtCommand()) {
      sliceAtCard = sourceValue.card;
    }

    const ss = this.getSnapshotElementForFieldTarget(profile, FieldTarget.parse(rule.target), sliceAtCard);
    if (typeof ss === 'undefined') {
      logger.error('Invalid or unsupported target path');
      return;
    }

    let df = common.getDifferentialElementById(profile, ss.id);
    const dfIsNew = (typeof df === 'undefined');
    if (dfIsNew) {
      df = {
        id: ss.id,
        path: ss.path
      };
    }

    if (typeof ss.type === 'undefined' && typeof ss.contentReference !== 'undefined') {
      // To profile a content reference, we must unroll it (see https://chat.fhir.org/#narrow/stream/implementers/topic/Profiling.20a.20contentReference)
      this.unrollContentReference(profile, ss);
    }

    if (typeof sliceAtCard === 'undefined') {
      this.processFieldToFieldCardinality(map, rule, profile, ss, df);
    }
    this.processFieldToFieldType(map, def, rule, profile, ss, df);

    if (dfIsNew && Object.keys(df).length > 2) {
      profile.differential.element.push(df);
    }
  }

  unrollContentReference(profile, snapshotEl) {
    if (!snapshotEl.contentReference.startsWith('#')) {
      logger.error('Cannot unroll contentReference %s on %s because it is not a local reference', snapshotEl.contentReference, snapshotEl.id);
      return;
    }

    // Need to use the base resource to unroll the contentref, in case it points to something already profiled by us.
    // We wouldn't want to carry over the constraints from the profiled item.
    const def = this._fhir.find(profile.type);

    // Find all the elements we need to unroll from the content reference
    const unrolled = [];
    const crPath = snapshotEl.contentReference.slice(1);
    let rootId;
    for (const ss of def.snapshot.element) {
      if (ss.path.startsWith(crPath)) {
        if (typeof rootId === 'undefined') {
          // This is the "root" element where the contentReference is.  Replace the definitions in place as necessary.
          rootId = ss.id;
          delete(snapshotEl.contentReference);
          snapshotEl.type = ss.type;
          snapshotEl.defaultValue = ss.defaultValue;
          snapshotEl.fixed = ss.fixed;
          snapshotEl.pattern = ss.pattern;
          snapshotEl.example = ss.example;
          snapshotEl.minValue = ss.minValue;
          snapshotEl.maxValue = ss.maxValue;
          snapshotEl.maxLength = ss.maxLength;
          snapshotEl.binding = ss.binding;
          continue;
        }
        const urSS = common.cloneJSON(ss);
        urSS.id = `${snapshotEl.id}${urSS.id.slice(rootId.length)}`;
        urSS.path = `${snapshotEl.path}${urSS.path.slice(crPath.length)}`;
        unrolled.push(urSS);
      }
    }

    if (typeof rootId === 'undefined') {
      // We didn't find the content reference
      logger.error('Invalid content reference on %s: %s', snapshotEl.id, snapshotEl.contentReference);
      return;
    }

    // If the thing we unrolled has children, then we need to insert them into the snapshot
    if (unrolled.length > 0) {
      let start = profile.snapshot.element.findIndex(e => e.id == snapshotEl.id) + 1;
      profile.snapshot.element.splice(start, 0, ...unrolled);
    }
  }

  unrollElement(identifier, profile, snapshotEl) {
    if (snapshotEl.path.endsWith('[x]')) {
      logger.error('Cannot unroll %s. Create an explicit choice element first.', snapshotEl.id);
      return;
    }

    let sdToUnroll;
    if (identifier instanceof mdls.Identifier) {
      if (snapshotEl.type.length == 1 && snapshotEl.type[0].code == 'Extension') {
        // Lookup the extension
        sdToUnroll = this._extensionExporter.lookupExtension(identifier);
      } else {
        // Look up the profile
        sdToUnroll = this.lookupProfile(identifier);
        if (typeof sdToUnroll === 'undefined') {
          logger.error('Cannot unroll %s at %s: invalid SHR element.', identifier.fqn, snapshotEl.id);
          return;
        }
      }
    } else {
      sdToUnroll = this.lookupStructureDefinition(identifier);
    }

    // Find all the elements we need to unroll
    const unrolled = [];
    let [baseId, basePath] = [snapshotEl.id, snapshotEl.path];
    const baseEl = sdToUnroll.snapshot.element[0];
    // Skip the base, since we really only want to unroll the children (the base is already represented)
    for (let i=1; i < sdToUnroll.snapshot.element.length; i++) {
      const ss = common.cloneJSON(sdToUnroll.snapshot.element[i]);
      ss.id = `${baseId}${ss.id.slice(baseEl.id.length)}`;
      ss.path = `${basePath}${ss.path.slice(baseEl.path.length)}`;
      // Only unroll this element if it's not unrolled already -- this check may not actually be necessary
      if (!profile.snapshot.element.some(e => e.id == ss.id)) {
        unrolled.push(ss);
      }
    }

    // Insert the unrolled elements into the snapshot
    const ssList = profile.snapshot.element;
    const unrolledIdx = ssList.findIndex(e => e.id == snapshotEl.id);
    profile.snapshot.element = [...ssList.slice(0, unrolledIdx + 1), ...unrolled, ...ssList.slice(unrolledIdx + 1)];
  }

  addExplicitChoiceElement(sourceIdentifier, profile, snapshotEl, differentialEl) {
    if (!snapshotEl.path.endsWith('[x]')) {
      logger.error('Cannot make choice element explicit since it is not a choice ([x]): %s', snapshotEl.id);
      return;
    }
    let sdToAdd;
    if (snapshotEl.type.length == 1 && snapshotEl.type[0].code == 'Extension') {
      // Lookup the extension
      sdToAdd = this._extensionExporter.lookupExtension(sourceIdentifier);
    } else {
      // Look up the profile (TODO: Support for primitives?)
      sdToAdd = this.lookupProfile(sourceIdentifier);
      if (typeof sdToAdd === 'undefined') {
        logger.error('Cannot make choice element explicit at %s. Invalid SHR identifier: %s.', snapshotEl.id, sourceIdentifier.fqn);
        return;
      }
    }

    // Check to be sure we don't already have one
    const baseId = `${snapshotEl.id.replace('[x]', sdToAdd.type)}:${common.fhirID(sourceIdentifier)}`;
    const existing = profile.snapshot.element.find(e => e.id == baseId);
    if (existing) {
      return existing;
    }

    // Slice the choice and add an explicit reference (e.g. value[x] --> valueCodeableConcept)
    // See: https://chat.fhir.org/#narrow/stream/implementers/subject/StructureDefinition.20with.20slice.20on.20choice)
    common.addSlicingToBaseElement(snapshotEl, differentialEl, 'type', '$this');

    // Build the new choice element
    const choiceEl = {
      id: baseId,
      path: snapshotEl.path.replace('[x]', sdToAdd.type),
      sliceName: common.fhirID(sourceIdentifier),
      short: snapshotEl.short,
      definition: snapshotEl.definition,
      min: snapshotEl.min,
      max: snapshotEl.max,
      type: [{ code: sdToAdd.type, profile: sdToAdd.url }],
      isSummary: snapshotEl.isSummary
    };

    // Insert the explicit element into the snapshot
    let start = profile.snapshot.element.findIndex(e => e.id == snapshotEl.id) + 1;
    profile.snapshot.element.splice(start, 0, choiceEl);

    return choiceEl;
  }

  processCardinalityMappingRule(map, rule, profile) {
    const target = FieldTarget.parse(rule.target).target;

    const ss = common.getSnapshotElement(profile, target);
    if (typeof ss === 'undefined') {
      logger.error('Invalid target path. Cannot apply cardinality constraint.');
      return;
    }

    let df = common.getDifferentialElementById(profile, ss.id);
    const dfIsNew = (typeof df === 'undefined');
    if (dfIsNew) {
      df = {
        id: ss.id,
        path: ss.path
      };
    }

    const targetCard = getFHIRElementCardinality(ss);
    if (rule.cardinality.fitsWithinCardinalityOf(targetCard)) {
      setCardinalityOnFHIRElements(rule.cardinality, ss, df);
    } else {
      logger.error('Cannot constrain cardinality from %s to %s', targetCard, rule.cardinality.toString());
    }

    if (dfIsNew && Object.keys(df).length > 2) {
      profile.differential.element.push(df);
    }
  }

  processFixedValueMappingRule(map, rule, profile) {
    const target = FieldTarget.parse(rule.target).target;
    const fixedValue = rule.value;

    const ss = common.getSnapshotElement(profile, target);
    if (typeof ss === 'undefined') {
      logger.error('Invalid target path. Cannot apply fixed value.');
      return;
    }

    let df = common.getDifferentialElementById(profile, ss.id);
    const dfIsNew = (typeof df === 'undefined');
    if (dfIsNew) {
      df = {
        id: ss.id,
        path: ss.path
      };
    }

    // this.fixCodeOnElement(sourceValue.identifier.fqn, profile, sliceSnapshotEl, sliceDifferentialEl, code, false);
    if (fixedValue.indexOf('#') != -1) {
      let type = ss.type.find(t => t.code == 'code' || t.code == 'Coding' || t.code == 'CodeableConcept');
      if (typeof type != 'undefined') {
        const parts = fixedValue.split('#', 2);
        this.fixCodeOnElement(type.code, profile, ss, df, new mdls.Concept(parts[0], parts[1]), true);
        if (dfIsNew && Object.keys(df).length > 2) {
          profile.differential.element.push(df);
        }
        return;
      }
    }

    // If we got this far, it's a currently unsupported use case
    logger.error('Currently, only fixing codes is supported (value must contain "#").  Unable to fix to %s.', fixedValue);
  }

  processFieldToFieldCardinality(map, rule, profile, snapshotEl, differentialEl) {
    // First handle cardinality.  Problems can arise when the target path is deeper than one because cardinalities
    // aggregate to get to the final (target) cardinality on the leaf of the path.  Unless there are mappings for
    // all of the intermediate paths, the correct way to constrain the cardinality is ambiguous.
    // (e.g., if Foo[0..4] maps to a[0..*].b[0..*], there are multiple ways to get a.b to have cardinality 0..4:
    // a[0..1].b[0..4], a[0..1].b[1..4], a[1..1].b[0..4], a[0..4].b[0..1], a[0..4].b[1..1], a[1..4].b[0..1].
    // For this reason, ambiguous cardinalities in intermediate paths must be explicitly declared in the mapping file.
    const aggSourceCard = this.getAggregateEffectiveCardinality(map.identifier, rule.sourcePath);
    const targetID = snapshotEl.id;
    const targetCard = getFHIRElementCardinality(snapshotEl);

    // If the target ID represents a single element ("Resource.element"), just apply the cardinality to the target
    if (targetID.indexOf('.') == targetID.lastIndexOf('.')) {
      // Easiest case: Apply the source aggregate cardinality to the single target
      if (aggSourceCard.fitsWithinCardinalityOf(targetCard)) {
        setCardinalityOnFHIRElements(aggSourceCard, snapshotEl, differentialEl);
      } else {
        logger.error('Incompatible cardinality (using aggregation). Source cardinality %s does not fit in target cardinality %s.', aggSourceCard.toString(), targetCard);
        return;
      }
    } else {
      const aggTargetCard = getAggregateFHIRElementCardinality(profile, snapshotEl);
      if (aggSourceCard.equals(aggTargetCard)) {
        // For now we let it pass, but should we be checking to ensure all intermediate paths on target have profiled cardinality?
      } else if (aggSourceCard.fitsWithinCardinalityOf(aggTargetCard)) {
        // Check if all parts of target path are mapped.  If they aren't, then constraining the cardinality is ambiguous
        const targetPath = FieldTarget.parse(rule.target).target.split('.');
        let isMatch = true;
        for (let i=0; i < targetPath.length; i++) {
          const tp = targetPath.slice(0, i+1).join('.');
          if (tp.endsWith('[x]')) {
            // Due to our target path syntax, this looks like an intermediate path, but it isn't really
            continue;
          } else if (!map.rules.some(r => typeof r.target !== 'undefined' && FieldTarget.parse(r.target).target == tp)) {
            isMatch = false;
            break;
          }
        }
        if (!isMatch) {
          logger.error('Cannot constrain cardinality to %s because cardinality placement is ambiguous. Explicitly constrain parent elements in target path.', aggSourceCard.toString());
          return;
        }

        // Whole target path is mapped so now we just have to try to apply a constraint to the last part of the path
        // that will get us to the cardinality we're looking for.
        const parentEl = common.getSnapshotElementById(profile, targetID.substr(0, targetID.lastIndexOf('.')));
        const aggParentCard = getAggregateFHIRElementCardinality(profile, parentEl);

        // First determine what low card we need (the "magic min") to get to the desired cardinality min
        let magicMin;
        const [pMin, sMin] = [aggParentCard.min, aggSourceCard.min];
        if (sMin == aggTargetCard.min) {
          // It's already working out to the right min, so don't change it
          magicMin = targetCard.min;
        } else if (sMin == 0) {
          // We can always get to 0 by making magic min 0
          magicMin = 0;
        } else if (pMin == 1) {
          // If we're currently at min 1, then just set the magic min to the min we want!
          magicMin = sMin;
        } else if (sMin == pMin) {
          // If we're already at the min we want, just keep it steady with a magic min of 1, but...
          // Beware, because now we only support multiples of sMin (e.g., if we start with min 2, there's no way to
          // get to and aggregate of 3).
          magicMin = 1;
        } else if (sMin > pMin && sMin % pMin == 0) {
          // sMin is a multiple of pMin, so we can get to it, but the same warning as above applies here too
          magicMin = sMin / pMin;
        } else {
          logger.error('Cannot constrain cardinality to %s because there is no tail cardinality min that can get us there', aggSourceCard.toString());
          return;
        }

        // We have a min, so now try to figure out a magic max
        let magicMax;
        const [pMax, sMax] = [aggParentCard.max, aggSourceCard.max];
        if (sMax == aggTargetCard.max) {
          // It's already working out to the right max, so don't change it
          magicMax = targetCard.max;
        } else if (sMax == 0) {
          // We can always get to 0 by making magic max 0
          magicMax = 0;
        } else if (pMax == 1) {
          // If we're currently at max 1, then just set the magic max to the max we want!
          magicMax = sMax;
        } else if (sMax == pMax) {
          if (typeof sMax === 'undefined') {
            // This is * --> *.  Just keep the targetCard as-is (it will still aggregate to *).
            magicMax = targetCard.max;
          } else {
            magicMax = 1;
          }
        } else if (typeof sMax === 'undefined') {
          // To get to *, we must make magicMax * (undefined) -- so just don't set it!
        } else if (typeof pMax !== 'undefined' && sMax > pMax && sMax % pMax == 0) {
          // sMax is a multiple of pMax, so we can get to it
          magicMax = sMax / pMax;
        } else {
          logger.error('Cannot constrain cardinality to %s because there is no tail cardinality max that can get us there', aggSourceCard.toString());
          return;
        }

        const magicCard = new mdls.Cardinality(magicMin, magicMax);
        if (magicCard.fitsWithinCardinalityOf(targetCard)) {
          setCardinalityOnFHIRElements(magicCard, snapshotEl, differentialEl);
        } else {
          logger.error('Cannot constrain cardinality to %s because there is no tail cardinality that can get us there', aggSourceCard.toString());
          return;
        }
      }
    }
  }

  processFieldToFieldType(map, def, rule, profile, snapshotEl, differentialEl) {
    const sourceValue = this.findValueByPath(rule.sourcePath, def);
    const matchedPaths = this.processValueToFieldType(map, rule.sourcePath, sourceValue, profile, snapshotEl, differentialEl);
    if (TRACK_UNMAPPED_PATHS && !(snapshotEl.type.length == 1 && snapshotEl.type[0].code == 'BackboneElement')) {
      if (matchedPaths) {
        for (const mp of matchedPaths) {
          this.removeMappedPath(def, mp);
        }
      } else {
        this.removeMappedPath(def, rule.sourcePath);
      }
    }
    if (typeof matchedPaths === 'undefined') {
      // collect some info for an AWESOME error message
      let sourceString = sourceValue.effectiveIdentifier;
      if (!sourceValue.effectiveIdentifier.isPrimitive) {
        const value = this._specs.dataElements.findByIdentifier(sourceValue.effectiveIdentifier).value;
        if (value instanceof mdls.IdentifiableValue) {
          sourceString += `[Value: ${value.identifier.fqn}]`;
        } else if (value) {
          sourceString += `[Value: ${value.toString()}]`;
        }
      }

      const sMapsTo = this._specs.maps.findByTargetAndIdentifier(TARGET, sourceValue.effectiveIdentifier);
      if (sMapsTo) {
        sourceString += ` (mapped to ${sMapsTo.targetItem})`;
      }
      logger.error('Mismatched types. Cannot map %s to %s.', sourceString, typesToString(snapshotEl.type));
    }
    return;
  }

  knownMappingIssue(lhs, rhs, sourcePath, value, types) {
    const identifier = sourcePath[sourcePath.length - 1];
    if (identifier.fqn == lhs || (value && value.identifier && value.identifier.fqn == lhs)) {
      // left-hand side is satisfied, now check right-hand side
      return types.some(t => t.code == rhs || t.profile == `http://hl7.org/fhir/StructureDefinition/${rhs}`
        || (t.code == 'Reference' && t.targetProfile == `http://hl7.org/fhir/StructureDefinition/${rhs}`));
    }
    return false;
  }

  findAllowedConversionTargetTypes(sourceIdentifier, targetTypes) {
    // TODO: Should we consider the sourceIdentifier's basedOn elements as well?
    const fqn = sourceIdentifier.fqn;
    const allowedTargetTypes = [];
    if (Array.isArray(allowedConversions[fqn])) {
      for (const type of allowedConversions[fqn]) {
        const allowedTypes = targetTypes.filter(t => t.code == type
          || t.profile == `http://hl7.org/fhir/StructureDefinition/${type}`
          || (t.code == 'Reference' && t.targetProfile == `http://hl7.org/fhir/StructureDefinition/${type}`));
        allowedTargetTypes.push(...allowedTypes);
      }
    }
    return allowedTargetTypes;
  }

  processValueToFieldType(map, sourcePath, sourceValue, profile, snapshotEl, differentialEl) {
    const clonedPath = sourcePath.map(p => p.clone());
    const sourceIdentifier = sourceValue.effectiveIdentifier;
    const targetTypes = snapshotEl.type;

    // If the source is a primitive, then the target must be the same primitive!
    if (sourceIdentifier.isPrimitive) {
      const matchedTypes = targetTypes.filter(t => sourceIdentifier.name == t.code);
      if (matchedTypes.length > 0) {
        this.markSelectedOptionsInChoice(targetTypes, matchedTypes);
        this.applyConstraints(sourceValue, profile, snapshotEl, differentialEl, false);
        return [clonedPath];
      }
      const allowedConvertedTypes = this.findAllowedConversionTargetTypes(sourceIdentifier, targetTypes);
      if (allowedConvertedTypes.length > 0) {
        this.markSelectedOptionsInChoice(targetTypes, allowedConvertedTypes);
        this.applyConstraintsForConversion(sourceValue, profile, snapshotEl, differentialEl);
        return [clonedPath];
      }
      return undefined;
    }

    // It's a non-primitive source type.  First check if the field is mapped to a BackboneElement.
    if (targetTypes.length == 1 && targetTypes[0].code == 'BackboneElement') {
      // TODO: Determine what to do with backbone elements.  This signals that any source paths under it should put
      // the extension in the backbone rather than the root level.  This may also indicate a place where we need slices.
      // Until we figure out how to implement all that, just return true.
      return [clonedPath];
    }

    const matchedPaths = [];

    // Check if the source field has a mapping to a FHIR profile.  If so, and it matches target, apply the profile to the target
    const sourceMap = this._specs.maps.findByTargetAndIdentifier(TARGET, sourceIdentifier);
    if (typeof sourceMap !== 'undefined') {
      let matchedType;
      const profileURL = common.fhirURL(sourceMap.identifier);
      const allowableTargetTypes = this.getTypeHierarchy(sourceMap.targetItem);
      const allowableTargetProfiles = allowableTargetTypes.map(t => `http://hl7.org/fhir/StructureDefinition/${t}`);
      const basedOnTargetProfiles = this.getRecursiveBasedOns(sourceIdentifier).map(b => common.fhirURL(b, false));
      for (const t of targetTypes) {
        if (allowableTargetTypes.includes(t.code) || allowableTargetProfiles.includes(t.profile) || basedOnTargetProfiles.includes(t.profile)) {
          matchedType = t;
          // Only change the type if it hasn't already been selected (e.g. changed) by the mapper
          // or if the previous is a supertype (i.e., a profile of one of its basedOn types)
          if (!this.optionIsSelected(t) || basedOnTargetProfiles.includes(t.profile)) {
            t.profile = profileURL;
            this.markSelectedOptionsInChoice(targetTypes, [t]);
          }
          break;
        } else if (t.code == 'Reference' && (allowableTargetProfiles.includes(t.targetProfile) || basedOnTargetProfiles.includes(t.targetProfile))) {
          matchedType = t;
          // Only change the type if it hasn't already been selected (e.g. changed) by the mapper
          // or if the previous is a supertype (i.e., a profile of one of its basedOn types)
          if (!this.optionIsSelected(t) || basedOnTargetProfiles.includes(t.targetProfile)) {
            t.targetProfile = profileURL;
            this.markSelectedOptionsInChoice(targetTypes, [t]);
          }
          break;
        }
      }

      if (typeof matchedType !== 'undefined') {
        // We got a match!
        // Check to see if this is trying to map a different element than the one that was previously mapped.
        const mappedProfile = typeof matchedType.profile !== 'undefined' ? matchedType.profile : matchedType.targetProfile;
        if (profileURL != mappedProfile) {
          // It's trying to map a different element than the one that was previously mapped.  Conflict!
          logger.warn('Trying to map %s to %s, but %s was previously mapped to it', profileURL, matchedType.code, mappedProfile);
        } else {
          // We successfully mapped the type, so we need to apply the differential and constraints
          differentialEl.type = snapshotEl.type;
          this.applyConstraints(sourceValue, profile, snapshotEl, differentialEl, false);
          matchedPaths.push(clonedPath);
        }
      } else {
        const allowedConvertedTypes = this.findAllowedConversionTargetTypes(sourceIdentifier, targetTypes);
        if (allowedConvertedTypes.length > 0) {
          this.markSelectedOptionsInChoice(targetTypes, allowedConvertedTypes);
          this.applyConstraintsForConversion(sourceValue, profile, snapshotEl, differentialEl);
          matchedPaths.push(clonedPath);
        }
      }
    }

    // If we have a match for each type (in this case, 1 each), then we can return the match now
    if (matchedPaths.length == targetTypes.length) {
      return matchedPaths;
    }

    // If we still don't have a match, or if we have a match but the target is a choice, try to map the source's Value
    const sourceEl = this._specs.dataElements.findByIdentifier(sourceIdentifier);
    if (sourceEl && sourceEl.value) {
      // If the element has any unmapped required fields, then it's not appropriate to map the value
      if (matchedPaths.length > 0) {
        // Loop through the fields, looking for required fields
        for (const field of sourceEl.fields) {
          if (field.effectiveCard.min != 0) {
            // It's required so check to see if it is mapped or not.
            const fullPath = [...clonedPath, field.identifier];
            if (!map.rulesFilter.withSourcePath(fullPath).hasRules) {
              // No mapping rules exist for this required field, so it's not appropriate to map the value
              return matchedPaths.length > 0 ? matchedPaths : undefined;
            }
          }
        }
      }

      // It's potentially appropriate to map the value
      if (sourceEl.value instanceof mdls.IdentifiableValue) {
        const mergedValue = this.mergeConstraintsToChild(sourceValue, sourceEl.value, true);
        const newPath = [...clonedPath, mergedValue.effectiveIdentifier];
        const valMatchedPaths = this.processValueToFieldType(map, newPath, mergedValue, profile, snapshotEl, differentialEl);
        if (typeof valMatchedPaths !== 'undefined') {
          matchedPaths.push(...valMatchedPaths);
        }
      } else if (sourceEl.value instanceof mdls.ChoiceValue) {
        for (const opt of sourceEl.value.aggregateOptions) {
          if (opt instanceof mdls.IdentifiableValue) {
            // First merge the choicevalue onto the option value (TODO: Will this work right w/ aggregate options?)
            let mergedValue = this.mergeConstraintsToChild(sourceEl.value, opt);
            // Then merge the sourceValue onto the merged option value
            mergedValue = this.mergeConstraintsToChild(sourceValue, mergedValue);
            const newPath = [...clonedPath, mergedValue.effectiveIdentifier];
            const optMatchedPaths = this.processValueToFieldType(map, newPath, mergedValue, profile, snapshotEl, differentialEl);
            if (optMatchedPaths) {
              let loggedWarning = false; // Only need to log the warning once per choice
              for (const omp of optMatchedPaths) {
                if (matchedPaths.some(mp => mp !== omp && pathsAreEqual(mp, omp))) {
                  if (!loggedWarning) {
                    logger.warn('Choice has equivalent types, so choice options may overwrite or override each other when mapped to FHIR.');
                    loggedWarning = true;
                  }
                } else {
                  matchedPaths.push(omp);
                }
              }
            }
          }
        }
      }
    }

    return matchedPaths.length > 0 ? matchedPaths : undefined;
  }

  // NOTE: This function "borrowed" from shr-expand
  getRecursiveBasedOns(identifier, alreadyProcessed = []) {
    // If it's primitive or we've already processed this one, don't go further (avoid circular dependencies)
    if (identifier.isPrimitive || alreadyProcessed.some(id => id.equals(identifier))) {
      return alreadyProcessed;
    }

    // We haven't processed it, so look it up
    const element = this._specs.dataElements.findByIdentifier(identifier);
    if (typeof element === 'undefined') {
      logger.error('Cannot resolve element definition for %s', identifier.fqn);
      return alreadyProcessed;
    }
    // Add it to the already processed list (again, to avoid circular dependencies)
    alreadyProcessed.push(identifier);
    // Now recursively get the BasedOns for each of the BasedOns
    for (const basedOn of element.basedOn) {
      alreadyProcessed = this.getRecursiveBasedOns(basedOn, alreadyProcessed);
    }

    return alreadyProcessed;
  }

  markSelectedOptionsInChoice(allTypes, selectedTypes) {
    // Only mark them if it really is a choice (e.g., more than one type available)
    if (allTypes.length > 1) {
      for (const t of selectedTypes) {
        t._shrSelected = true;
      }
    }
  }

  optionIsSelected(option) {
    return option._shrSelected === true;
  }

  getTypeHierarchy(fhirType) {
    const type = this._fhir.find(fhirType);
    if (typeof type === 'undefined') {
      return [];
    }
    if (typeof type.baseDefinition !== 'undefined' && type.baseDefinition.startsWith('http://hl7.org/fhir/StructureDefinition/')) {
      const baseType = type.baseDefinition.substr(40);
      return [type.id, ...this.getTypeHierarchy(baseType)];
    }
    return [type.id];
  }

  applyConstraints(sourceValue, profile, snapshotEl, differentialEl, isExtension) {
    // As a *very* special (and unfortunate) case, we must special-case quantity.  Essentially, the problem is that
    // Quantity maps Units.Coding onto itself, so the constraints on Units.Coding need to be applied to Quantity instead.
    if (sourceValue.identifier.equals(new mdls.Identifier('shr.core', 'Quantity'))) {
      // Move all constraints from Units.Coding to the Quantity, but first -- clone!
      sourceValue = sourceValue.clone();
      const unitsCodingCsts = sourceValue.constraintsFilter.withPath([new mdls.Identifier('shr.core', 'Units'), new mdls.Identifier('shr.core', 'Coding')]).constraints;
      for (const cst of unitsCodingCsts) {
        cst.path = [];
      }
    }

    // We can only apply non-card constraints since its own card constraints are handled elsewhere
    // (TODO: consider applying child card constraints).  So if there are no constraints, just return;
    if ((sourceValue.constraints.length - sourceValue.constraintsFilter.card.constraints.length) == 0) {
      return;
    }

    // If it is a choice, we actually want to make the specific choice explicit and apply constraints there
    if (snapshotEl.path.endsWith('[x]')) {
      // Swap out the snapshot and differential variables with the new ones
      snapshotEl = this.addExplicitChoiceElement(sourceValue.effectiveIdentifier, profile, snapshotEl, differentialEl);
      differentialEl = profile.differential.element.find(e => e.id == snapshotEl.id);
      if (typeof differentialEl === 'undefined') {
        differentialEl = {
          id: snapshotEl.id,
          path: snapshotEl.path,
          type: snapshotEl.type
        };
        profile.differential.element.push(differentialEl);
      }
    }

    // First handle own constraints
    this.applyOwnValueSetConstraints(sourceValue, profile, snapshotEl, differentialEl);
    this.applyOwnCodeConstraints(sourceValue, profile, snapshotEl, differentialEl);
    this.applyOwnIncludesCodeConstraints(sourceValue, profile, snapshotEl, differentialEl);
    this.applyOwnBooleanConstraints(sourceValue, profile, snapshotEl, differentialEl);

    // Handle child constraints if necessary -- this will require "unrolling" the element
    if (sourceValue.constraintsFilter.child.hasConstraints) {
      // Unroll the current element so we can dive into it
      this.unrollElement(sourceValue.effectiveIdentifier, profile, snapshotEl);

      // Organize constraints by path
      const pathToConstraintMap = new Map();
      for (const cst of sourceValue.constraintsFilter.child.constraints) {
        const path = cst.path.map(p => `(${p.fqn})`).join('.');
        if (!pathToConstraintMap.has(path)) {
          pathToConstraintMap.set(path, []);
        }
        pathToConstraintMap.get(path).push(cst);
      }
      if (isExtension) {
        // Iterate by path-grouped constraints
        for (const csts of pathToConstraintMap.values()) {
          const path = csts[0].path;
          const element = this.getElementInExtension([sourceValue.effectiveIdentifier, ...path], profile, snapshotEl);
          if (typeof element === 'undefined') {
            logger.error('Failed to resolve element path from %s to %s', snapshotEl.id, path);
            continue;
          }
          const childSourceValue = new mdls.IdentifiableValue(path[path.length-1]);
          for (const childCst of csts) {
            // Add the constraint, cloning it and making its path at the root
            childSourceValue.addConstraint(childCst.clone().withPath([]));
          }
          // There probably isn't a differential element, so check and create if necessary
          let diffElement = profile.differential.element.find(e => e.id == element.id);
          const dfIsNew = (typeof diffElement === 'undefined');
          if (dfIsNew) {
            diffElement = { id: element.id, path: element.path };
          }
          this.applyOwnValueSetConstraints(childSourceValue, profile, element, differentialEl);
          this.applyOwnCodeConstraints(childSourceValue, profile, element, differentialEl);
          this.applyOwnIncludesCodeConstraints(childSourceValue, profile, element, differentialEl);
          this.applyOwnBooleanConstraints(childSourceValue, profile, element, differentialEl);
          if (dfIsNew && Object.keys(diffElement).length > 2) {
            profile.differential.element.push(diffElement);
          }
        }
      } else {
        logger.error('Applying constraints to profiled children not yet supported. SHR doesn\'t have a use case yet.');
      }
    }
  }

  getElementInExtension(shrPath, profile, snapshotEl) {
    // If the path length is only 1, we can return the snapshotEl since it's always the match for the first element in the path
    if (shrPath.length <= 1) {
      // Because SHR sometimes uses implicit values (and sometimes not), we don't yet know if we can stop here.
      if (shrPath.length == 0 || snapshotEl.id.substr(snapshotEl.id.lastIndexOf('.')+1).startsWith('value')) {
        return snapshotEl;
      }
    }

    // Check to see if it needs to be unrolled
    if (!profile.snapshot.element.some(e => e.id == (`${snapshotEl.id}.id`))) {
      this.unrollElement(shrPath[0], profile, snapshotEl);
    }
    // If it's a simple extension, it will have a value element that is not zeroed out
    // If it's not an extension, or the value element is zeroed out, we need to dig deeper
    const valueEl = profile.snapshot.element.find(e => e.id.startsWith(`${snapshotEl.id}.value`));
    const isSimple = typeof valueEl !== 'undefined' && valueEl.max == '1';
    let el;
    if (isSimple) {
      // There's really only one place to find it: the value element
      el = profile.snapshot.element.find(e => e.id.startsWith(`${snapshotEl.id}.value`));
    } else {
      const url = common.fhirURL(shrPath[1], true);
      el = profile.snapshot.element.find(e => {
        return e.id.startsWith(snapshotEl.id) && e.path == `${snapshotEl.path}.extension`
          && e.type && e.type.some(t => t.profile == url);
      });
    }
    if (typeof el === undefined) {
      logger.error('Failed to resolve path from %s to %s', snapshotEl.id, shrPath);
      return;
    }
    return this.getElementInExtension(shrPath.slice(1), profile, el);
  }

  applyOwnValueSetConstraints(sourceValue, profile, snapshotEl, differentialEl) {
    const vsConstraints = sourceValue.constraintsFilter.own.valueSet.constraints;
    if (vsConstraints.length > 0) {
      const vsConstraint = vsConstraints[0];
      const vsURI = vsConstraint.valueSet;
      if (vsURI.startsWith('urn:tbd')) {
        // Skip TBD value set
        return;
      }

      let strength = 'required';
      if (vsConstraint.isRequired) {
        strength = 'required';
      } else if (vsConstraint.isExtensible) {
        strength = 'extensible';
      } else if (vsConstraint.isPreferred) {
        strength = 'preferred';
      } else if (vsConstraint.isExample) {
        strength = 'example';
      } else {
        logger.error('Unsupported binding strength: %s', vsConstraint.bindingStrength);
        return;
      }

      const bind = snapshotEl.binding;
      if (bind) {
        if (!allowedBindingStrengthChange(bind.strength, strength)) {
          logger.error('Cannot change binding strength from %s to %s', bind.strength, strength);
          return;
        }

        if ((bind.valueSetReference && bind.valueSetReference.reference == vsURI) || bind.valueSetUri == vsURI) {
          // It's already bound to this same value set, so we just need to set the strength (if necessary)
          if (bind.strength != strength) {
            snapshotEl.binding.strength = strength;
            if (typeof differentialEl.binding === 'undefined') {
              differentialEl.binding = snapshotEl.binding;
            } else {
              differentialEl.binding.strength = strength;
            }
          }
          return;
        } else if (bind.strength == 'required') {
          const bindVSURI = bind.valueSetReference ? bind.valueSetReference.reference : bind.valueSetUri;
          if (!this.isValueSetSubsetOfOther(vsURI, bindVSURI)) {
            logger.error('Cannot override value set constraint from %s to %s', bindVSURI, vsURI);
            return;
          }
        } else if (bind.strength == 'extensible') {
          const bindVSURI = bind.valueSetReference ? bind.valueSetReference.reference : bind.valueSetUri;
          if (!this.isValueSetSubsetOfOther(vsURI, bindVSURI)) {
            logger.warn('Overriding extensible value set constraint from %s to %s.  Only allowed when new codes do not overlap meaning of old codes.', bindVSURI, vsURI);
            // this is technically allowed, so don't return yet -- just continue...
          }
        }
      }
      snapshotEl.binding = differentialEl.binding = {
        strength : strength,
        valueSetReference : {
          reference : vsConstraint.valueSet
        }
      };
      if (vsConstraints.length > 1) {
        logger.error('Found more than one value set to apply to %s. This should never happen and is probably a bug in the tool.', snapshotEl.id);
      }
    }
  }

  isValueSetSubsetOfOther(vsURI, otherVSURI) {
    // First map SHR and FHIR VS to normalized versions (marking unsupporting instances)
    const [vs, otherVS] = [vsURI, otherVSURI].map(uri => {
      let valueSet = this._specs.valueSets.findByURL(uri);
      if (typeof valueSet !== 'undefined') {
        // It's an SHR value set
        const result = {};
        for (const r of valueSet.rules) {
          if (!(r instanceof mdls.ValueSetIncludesCodeRule)) {
            return {_unsupported: true};
          }
          if (typeof result[r.code.system] === 'undefined') {
            result[r.code.system] = [];
          }
          result[r.code.system].push(r.code.code);
        }
        return result;
      }
      // It's not an SHR VS, try FHIR
      valueSet = this._fhir.findValueSet(uri);
      if (typeof valueSet !== 'undefined') {
        // It's a FHIR value set
        const result = {};
        if (typeof valueSet.compose === 'undefined') {
          return {_unsupported: true};
        } else if (typeof valueSet.compose.exclude !== 'undefined' && valueSet.compose.exclude.length > 0) {
          return {_unsupported: true};
        } else if (typeof valueSet.compose.include === 'undefined' || valueSet.compose.include.length == 0) {
          return {_unsupported: true};
        }
        for (const incl of valueSet.compose.include) {
          if (typeof incl.system === 'undefined' || (typeof incl.filter !== 'undefined' && incl.filter.length > 0) || (typeof incl.valueSet !== 'undefined' && incl.valueSet.length > 0)) {
            return {_unsupported: true};
          }
          if (typeof result[incl.system] === 'undefined') {
            result[incl.system] = [];
          }
          if (typeof incl.concept !== 'undefined') {
            for (const c of incl.concept) {
              result[incl.system].push(c);
            }
          }
        }
        return result;
      } else {
        return {_unsupported: true};
      }
    });

    if (vs._unsupported ||  otherVS._unsupported) {
      return false;
    }

    // Go through the VS codes to see if they are all in other VS codes
    for (const system of Object.keys(vs)) {
      const codes = vs[system];
      const otherCodes = otherVS[system];
      if (typeof otherCodes === 'undefined') {
        return false;
      } else if (otherCodes.length == 0) {
        // This means the other contains ALL codes in that system, so it has to be a match
        // Continue to the next system
        continue;
      }

      // Only match if every code is in the other
      if (! codes.every(c => otherCodes.includes(c))) {
        return false;
      }
    }
    return true;
  }

  applyOwnCodeConstraints(sourceValue, profile, snapshotEl, differentialEl) {
    const codeConstraints = sourceValue.constraintsFilter.own.code.constraints;
    if (codeConstraints.length > 0) {
      this.fixCodeOnElement(sourceValue.identifier.fqn, profile, snapshotEl, differentialEl, codeConstraints[0].code);
      if (codeConstraints.length > 1) {
        logger.error('Found more than one code to fix on %s. This should never happen and is probably a bug in the tool.', snapshotEl.id);
      }
    }
  }

  applyOwnIncludesCodeConstraints(sourceValue, profile, snapshotEl, differentialEl) {
    // This requires slicing.  See: https://chat.fhir.org/#narrow/stream/implementers/subject/fixedUri
    let sliced = false;
    const icConstraints = sourceValue.constraintsFilter.own.includesCode.constraints;
    for (let i=0; i < icConstraints.length; i++) {
      const code = icConstraints[i].code;
      if (code.system == 'urn:tbd') {
        // Skip TBD code
        return;
      }

      // Create the individual slices to indicate the included code
      const sliceSnapshotEl = {
        id: `${snapshotEl.id}:${code.code}`,
        path: snapshotEl.path,
        sliceName: code.code,
        min: 1,
        max: '1',
        type: common.cloneJSON(snapshotEl.type),
      };
      const sliceDifferentialEl = common.cloneJSON(sliceSnapshotEl);
      // NOTE: STU3 spec recommends against using pattern[X] with slices
      this.fixCodeOnElement(sourceValue.identifier.fqn, profile, sliceSnapshotEl, sliceDifferentialEl, code, false);

      // Add the slices to the profile
      let start = profile.snapshot.element.findIndex(e => e.id == snapshotEl.id) + 1;
      profile.snapshot.element.splice(start, 0, sliceSnapshotEl);
      start = profile.differential.element.findIndex(e => e.id == differentialEl.id) + 1;
      profile.differential.element.splice(start, 0, sliceDifferentialEl);

      sliced = true;
    }

    if (sliced) {
      // Need to set the slicing up on the base element
      switch (sourceValue.identifier.fqn) {
      case 'code':
        common.addSlicingToBaseElement(snapshotEl, differentialEl, 'value', '$this');
        break;
      case 'shr.core.Coding':
      case 'shr.core.Quantity':
        common.addSlicingToBaseElement(snapshotEl, differentialEl, 'value', 'system');
        common.addSlicingToBaseElement(snapshotEl, differentialEl, 'value', 'code');
        break;
      case 'shr.core.CodeableConcept':
        common.addSlicingToBaseElement(snapshotEl, differentialEl, 'value', 'coding');
        break;
      default:
        logger.error('Can\'t fix code on %s because source value isn\'t code-like. This should never happen and is probably a bug in the tool.', snapshotEl.id);
        return;
      }
    }
  }

  fixCodeOnElement(codeType, profile, snapshotEl, differentialEl, code, usePattern=true) {
    if (code.system == 'urn:tbd') {
      // Skip TBD code
      return;
    }
    const prefix = usePattern ? 'pattern' : 'fixed';
    // Different behavior based on code type
    let property, value, matches;
    switch (codeType) {
    case 'code':
      property = 'fixedCode';
      value = code.code;
      matches = (ssValue) => ssValue = code.code;
      break;
    case 'shr.core.Coding':
    case 'Coding':
      property = `${prefix}Coding`;
      value = { system: code.system, code: code.code };
      matches = (ssValue) => ssValue.system == code.system && ssValue.code == code.code;
      break;
    case 'shr.core.CodeableConcept':
    case 'CodeableConcept':
      property = `${prefix}CodeableConcept`;
      value = { coding: [{ system: code.system, code: code.code }] };
      matches = (ssValue) => ssValue.coding && ssValue.coding.length == 1 && ssValue.coding[0].system == code.system && ssValue.coding[0].code == code.code;
      break;
    case 'shr.core.Quantity':
    case 'Quantity':
      property = `${prefix}Quantity`;
      value = { system: code.system, code: code.code };
      matches = (ssValue) => ssValue.system == code.system && ssValue.code == code.code;
      break;
    }

    if (typeof property === 'undefined') {
      logger.error('Can\'t fix code on %s because source value isn\'t code-like. This should never happen and is probably a bug in the tool.', snapshotEl.id);
      return;
    }

    // Iterate through the snapshot element to see if it already has fixed code-like values
    for (let key of ['fixedCode', `${prefix}Coding`, `${prefix}CodeableConcept`, `${prefix}Quantity`]) {
      if (snapshotEl.hasOwnProperty(key)) {
        if (key == property && typeof matches !== 'undefined' && matches(snapshotEl[key])) {
          // It's already fixed to this value, so there's nothing to do.
          return;
        }
        // Found another non-matching fixed value.  Put on the brakes.
        logger.error('Cannot override code constraint from %j to %j', snapshotEl[key], value);
        return;
      }
    }

    // If we made it this far, we can set the fixed value
    snapshotEl[property] = differentialEl[property] = value;
    if (REPORT_PROFILE_INDICATORS) {
      this.addFixedValueIndicator(profile, snapshotEl.path, value);
    }
  }

  applyOwnBooleanConstraints(sourceValue, profile, snapshotEl, differentialEl) {
    const boolConstraints = sourceValue.constraintsFilter.own.boolean.constraints;
    if (boolConstraints.length > 0) {
      const value = boolConstraints[0].value;
      if (typeof snapshotEl.fixedBoolean !== 'undefined') {
        if (snapshotEl.fixedBoolean == value) {
          // It's already fixed to this value, so there's nothing to do.
          return;
        }
        // Found another non-matching fixed value.  Put on the brakes.
        logger.error('Cannot override boolean constraint from %s to %s', snapshotEl.fixedBoolean, value);
        return;
      }
      snapshotEl.fixedBoolean = differentialEl.fixedBoolean = value;
      if (REPORT_PROFILE_INDICATORS) {
        this.addFixedValueIndicator(profile, snapshotEl.path, value);
      }
      if (boolConstraints.length > 1) {
        logger.error('Found more than one boolean to fix on %s. This should never happen and is probably a bug in the tool.', snapshotEl.id);
      }
    }
  }

  // This function applies applicable constraints when there is a non-trival conversion -- and warns if constraints will be dropped.
  applyConstraintsForConversion(sourceValue, profile, snapshotEl, differentialEl) {
    const sourceIdentifier = sourceValue.effectiveIdentifier;
    const targetTypes = snapshotEl.type;

    if (sourceValue.constraintsFilter.own.boolean.hasConstraints) {
      // There's no conversion that can support boolean constraints
      logger.error('Conversion from %s to one of %j drops boolean constraints', sourceIdentifier.fqn, targetTypes);
    } else {
      const targetAllowsCodeConstraints = targetTypes.some(t => t.code == 'code' || t.code == 'Coding' || t.code == 'CodeableConcept' || t.code == 'string');
      if (targetAllowsCodeConstraints) {
        this.applyOwnValueSetConstraints(sourceValue, profile, snapshotEl, differentialEl);
        this.applyOwnCodeConstraints(sourceValue, profile, snapshotEl, differentialEl);
        this.applyOwnIncludesCodeConstraints(sourceValue, profile, snapshotEl, differentialEl);
        return;
      }
      if (sourceValue.constraintsFilter.own.valueSet.hasConstraints) {
        logger.error('Conversion from %s to one of %j drops value set constraints', sourceIdentifier.fqn, targetTypes);
      }
      if (sourceValue.constraintsFilter.own.code.hasConstraints) {
        logger.error('Conversion from %s to one of %j drops code constraints', sourceIdentifier.fqn, targetTypes);
      }
      if (sourceValue.constraintsFilter.own.includesCode.hasConstraints) {
        logger.error('Conversion from %s to one of %j drops includesCode constraints', sourceIdentifier.fqn, targetTypes);
      }
    }
  }

  addExtensions(map, profile) {
    // TODO: Do we add extension for all unmapped branches of the tree?  If so, how/where?
    //   - (a) add individual extensions for each unmapped branch (and put it where?)
    //   - (b) add one parent extension and profile out the bits already mapped
    // Start simple (for now) -- just find base-level fields that are not mapped
    const def = this._specs.dataElements.findByIdentifier(map.identifier);
    for (const field of common.valueAndFields(def)) {
      // TODO: Apply constraints to extensions
      if (field instanceof mdls.IdentifiableValue) {
        if (!map.rules.some(r => r.sourcePath && r.sourcePath.length > 0 && r.sourcePath[0].equals(field.identifier))) {
          this.addExtension(def, profile, [field.identifier]);
          if (TRACK_UNMAPPED_PATHS) {
            this.removeMappedPath(def, [field.identifier]);
          }
        }
        // TODO: Should also dive into elements that are mapped and check if their sub-fields are mapped (recursively)
      } else {
        // TODO: Support choices
      }
    }
  }

  addExtension(def, profile, sourcePath, extURL) {
    const sourceValue = this.findValueByPath(sourcePath, def);
    if (sourceValue.effectiveCard.max == 0) {
      // Since we're based on FHIR Resources (and don't base on other Profiles), it doesn't make sense to profile *out*
      // an extension -- since the extension isn't in the base resource to begin with.  So, instead, just skip it.
      return;
    }

    const identifier = sourceValue.effectiveIdentifier;

    if (identifier && identifier._namespace === 'unknown') {
      logger.error('Unable to establish namespace for %s', identifier._name);
      return;
    }

    if (typeof extURL === 'undefined') {
      extURL = this._extensionExporter.lookupExtension(identifier).url;
    }

    // By convention (for now) modifiers have the word "Modifier" in their name
    const isModifier = (/modifier/i).test(identifier.name);

    const ssEl = common.cloneJSON(common.getSnapshotElement(profile, (isModifier ? 'modifierExtension' : 'extension')));
    ssEl.id = `${ssEl.id}:${common.shortID(identifier)}`;
    ssEl.sliceName = common.shortID(identifier);
    ssEl.definition = this.getDescription(identifier, `SHR ${identifier.name} Extension`);
    delete(ssEl.short);
    delete(ssEl.comments);
    ssEl.min = sourceValue.effectiveCard.min;
    ssEl.max = typeof sourceValue.effectiveCard.max === 'undefined' ? '*' : sourceValue.effectiveCard.max.toString();
    ssEl.type = [{ code : 'Extension', profile : extURL }];
    // TODO: Do we need to add the condition and constraints here?
    ssEl.mustSupport = isModifier;
    ssEl.isModifier = isModifier;
    ssEl.isSummary = false;

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

    // Insert the elements before applying constraints, because the constraints may need to "unroll" the elements
    this.insertExtensionElementInList(ssEl, profile.snapshot.element);
    this.insertExtensionElementInList(dfEl, profile.differential.element);
    this.applyConstraints(sourceValue, profile, ssEl, dfEl, true);

    return;
  }

  insertExtensionElementInList(extElement, elements) {
    let inserted = false;
    const priorPaths = ['id', 'meta', 'implicitRules', 'language', 'text', 'contained', 'extension'];
    if (extElement.isModifier) {
      priorPaths.push('modifierExtension');
    }
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

  lookupProfile(identifier, createIfNeeded=true) {
    let p = this._profiles.find(p => p.id == common.fhirID(identifier));
    if (typeof p === 'undefined' && createIfNeeded) {
      const mapping = this._specs.maps.findByTargetAndIdentifier(TARGET, identifier);
      if (typeof mapping !== 'undefined') {
        // Warning -- there CAN be a circular dependency here -- so watch out!  I warned you...
        p = this.mappingToProfile(mapping);
      } else {
        // This must be an Element that has no mapping provided, so... map to Basic
        const basicMapping = new mdls.ElementMapping(identifier, TARGET, 'Basic');
        this._specs.maps.add(basicMapping);
        p = this.mappingToProfile(basicMapping);
      }
    }
    return p;
  }

  lookupStructureDefinition(id) {
    // First check profiles
    const profile = this._profiles.find(p => p.id == id);
    if (typeof profile !== 'undefined') {
      return profile;
    }
    const ext = this._extensionExporter.extensions.find(e => e.id == id);
    if (typeof ext !== 'undefined') {
      return ext;
    }
    return this._fhir.find(id);
  }

  getSnapshotElementForFieldTarget(profile, fieldTarget, sliceAtCard) {
    // First handle the case where we're referencing an option in a choice (TODO: Support drilling into options)
    let choice;
    let parts = [profile.type, ...fieldTarget.target.split('.')];
    if (parts.length > 1 && parts[parts.length-2].endsWith('[x]')) {
      // The last part of the target is the actual choice, but the real FHIR element path ends with [x]
      choice = parts.pop();
    }

    // Unroll paths as necessary to support drilling into types
    for (let i=0; i < parts.length; i++) {
      let path = parts.slice(0, i+1).join('.');
      if (profile.snapshot.element.some(e => e.path == path)) {
        continue;
      }
      // The path doesn't exist.  We may need to unroll a nested data type in the path's parent
      const parentEl = profile.snapshot.element.find(e => e.path == parts.slice(0, i).join('.'));
      if (typeof parentEl === 'undefined' || !Array.isArray(parentEl.type) || parentEl.type.length != 1) {
        // The parent isn't a drillable element
        return;
      } else if (typeof parentEl.type[0].code === 'undefined' || parentEl.type[0].code == 'Reference') {
        // The parent type isn't drillable (it's a reference or unspecified type)
        return;
      }
      const type = parentEl.type[0].code;
      const sd = this.lookupStructureDefinition(type);
      // Before we unroll it, check to be sure the sub-element exists (otherwise we needlessly unroll it)
      if (sd.snapshot.element.some(e => e.path == `${sd.type}.${parts[i]}`)) {
        this.unrollElement(type, profile, parentEl);
      } else {
        return;
      }
    }

    const path = parts.join('.');
    let elements = profile.snapshot.element.filter(e => e.path == path);
    if (elements.length == 0) {
      return;
    }

    let element;
    // If this field target requests a new slice section or indicates it's in a slice, we need to do some magic
    if (fieldTarget.hasSliceOnCommand()) {
      let baseElement = elements[0];
      // If the mapping has a slice at command, then that's where we need to set the base element to apply slicing info
      if (fieldTarget.hasSliceAtCommand()) {
        const sliceAt =  [profile.type, ...fieldTarget.findSliceAtCommand().value.split('.')].join('.');
        const atElements = profile.snapshot.element.filter(e => e.path == sliceAt);
        if (atElements.length == 0) {
          return;
        }
        baseElement = atElements[0];
      }

      // Apply the discriminator to the base element in the snapshot and the differential
      const discType = fieldTarget.hasSliceOnTypeCommand() ? fieldTarget.findSliceOnTypeCommand().value : 'value';
      common.addSlicingToBaseElement(baseElement, null, discType, fieldTarget.findSliceOnCommand().value);
      let df = common.getDifferentialElementById(profile, baseElement.id);
      if (typeof df === 'undefined') {
        df = { id: baseElement.id, path: baseElement.path };
        profile.differential.element.push(df);
      }
      df.slicing = baseElement.slicing;

      let sliceName;
      if (fieldTarget.hasInSliceCommand()) {
        [/*match*/,/*path*/,sliceName] = /(.*)\s*\[(.*)\]/.exec(fieldTarget.findInSliceCommand());
      } else {
        // this shouldn't ever happen, but just in case
        logger.error('No slice name supplied for target. This should never happen and is probably a bug in the tool.');
        sliceName = `gen-${elements.length+1}`;
      }

      // Now add the section for the slice!
      const sliceSection = profile.snapshot.element.filter(e => {
        return e.id == baseElement.id || e.id.startsWith(`${baseElement.id}.`);
      }).map(e => {
        const element = common.cloneJSON(e);
        element.id = element.id.replace(baseElement.id, `${baseElement.id}:${sliceName}`);
        return element;
      });
      const sliceSectionDf = { id: sliceSection[0].id, path: sliceSection[0].path, sliceName: sliceName };
      // The base slice section element has slicing (from the copy), but we don't need to repeat that
      delete(sliceSection[0].slicing);
      sliceSection[0].sliceName = sliceName;
      // If a sliceAtCard was passed in, set it
      if (typeof sliceAtCard !== 'undefined') {
        setCardinalityOnFHIRElements(sliceAtCard, sliceSection[0], sliceSectionDf, true);
      }
      // Add the differential w/ the sliceName
      profile.differential.element.push(sliceSectionDf);

      // Find the insertion point, which should be at the end of any current slices
      let i = profile.snapshot.element.findIndex(e => e == baseElement) + 1;
      for ( ; i < profile.snapshot.element.length && profile.snapshot.element[i].path.startsWith(baseElement.path); i++);
      // Insert the section
      profile.snapshot.element.splice(i, 0, ...sliceSection);
    }

    if (fieldTarget.hasSliceOnCommand()) {
      // We added new slice elements, so we need to refilter for the target elements again
      elements = profile.snapshot.element.filter(e => e.path == path);
    }
    if (elements.length > 1) {
      if (fieldTarget.hasInSliceCommand()) {
        const [/*match*/,/*path*/,sliceName] = /(.*)\s*\[(.*)\]/.exec(fieldTarget.findInSliceCommand());
        element = elements.find(s => {
          return profile.snapshot.element.some(e => s.id.startsWith(e.id) && e.sliceName == sliceName);
        });
        if (typeof element === 'undefined') {
          logger.error('Couldn\'t find target in slice %s', sliceName);
          element = elements[0];
        }
      } else {
        logger.error('Target resolves to multiple elements but is not sliced');
        element = elements[0];
      }
    } else {
      element = elements[0];
    }

    // Since this was a choice, we need to validate that it's a valid choice (and also mark it as used)
    if (path.endsWith('[x]') && typeof choice != 'undefined' && !common.elementTypeContainsTypeName(element.type, choice)) {
      // Don't return the element since it doesn't contain the requested choice
      return;
    }
    return element;
  }

  // Given a path (identifier array) and a SHR data element definition, it will return the matching value at the tail
  // of the path with all constraints aggregrated onto it
  findValueByPath(path, def, valueOnly=false, parentConstraints=[]) {
    if (path.length == 0) {
      return;
    }

    if (path[0].equals(ENTRY_ID)) {
      // TODO: This will need to be adjusted if we support constraining entry fields from the entry instance
      if (path.length == 1) {
        // This is the end of the path, so just give them a 1..1 Entry
        return new mdls.IdentifiableValue(ENTRY_ID).withMinMax(1, 1);
      }
      def = this._specs.dataElements.findByIdentifier(ENTRY_ID);
      path = path.slice(1);
    }

    // Find the value at the root of the path
    const valuesToSearch = valueOnly ? [def.value] : common.valueAndFields(def);
    let value = this.findValueByIdentifier(path[0], valuesToSearch);
    // If we didn't find the value, it could be one of those cases where we replaced the original identifier with
    // an includesType identifier, so we should check the constraints to look for a match on the includesType.
    if (typeof value == 'undefined' && parentConstraints.length > 0) {
      const cf = new mdls.ConstraintsFilter(parentConstraints);
      for (const itc of cf.includesType.constraints) {
        if (itc.path.length == 1 && itc.isA.equals(path[0])) {
          value = this.findValueByIdentifier(itc.path[0], valuesToSearch);
          if (typeof value !== 'undefined') {
            value = new mdls.IdentifiableValue(itc.isA).withCard(itc.card);
            // Apply special marker used only in FHIR Exporter.  There is probably a more elegant way, but the
            // alternative right now seems to require a ton of code
            value._derivedFromIncludesTypeConstraint = true;
          }
        }
      }
    }
    if (typeof value === 'undefined') {
      return; // invalid path
    } else if (path.length == 1) {
      return value; // this was the tail of the path
    }

    // We're not at the end of the path, so we must dig deeper
    def = this._specs.dataElements.findByIdentifier(value.identifier);
    if (typeof def === 'undefined') {
      return; // invalid path
    }

    // First see if we can continue the path by traversing the value
    if (typeof def.value !== 'undefined') {
      const subValue = this.findValueByPath(path.slice(1), def, true, value.constraints);
      if (typeof subValue !== 'undefined') {
        return this.mergeConstraintsToChild(value, subValue, true);
      }
    }

    // Still haven't found it, so traverse the rest
    const subValue = this.findValueByPath(path.slice(1), def, false, value.constraints);
    if (typeof subValue !== 'undefined') {
      return this.mergeConstraintsToChild(value, subValue);
    }
  }

  // Given an identifier and a list of values, it will return the matching value, with all constraints aggregrated onto it
  findValueByIdentifier(identifier, values) {
    for (const value of values) {
      if (value instanceof mdls.IdentifiableValue && value.possibleIdentifiers.some(pid => pid.equals(identifier))) {
        return value;
      } else if (value instanceof mdls.ChoiceValue) {
        let opt = this.findValueByIdentifier(identifier, value.options);
        if (typeof opt !== 'undefined') {
          if (value.options.length > 1) {
            // Since this is an option in a choice, we should really make its lower cardinality 0, since it won't exist
            // when it is not chosen.
            opt = opt.clone().withMinMax(0, opt.card.max);
          }
          return this.mergeConstraintsToChild(value, opt);
        }
      }
    }
  }

  mergeConstraintsToChild(parentValue, childValue, childIsElementValue=false) {
    const constraints = [];
    for (const cst of parentValue.constraints) {
      if (childIsElementValue && cst.path.length == 0 && cst.onValue) {
        const transferredCst = cst.clone();
        transferredCst.onValue = false;
        constraints.push(transferredCst);
      } else if (cst.path.length > 0 && cst.path[0].equals(childValue.identifier)) { // TODO: Check on effectiveIdentifier?
        const transferredCst = cst.clone();
        transferredCst.path.shift(); // Remove the first element of the path since we're transferring this to the child
        constraints.push(transferredCst);
      }
    }
    if (constraints.length == 0) {
      return childValue;
    }
    const mergedChild = childValue.clone();
    for (const cst of mergedChild.constraints) {
      const siblings = new mdls.ConstraintsFilter(constraints).withPath(cst.path).constraints;
      if (siblings.some(c => c.constructor.name == cst.constructor.name)) {
        continue; // Don't add this constraint since the parent has the same type
      }
      constraints.push(cst);
    }
    mergedChild.constraints = constraints;
    return mergedChild;
  }

  getAggregateEffectiveCardinality(elementIdentifier, path) {
    const cards = [];
    const def = this._specs.dataElements.findByIdentifier(elementIdentifier);
    for (let i=0; i < path.length; i++) {
      const sourceValue = this.findValueByPath(path.slice(0, i+1), def);
      cards.push(sourceValue.effectiveCard);
    }
    return aggregateCardinality(...cards);
  }

  additionalQA(profile) {
    switch(profile.type) {
    case 'Basic':
      logger.warn('Element profiled on Basic. Consider a more specific mapping.');
      break;
    case 'Observation': {
      this.checkMappedAndConstrained(profile, 'code');
      this.checkMappedAndConstrained(profile, 'value[x]');
      break;
    }
    case 'Condition': {
      this.checkMappedAndConstrained(profile, 'code');
      break;
    }
    case 'AllergyIntolerance': {
      this.checkMappedAndConstrained(profile, 'code');
      break;
    }
    case 'Medication': {
      this.checkMappedAndConstrained(profile, 'code');
      break;
    }
    case 'MedicationStatement': {
      this.checkMappedAndConstrained(profile, 'medication[x]');
      break;
    }
    case 'MedicationRequest': {
      this.checkMappedAndConstrained(profile, 'medication[x]');
      break;
    }
    case 'ProcedureRequest': {
      this.checkMappedAndConstrained(profile, 'code');
      break;
    }
    }
  }

  checkMappedAndConstrained(profile, path) {
    const codeEl = common.getSnapshotElement(profile, path);
    let fqn = profile.identifier[0].value.split('.');
    let identifier = {'name': fqn.pop(),'namespace': fqn.join('.')};
    const def = this._specs.dataElements.findByIdentifier(identifier);

    if (codeEl.min == 0 && codeEl.max == '0') {
      // No need for mapping or constraints when it's profiled out
    } else if (this.elementTypeNotChanged(profile, codeEl)) {
      if (!def._isAbstract) {
        logger.warn('No mapping to \'%s\'. This property is core to the target resource and usually should be mapped.', path);
      } else {
        logger.info('Abstract Class: No mapping to \'%s\'. This property is core to the target resource and usually should be mapped.', path);
      }
    } else if (this.elementTypeUnconstrainedCode(profile, codeEl)) {
      // Allow this for "base" classes
      if (!profile.id.endsWith(`-${profile.type}`)) {
        if (!def._isAbstract) {
          logger.warn('The \'%s\' property is not bound to a value set, fixed to a code, or fixed to a quantity unit. This property is core to the target resource and usually should be constrained.', path);
        } else {
          logger.info('Abstract Class: The \'%s\' property is not bound to a value set or fixed to a code. This property is core to the target resource and usually should be constrained.', path);
        }
      }
    }
  }

  elementTypeNotChanged(profile, el) {
    const rEl = this.getOriginalElement(el);
    return simpleJSONEqual(el.type, rEl.type);
  }

  elementTypeUnconstrainedCode(profile, el) {
    const rEl = this.getOriginalElement(el);
    if (el.path.endsWith('[x]')) {
      // Find the corresponding element in the profile
      const pEl = profile.snapshot.element.find(e => e.path == el.path);
      // If it's not constrained, we need to check if any of the types are codish or quantities
      if (this.codeNotConstrained(pEl, rEl)) {
        const root = el.path.slice(0, -3); // e.g., root of Observation.value[x] is Observation.value
        // As we iterate through, if we find codish or quantity types, we need to check if perhaps they
        // are constrained in a slice.  For example, if value[x] had a CodeableConcept choice, we
        // need to also check the path for valueCodeableConcept.  So we setup a variable to collect
        // the unconstrained paths to check.
        const unconstrainedCodePaths = [];
        for (const t of pEl.type) {
          if (this.typeCodeIsCodishOrQuantity(t.code)) {
            // Push on the constructed slice path (e.g., Observation.valueCodeableConcept)
            unconstrainedCodePaths.push(root + t.code.charAt(0).toUpperCase() + t.code.slice(1));
          }
        }
        // If we didn't find any code/quantity paths, we don't care that there aren't any constraints
        if (unconstrainedCodePaths.length == 0) {
          return false; // false -- meaning there are NO unconstrained codes (double negative, ouch!)
        }
        // Now iterate through the profile elements, checking if any of those choice slice paths are constrained
        for (const pEl2 of profile.snapshot.element.filter(e => e.path.startsWith(root))) {
          const i = unconstrainedCodePaths.indexOf(pEl2.path);
          if (i >= 0) {
            // This element matches an unconstrained path, so check if it's still unconstrained
            const rEl2 = this.getOriginalElement(pEl2) || rEl;
            if (! this.codeNotConstrained(pEl2, rEl2)) {
              // Remove the path from the unconstrained code paths!
              unconstrainedCodePaths.splice(i, 1);
            }
          }
        }
        // If, by the end, there are unconstrainedCodePaths left, we need to report them as unconstrained
        return unconstrainedCodePaths.length > 0;
      }
    }
    // It's not a choice, so just do the direct check
    return this.elementTypeIsCodishOrQuantity(el) && this.codeNotConstrained(el, rEl);
  }

  elementTypeIsCodishOrQuantity(el) {
    return el.type && el.type.some(t => this.typeCodeIsCodishOrQuantity(t.code));
  }

  typeCodeIsCodishOrQuantity(typeCode) {
    return typeCode && ['code', 'Coding', 'CodeableConcept', 'Quantity'].indexOf(typeCode) >= 0;
  }

  codeNotConstrained(el, rEl) {
    return simpleJSONEqual(el.binding, rEl.binding) &&
           simpleJSONEqual(el.fixedCode, rEl.fixedCode) &&
           simpleJSONEqual(el.fixedCoding, rEl.fixedCoding) &&
           simpleJSONEqual(el.fixedCodeableConcept, rEl.fixedCodeableConcept) &&
           simpleJSONEqual(el.fixedQuantity, rEl.fixedQuantity) &&
           simpleJSONEqual(el.patternCode, rEl.patternCode) &&
           simpleJSONEqual(el.patternCoding, rEl.patternCoding) &&
           simpleJSONEqual(el.patternCodeableConcept, rEl.patternCodeableConcept) &&
           simpleJSONEqual(el.patternQuantity, rEl.patternQuantity);
  }

  // NOTE: This function only called if REPORT_PROFILE_INDICATORS is set to true
  addFixedValueIndicator(profile, path, value) {
    if (this._profileIndicators.has(profile.id)) {
      this._profileIndicators.get(profile.id).addFixedValue(path, value);
    }
  }

  getOriginalElement(el) {
    const [res, path] = el.path.split('.', 2);
    const resJSON = this._fhir.find(res);
    return common.getSnapshotElement(resJSON, path);
  }
}

class FieldTarget {
  constructor(target, commands=[], comments) {
    this._target = target;
    this._commands = commands;
    this._comments = comments;
  }

  static parse(ruleTarget) {
    const matches = /([^\s\(]+)(\s+\((.+)\))?(\s+\/\/\s*(.*))?/.exec(ruleTarget);
    if (matches == null || typeof matches[1] === 'undefined') {
      return;
    }
    const target = matches[1];
    let commands, comments;
    if (typeof matches[3] !== 'undefined') {
      commands = MappingCommand.parseMany(matches[3]);
    }
    if (typeof matches[5] !== 'undefined') {
      comments = matches[5];
    }
    return new FieldTarget(target, commands, comments);
  }

  get target() { return this._target; }
  get commands() { return this._commands; }
  get comments() { return this._comments; }

  // The "slice at" command indicates the path where the slicing is rooted.  This is only needed when the target
  // path is *not* where the root of the slice should be (for example, if the target is not multiple cardinality).
  hasSliceAtCommand() {
    return this._commands.some(c => c.key == 'slice at');
  }
  findSliceAtCommand() {
    return this._commands.find(c => c.key == 'slice at');
  }
  addSliceAtCommand(at) {
    this._commands.push(new MappingCommand('slice at', at));
  }

  // The "slice on" command indicates what FHIR calls the "discriminator path".
  hasSliceOnCommand() {
    return this._commands.some(c => c.key == 'slice on');
  }
  findSliceOnCommand() {
    return this._commands.find(c => c.key == 'slice on');
  }
  addSliceOnCommand(on) {
    this._commands.push(new MappingCommand('slice on', on));
  }

  // The "slice on type" command indicates what FHIR calls the "discriminator type".
  // If not set, the "value" type is typically used.
  hasSliceOnTypeCommand() {
    return this._commands.some(c => c.key == 'slice on type');
  }
  findSliceOnTypeCommand() {
    return this._commands.find(c => c.key == 'slice on type');
  }
  addSliceOnTypeCommand(on) {
    this._commands.push(new MappingCommand('slice on type', on));
  }

  // The "in slice" command is for elements to indicate what slice they belong to (by slice name).
  // This is not typically set in the mapping file, but rather, applied by the shr-fhir-export logic.
  hasInSliceCommand() {
    return this._commands.some(c => c.key == 'in slice');
  }
  findInSliceCommand() {
    return this._commands.find(c => c.key == 'in slice');
  }
  addInSliceCommand(sliceName) {
    this._commands.push(new MappingCommand('in slice', sliceName));
  }

  // The "slice strategy" command currently only supports one strategy: "includes".  If not set, then it slices
  // based on mappings that share target paths.
  hasSliceStrategyCommand() {
    return this._commands.some(c => c.key == 'slice strategy');
  }
  findSliceStrategyCommand() {
    return this._commands.find(c => c.key == 'slice strategy');
  }
  addSliceStrategyCommand(strategy) {
    this._commands.push(new MappingCommand('slice strategy', strategy));
  }

  toRuleTarget() {
    const commandStr = this._commands.length == 0 ? '' : ` (${this._commands.map(c => c.toString()).join('; ')})`;
    const commentsStr = typeof this._comments === 'undefined' ? '' : ` // ${this._comments}`;
    return `${this._target}${commandStr}${commentsStr}`;
  }
}

class MappingCommand {
  constructor(key, value) {
    this._key = key;
    this._value = value;
  }

  static parseSingle(command) {
    const [k, v] = command.split('=', 2).map(s => s.trim());
    return new MappingCommand(k, v);
  }

  static parseMany(commands) {
    return commands.split(';').map(c => MappingCommand.parseSingle(c));
  }

  get key() { return this._key; }
  get value() { return this._value; }

  toString() {
    return `${this._key} = ${this._value}`;
  }
}

// NOTE: This is not robust -- it is looking for JSON to be exactly same (in same order) -- which is fine for what we need
function simpleJSONEqual(a, b) {
  if (a == b) return true;
  if (!a || !b) return false;
  if ((typeof a) != (typeof b)) return false;
  if (typeof a == 'object') return JSON.stringify(a) == JSON.stringify(b);
  return a == b;
}

function pathsAreEqual(path1, path2) {
  if (path1.length != path2.length) {
    return false;
  }
  for (let i=0; i < path1.length; i++) {
    if (!path1[i].equals(path2[i])) {
      return false;
    }
  }
  return true;
}

function getAggregateFHIRElementCardinality(profile, element) {
  const cards = [];
  const parts = element.id.split('.');
  for (let i=1; i < parts.length; i++) {
    const el = common.getSnapshotElementById(profile, parts.slice(0, i+1).join('.'));
    cards.push(getFHIRElementCardinality(el));
  }
  return aggregateCardinality(...cards);
}

function getFHIRElementCardinality(element) {
  if (typeof element.min != 'undefined' && typeof element.max != 'undefined') {
    if (element.max == '*') {
      return new mdls.Cardinality(element.min);
    }
    return new mdls.Cardinality(element.min, parseInt(element.max, 10));
  }
}

function setCardinalityOnFHIRElements(card, snapshotEl, differentialEl, skipIfEqual=true) {
  const ssCard = getFHIRElementCardinality(snapshotEl);
  if (!skipIfEqual || !ssCard.equals(card)) {
    snapshotEl.min = differentialEl.min = card.min;
    snapshotEl.max = differentialEl.max = typeof card.max !== 'undefined' ? card.max.toString() : '*';
  }
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
    text += `  ${rule.toString()}\n`;
  }
  return text;
}

function typesToString(types) {
  const ts = types.map(t => {
    if (t.profile) {
      return `${t.code}<${t.profile}>`;
    } else if (t.targetProfile) {
      return `${t.code}<ref:${t.targetProfile}>`;
    }
    return t.code;
  });
  return `[${ts.join(', ')}]`;
}

// NOTE: This function only called if TRACK_UNMAPPED_PATHS is set to true
function unmappedPathTreeAsText(tree, currentPrefix) {
  let text = '';
  for (let [key, value] of tree) {
    if (key === '_has_mapped_children') {
      continue;
    }
    const name = key.substr(key.lastIndexOf('.')+1);
    const entry = currentPrefix ? `${currentPrefix}.${name}` : name;
    if (!(value instanceof Map) || !value.has('_has_mapped_children')) {
      text += `${entry}\n`;
    } else {
      text += unmappedPathTreeAsText(value, entry);
    }
  }
  return text;
}

function allowedBindingStrengthChange(originalStrength, newStrength) {
  switch (newStrength) {
  case originalStrength:
  case 'required':
    return true;
  case 'extensible':
    return originalStrength != 'required';
  case 'preferred':
    return originalStrength != 'required' && originalStrength != 'extensible';
  case 'example':
    return originalStrength == 'example';
  default:
    // this shouldn't happen, so trigger an error if it does
    return false;
  }
}

// NOTE: This class only used if REPORT_PROFILE_INDICATORS is set to true
class ProfileIndicators {
  constructor(profileURL, profileOn) {
    this._profileURL = profileURL;
    this._profileOn = profileOn;
    this._fixedValues = [];
  }

  get profileURL() { return this._profileURL; }
  get profileOn() { return this._profileOn; }
  get hasFixedValues() { return this._fixedValues.length > 0; }
  get fixedValues() { return this._fixedValues; }
  addFixedValue(path, value) {
    this._fixedValues.push(new ProfileFixedValueIndicator(path, value));
  }

  toJSON() {
    return {
      profile: this._profileURL,
      resource: this._profileOn,
      fixedValues: this._fixedValues.map(v => v.toJSON())
    };
  }
}

// NOTE: This class only used if REPORT_PROFILE_INDICATORS is set to true
class ProfileFixedValueIndicator {
  constructor(path, value) {
    this._path = path;
    this._value = value;
  }

  get path() { return this._path; }
  get value() { return this._value; }
  toJSON() {
    return { path: this._path, value: this._value };
  }
}

class Stack {
  constructor() {
    this._a = [];
  }

  push(item) {
    this._a.push(item);
  }

  pop() {
    return this._a.pop();
  }

  peekLast() {
    if (this._a.length > 0) {
      return this._a[this._a.length-1];
    }
  }

  isEmpty() {
    return this._a.length == 0;
  }
}

module.exports = {exportToFHIR, FHIRExporter, exportIG, setLogger};