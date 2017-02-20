const mdls = require('shr-models');
const load = require('./load');
const common = require('./common');
const {CodeSystemExporter} = require('./codeSystems');
const {ValueSetExporter} = require('./valueSets');
const {ExtensionExporter} = require('./extensions');
const {exportIG} = require('./ig');

const TARGET = 'FHIR_STU_3';
const ENTRY_ID = new mdls.Identifier('shr.base', 'Entry');

// Development purposes only to help see signal from noise
const disableError = {
  invalidTarget: false,
  externalCR: false,
  wideCardMapping: false,
  wideCardFieldMapping: false,
  ambiguousCardMapping: false,
  impossibleAggregateCardMapping: false,
  knownTypeIncompatibility: false,
  otherTypeIncompatibility: false
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
    this._extensionExporter = new ExtensionExporter(this._specs, this._fhir, TARGET);
    this._profiles = [];
    this._errors = [];
    this._idCounter = 1;
  }

  export() {
    this._codeSystemExporter.export();
    this._valueSetExporter.export();
    for (const entry of this._specs.dataElements.all) {
      const map = this._specs.maps.findByTargetAndIdentifier(TARGET, entry.identifier);
      if (typeof map === 'undefined') {
        //console.log(`No Mapping for ${entry.identifier.fqn}`);
        continue;
      }
      this.mappingToProfile(map);
    }
    return {
      profiles: this._profiles,
      extensions: this._extensionExporter.extensions,
      valueSets: this._valueSetExporter.valueSets,
      codeSystems: this._codeSystemExporter.codeSystems,
      errors: this._errors
    };
  }

  mappingToProfile(map) {
    const def = this._fhir.find(map.targetItem);
    if (typeof def === 'undefined') {
      console.error(`Invalid FHIR target: ${map.targetItem}`);
      return;
    }
    const profile = common.cloneJSON(def);
    delete(profile.meta);
    delete(profile.extension);
    profile.id = common.fhirID(map.identifier);
    profile.text = this.getText(map);
    profile.url = common.fhirURL(map.identifier);
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
      ssEl.id = ssEl.id.replace(new RegExp(`^${map.targetItem}`), `${map.targetItem}:${common.fhirID(map.identifier)}`);
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
    this.processMappingRules(map, profile);
    this.addExtensions(map, profile);

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

    this._profiles.push(profile);
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

  processMappingRules(map, profile) {
    // We want to process the rules by order of their targets to ensure parent targets are processed before children.
    // This is because it will make a difference when determining aggregate cardinalities.
    const rules = map.rules.slice(0).sort((a, b) => {
      if (a.target < b.target) {
        return -1;
      } else if (a.target > b.target) {
        return 1;
      }
      return 0;
    });

    for (const rule of rules) {
      if (rule instanceof mdls.CardinalityMappingRule) {
        this.processCardinalityMappingRule(map, rule, profile);
      } else if (rule.sourcePath.some(p => p instanceof mdls.TBD)) {
        continue;
      } else if (rule instanceof mdls.FieldMappingRule) {
        if (rule.target.startsWith('http://') || rule.target.startsWith('https://')) {
          this.processFieldToURLMappingRule(map, rule, profile);
        } else {
          this.processFieldToFieldMappingRule(map, rule, profile);
        }
      }
    }
  }

  processFieldToURLMappingRule(map, rule, profile) {
    // TODO: If part of the sourcepath points to a BackboneElement, should we put the extension there?  How does that
    // affect cardinality? Do we need a way in the mapping grammar to place extensions at certain points?
    const card = this.getEffectiveCardinality(map.identifier, rule.sourcePath);
    this.addExtension(profile, rule.sourcePath[rule.sourcePath.length-1], card, rule.targetURL);
  }

  processFieldToFieldMappingRule(map, rule, profile) {
    // TODO: Support slicing (somehow)
    const ss = common.getSnapshotElement(profile, rule.target);
    if (typeof ss === 'undefined') {
      // TODO: Actually handle this instead of just returning.  This will require handling the sub-elements and
      // doing constraints via fhirpath.  Ugh.
      const sses = this.getSnapshotElements(profile, rule.target);
      if (sses.length == 0) {
        if (!disableError.invalidTarget) this._errors.push(new FHIRExportError(`${profile.id}: Cannot apply field mapping to ${profile.type}.  Invalid target path: ${rule.target}`));
      }
      return;
    }

    if (typeof ss.type === 'undefined' && typeof ss.contentReference !== 'undefined') {
      // To profile a content reference, we must unroll it (see https://chat.fhir.org/#narrow/stream/implementers/topic/Profiling.20a.20contentReference)
      this.unrollContentReference(profile, ss);
    }

    let df = common.getDifferentialElement(profile, rule.target);
    const dfIsNew = (typeof df === 'undefined');
    if (dfIsNew) {
      df = {
        id: ss.id,
        path: ss.path
      };
    }

    this.processFieldToFieldCardinality(map, rule, profile, ss, df);
    this.processFieldToFieldType(map, rule, profile, ss, df);

    if (dfIsNew && Object.keys(df).length > 2) {
      profile.differential.element.push(df);
    }
  }

  unrollContentReference(profile, snapshotEl) {
    if (!snapshotEl.contentReference.startsWith('#')) {
      if (!disableError.externalCR) this._errors.push(new FHIRExportError(`${profile.id}: Unsupported: Unroll external contentReference ${snapshotEl.contentReference} on ${snapshotEl.id}`));
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
      if (!disableError.invalidTarget) this._errors.push(new FHIRExportError(`${profile.id}: ${snapshotEl.id} contains invalid contentReference ${snapshotEl.contentReference}`));
      return;
    }

    // If the thing we unrolled has children, then we need to insert them into the snapshot
    if (unrolled.length > 0) {
      const ssList = profile.snapshot.element;
      const unrolledIdx = ssList.findIndex(e => e.id == snapshotEl.id);
      profile.snapshot.element = [...ssList.slice(0, unrolledIdx + 1), ...unrolled, ...ssList.slice(unrolledIdx + unrolled.length + 1)];
    }
  }

  processCardinalityMappingRule(map, rule, profile) {
    const ss = common.getSnapshotElement(profile, rule.target);
    if (typeof ss === 'undefined') {
      if (!disableError.invalidTarget) this._errors.push(new FHIRExportError(`${profile.id}: Cannot apply cardinality constraint to ${profile.type}.  Invalid target path: ${rule.target}`));
      return;
    }

    let df = common.getDifferentialElement(profile, rule.target);
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
      if (!disableError.wideCardMapping) this._errors.push(new FHIRExportError(`${profile.id}: Cannot constrain ${profile.type}.${rule.target} (${targetCard}) to ${rule.cardinality.toString()}`));
    }

    if (dfIsNew && Object.keys(df).length > 2) {
      profile.differential.element.push(df);
    }
  }

  processFieldToFieldCardinality(map, rule, profile, snapshotEl, differentialEl) {
    // First handle cardinality.  Problems can arise when the target path is deeper than one because cardinalities
    // aggregate to get to the final (target) cardinality on the leaf of the path.  Unless there are mappings for
    // all of the intermediate paths, the correct way to constrain the cardinality is ambiguous.
    // (e.g., if Foo[0..4] maps to a[0..*].b[0..*], there are multiple ways to get a.b to have cardinality 0..4:
    // a[0..1].b[0..4], a[0..1].b[1..4], a[1..1].b[0..4], a[0..4].b[0..1], a[0..4].b[1..1], a[1..4].b[0..1]
    const aggSourceCard = this.getAggregateEffectiveCardinality(map.identifier, rule.sourcePath);
    const targetCard = getFHIRElementCardinality(snapshotEl);
    const targetPath = rule.target.split('.');
    if (targetPath.length == 1) {
      // Easiest case: Apply the source aggregate cardinality to the single target
      if (aggSourceCard.fitsWithinCardinalityOf(targetCard)) {
        setCardinalityOnFHIRElements(aggSourceCard, snapshotEl, differentialEl);
      } else {
        let srcAggStmt = '';
        if (rule.sourcePath.length > 1) {
          srcAggStmt = 'aggregates to ';
        }
        let tgtAggStmt = '';
        if (targetPath.indexOf('.') > 0) {
          tgtAggStmt = 'aggregates to ';
        }
        if (!disableError.wideCardFieldMapping) this._errors.push(new FHIRExportError(`${profile.id}: Incompatible cardinality since ${sourcePathToString(rule.sourcePath, true)} (${srcAggStmt}${aggSourceCard.toString()}) does not fit in ${profile.type}.${targetPath} (${tgtAggStmt}${targetCard})`));
        return;
      }
    } else {
      const aggTargetCard = getAggregateFHIRElementCardinality(profile.type, profile.snapshot.element, snapshotEl);
      if (aggSourceCard.equals(aggTargetCard)) {
        // For now we let it pass, but should we be checking to ensure all intermediate paths on target have profiled cardinality?
      } else if (aggSourceCard.fitsWithinCardinalityOf(aggTargetCard)) {
        // Check if all parts of target path are mapped.  If they aren't, then constraining the cardinality is ambiguous
        let isMatch = true;
        for (let i=0; i < targetPath.length; i++) {
          const tp = targetPath.slice(0, i+1).join('.');
          if (!map.rulesFilter.withTarget(tp).hasRules) {
            isMatch = false;
            break;
          }
        }
        if (!isMatch) {
          if (!disableError.ambiguousCardMapping) this._errors.push(new FHIRExportError(`${profile.id}: Cannot constrain ${profile.type}.${rule.target} to ${aggSourceCard.toString()} (from ${sourcePathToString(rule.sourcePath, true)}) because elements of its path are unconstrained, so cardinality placement is ambiguous.`));
          return;
        }

        // Whole target path is mapped so now we just have to try to apply a constraint to the last part of the path
        // that will get us to the cardinality we're looking for.
        const parentEl = common.getSnapshotElement(profile, targetPath.slice(0, -1).join('.'));
        const aggParentCard = getAggregateFHIRElementCardinality(profile.type, profile.snapshot.element, parentEl);

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
          if (!disableError.impossibleAggregateCardMapping) this._errors.push(new FHIRExportError(`${profile.id}: Cannot constrain ${profile.type}.${rule.target} to ${aggSourceCard.toString()} (from ${sourcePathToString(rule.sourcePath, true)}) (from ${sourcePathToString(rule.sourcePath, true)}) because there is no tail cardinality min that can get us there.`));
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
          if (!disableError.impossibleAggregateCardMapping) this._errors.push(new FHIRExportError(`${profile.id}: Cannot constrain ${profile.type}.${rule.target} to ${aggSourceCard.toString()} (from ${sourcePathToString(rule.sourcePath, true)}) because there is no tail cardinality max that can get us there.`));
          return;
        }

        const magicCard = new mdls.Cardinality(magicMin, magicMax);
        if (magicCard.fitsWithinCardinalityOf(targetCard)) {
          setCardinalityOnFHIRElements(magicCard, snapshotEl, differentialEl);
        } else {
          if (!disableError.impossibleAggregateCardMapping) this._errors.push(new FHIRExportError(`${profile.id}: Cannot constrain ${profile.type}.${rule.target} to ${aggSourceCard.toString()} (from ${sourcePathToString(rule.sourcePath, true)}) because there is no tail cardinality that can get us there.`));
          return;
        }
      }
    }
  }

  processFieldToFieldType(map, rule, profile, snapshotEl, differentialEl) {
    // Need to special case for mappings of Entry.* since Entry doesn't have to be a field of the source element
    let sourceIdentifier;
    if (rule.sourcePath[0].equals(ENTRY_ID)) {
      sourceIdentifier = this.getEffectiveIdentifier(ENTRY_ID, rule.sourcePath.slice(1));
    } else {
      sourceIdentifier = this.getEffectiveIdentifier(map.identifier, rule.sourcePath);
    }

    const match = this.processIdentifierToFieldType(sourceIdentifier, profile, snapshotEl, differentialEl);
    if (!match) {
      // collect some info for an AWESOME error message
      const sMapsTo = this._specs.maps.findByTargetAndIdentifier(TARGET, sourceIdentifier);
      const value = this._specs.dataElements.findByIdentifier(sourceIdentifier).value;
      let valueStatement = '';
      if (value instanceof mdls.IdentifiableValue) {
        valueStatement = ` (value: ${value.identifier.fqn})`;
      } else if (value) {
        valueStatement = ` (value: ${value.toString()})`;
      }
      const mapStatement = sMapsTo ? ` maps to ${sMapsTo.targetItem} but` : '';

      // Special error supression for known cases to be fixed at a later time
      if (this.knownMappingIssue('boolean', 'code', rule.sourcePath, value, snapshotEl.type)) {
        // Skip boolean to code errors for now
      } else if (this.knownMappingIssue('dateTime', 'date', rule.sourcePath, value, snapshotEl.type)) {
        // Skip dateTime to date errors for now
      } else if (this.knownMappingIssue('dateTime', 'instant', rule.sourcePath, value, snapshotEl.type)) {
        // Skip dateTime to instant errors for now
      } else if (this.knownMappingIssue('shr.actor.Person', 'Patient', rule.sourcePath, value, snapshotEl.type)) {
        // Skip Person to Patient errors for now
      } else if (this.knownMappingIssue('unsignedInt', 'positiveInt', rule.sourcePath, value, snapshotEl.type)) {
        // Skip unsignedInt to positiveInt errors for now
      } else {
        if (!disableError.otherTypeIncompatibility) this._errors.push(new FHIRExportError(`${profile.id}: Source path ${sourcePathToString(rule.sourcePath)}${valueStatement}${mapStatement} can't map to ${profile.type}.${rule.target} (types: ${typesToString(snapshotEl.type)}).`));
      }
    }
    return;
  }

  knownMappingIssue(lhs, rhs, sourcePath, value, types) {
    if (!disableError.knownTypeIncompatibility) {
      return false;
    }
    const identifier = sourcePath[sourcePath.length - 1];
    if (identifier.fqn == lhs || (value && value.identifier && value.identifier.fqn == lhs)) {
      // left-hand side is satisfied, now check right-hand side
      return types.some(t => t.code == rhs || t.targetProfile == (`http://hl7.org/fhir/StructureDefinition/${rhs}`));
    }
    return false;
  }

  processIdentifierToFieldType(sourceIdentifier, profile, snapshotEl, differentialEl) {
    const targetTypes = snapshotEl.type;

    // If the source is a primitive, then the target must be the same primitive!
    if (sourceIdentifier.isPrimitive) {
      const match = targetTypes.some(t => sourceIdentifier.name == t.code);
      if (match && sourceIdentifier.name == 'code') {
        // TODO: Apply any code constraint if applicable
      } else if (match && sourceIdentifier.name == 'boolean') {
        // TODO: Apply any boolean constraint if applicable
      }
      return match;
    }

    // It's a non-primitive source type.  First check if the field is mapped to a BackboneElement.
    if (targetTypes.length == 1 && targetTypes[0].code == 'BackboneElement') {
      // TODO: Determine what to do with backbone elements.  This signals that any source paths under it should put
      // the extension in the backbone rather than the root level.  This may also indicate a place where we need slices.
      // Until we figure out how to implement all that, just return true.
      return true;
    }

    // Check if the source has a mapping to a FHIR profile.  If so, and it matches target, apply the profile
    const sourceMap = this._specs.maps.findByTargetAndIdentifier(TARGET, sourceIdentifier);
    if (typeof sourceMap !== 'undefined') {
      let match = false;
      for (const t of targetTypes) {
        // TODO: For now, just add the profile to the existing type, but in future may need to constrain out unmapped types in a choice
        if (t.code == sourceMap.targetItem) {
          match = true;
          t.profile = common.fhirURL(sourceMap.identifier);
          break;
        } else if (t.code == 'Reference' && t.targetProfile == `http://hl7.org/fhir/StructureDefinition/${sourceMap.targetItem}`) {
          match = true;
          t.targetProfile = common.fhirURL(sourceMap.identifier);
          break;
        }
      }
      if (match) {
        // We modified the types, so we need to apply the differential
        differentialEl.type = snapshotEl.type;
        return true;
      }
      // It didn't have a match, so keep going to see if we can map on value instead
      // TODO: Determine if this really is the right approach (to fall through and keep going)
    }

    // If we got here, we still don't have a match, so now try the source's Value
    const sourceEl = this._specs.dataElements.findByIdentifier(sourceIdentifier);
    if (sourceEl && sourceEl.value) {
      if (sourceEl.value instanceof mdls.IdentifiableValue) {
        const match = this.processIdentifierToFieldType(sourceEl.value.identifier, profile, snapshotEl, differentialEl);
        // TODO: What about all the other fields in the sourceEl?
        return match;
      } else if (sourceEl.value instanceof mdls.ChoiceValue) {
        // TODO: For now just try to map what we can, but we need to determine how this *should* work
        for (const opt of sourceEl.value.aggregateOptions) {
          if (opt instanceof mdls.IdentifiableValue) {
            const match = this.processIdentifierToFieldType(opt.identifier, profile, snapshotEl, differentialEl);
            if (match) {
              return true;
            }
          }
        }
      }
    }

    // No match at all
    return false;

  }

  addExtensions(map, profile) {
    // Start simple (for now) -- just find base-level fields that are not mapped
    let hasExtensions = false;
    const def = this._specs.dataElements.findByIdentifier(map.identifier);
    for (const field of common.valueAndFields(def)) {
      if (field instanceof mdls.IdentifiableValue) {
        if (field.identifier.isPrimitive) {
          // ?
        } else if (!map.rules.some(r => r.sourcePath && r.sourcePath.length > 0 && r.sourcePath[0].equals(field.identifier))) {
          hasExtensions = true;
          this.addExtension(profile, field.identifier, field.effectiveCard);
        }
        // TODO: Should also dive into elements that are mapped and check if their sub-fields are mapped (recursively)
      } else {
        // TODO: Support choices
      }
    }

    // TODO: There are other places where we add extensions, so this logic probably should go somewhere else,
    // perhaps checking if any extensions were added after we've done everything
    if (hasExtensions) {
      const ssEl = common.getSnapshotElement(profile, 'extension');
      ssEl.slicing = {
        id: (this._idCounter++).toString(),
        discriminator: ['url'],
        ordered: false,
        rules: 'open'
      };
      // Apparently this does not need to be added to the differential
    }
  }

  addExtension(profile, identifier, card, extURL) {
    if (typeof extURL === 'undefined') {
      extURL = this._extensionExporter.lookupExtension(identifier).url;
    }
    const ssEl = common.cloneJSON(common.getSnapshotElement(profile, 'extension'));
    ssEl.id = `${ssEl.id}:${common.shortID(identifier)}`;
    ssEl.sliceName = common.shortID(identifier);
    ssEl.definition = this.getDescription(identifier, `SHR ${identifier.name} Extension`);
    delete(ssEl.short);
    delete(ssEl.comments);
    ssEl.min = card.min;
    ssEl.max = typeof card.max === 'undefined' ? '*' : card.max.toString();
    ssEl.type = [{ code : 'Extension', profile : extURL }];
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

  getSnapshotElements(profile, target) {
    // TODO: Refactor this function... it's just not pretty enough
    const targetParts = target.split('.');
    let i = targetParts.length-1;
    let ssEl;
    for (; i >= 0 && typeof ssEl === 'undefined'; i--) {
      const path = `${profile.type}.${targetParts.slice(0, i+1).join('.')}`;
      for (const el of profile.snapshot.element) {
        if (el.path == path) {
          ssEl = el;
          break;
        }
      }
    }
    if (typeof ssEl === 'undefined') {
      return [];
    } else if (ssEl.path == `${profile.id}.${target}`) {
      return [ssEl];
    }

    // We still have some leftover path.  First check if it's a choice.
    if (ssEl.path.endsWith('[x]')) {
      const pathOpt = targetParts[i+2];
      for (const t of ssEl.type) {
        if (t.code == pathOpt || t.profile == `http://hl7.org/fhir/StructureDefinition/${pathOpt}` || (t.code == 'Reference' && t.targetProfile == `http://hl7.org/fhir/StructureDefinition/${pathOpt}`)) {
          if (targetParts.length == i+3) {
            return [ssEl, pathOpt];
          } else {
            // We have a type.  Look it up and try to resolve the rest of the path
            let nestedItem = this._fhir.find(pathOpt);
            if (typeof nestedItem === 'undefined') {
              //console.error(`Invalid FHIR target: ${map.targetItem}`);
              return [];
            }
            const others = this.getSnapshotElements(common.cloneJSON(nestedItem), targetParts.slice(i+3).join('.'));
            if (others.length > 0) {
              return [ssEl, ...others];
            }
          }
        }
      }
    }

    // We still have some leftover path, so we should attempt to drill into it.
    let type;
    if (ssEl.type.length == 1) {
      if (ssEl.type[0].code == 'Reference' && ssEl.type[0].targetProfile.startsWith('http://hl7.org/fhir/StructureDefinition/')) {
        type = ssEl.type[0].targetProfile.slice(40);
      } else if (typeof ssEl.type[0].profile !== 'undefined') {
        type = ssEl.type[0].profile;
      } else  {
        type = ssEl.type[0].code;
      }
    } else {
      // For now, we don't support it
    }
    if (typeof type === 'undefined') {
      return [];
    }

    // We have a type.  Look it up and try to resolve the rest of the path
    let nestedItem = this._fhir.find(type);
    if (typeof nestedItem === 'undefined') {
      //console.error(`Invalid FHIR target: ${map.targetItem}`);
      return [];
    }
    const others = this.getSnapshotElements(common.cloneJSON(nestedItem), targetParts.slice(i+2).join('.'));
    if (others.length > 0) {
      return [ssEl, ...others];
    }
    return [];
  }

  // TODO: Should this be a function in the models?
  getEffectiveIdentifier(elementIdentifier, path) {
    if (path.length == 0) {
      return;
    }

    let match;
    const def = this._specs.dataElements.findByIdentifier(elementIdentifier);
    for (const value of common.valueAndFields(def)) {
      if (value instanceof mdls.IdentifiableValue) {
        if (value.identifier.equals(path[0])) {
          match = value;
          break;
        }
      } else if (value instanceof mdls.ChoiceValue) {
        for (const opt of value.aggregateOptions) {
          if (opt instanceof mdls.IdentifiableValue && opt.identifier.equals(path[0])) {
            match = opt;
            break;
          }
        }
      }
    }

    if (path.length == 1) {
      return match.effectiveIdentifier;
    } else {
      // Check if there are any deep path type constraints defined
      const typeConstraints = match.constraintsFilter.withPath(path.slice(1)).type.constraints;
      if (typeConstraints.length > 0) {
        return typeConstraints[typeConstraints.length - 1].isA;
      }
      // No deep path type constraints, so try at the next level of the path
      return this.getEffectiveIdentifier(match.identifier, path.slice(1));
    }
  }

  getAggregateEffectiveCardinality(elementIdentifier, path) {
    const cards = [];
    for (let i=0; i < path.length; i++) {
      cards.push(this.getEffectiveCardinality(elementIdentifier, path.slice(0, i+1)));
    }
    return aggregateCardinality(...cards);
  }

  // TODO: Should this be a function in the models?
  getEffectiveCardinality(elementIdentifier, path) {
    if (path.length == 0) {
      return;
    }

    // Need to special case for mappings of Entry.* since Entry doesn't have to be a field of the source element
    if (path[0].equals(ENTRY_ID)) {
      if (path.length == 1) {
        // The virtual entry field should be considered 1..1
        return new mdls.Cardinality(1, 1);
      }
      elementIdentifier = ENTRY_ID;
      path = path.slice(1);
    }

    let match;
    const def = this._specs.dataElements.findByIdentifier(elementIdentifier);
    for (const value of common.valueAndFields(def)) {
      if (value instanceof mdls.IdentifiableValue) {
        if (value.identifier.equals(path[0])) {
          match = value;
          break;
        }
      } else if (value instanceof mdls.ChoiceValue) {
        for (const opt of value.aggregateOptions) {
          if (opt instanceof mdls.IdentifiableValue && opt.identifier.equals(path[0])) {
            // Since it is an option in a choice, its effective min is actually 0 (in the case it is not chosen)
            const optCard = new mdls.Cardinality(0, opt.effectiveCard.max);
            const card = aggregateCardinality(value.effectiveCard, optCard);
            match = new mdls.IdentifiableValue(opt.identifier).withCard(card);
            break;
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
}

function getAggregateFHIRElementCardinality(targetItem, elements, element) {
  const cards = [];
  const parts = element.path.split('.');
  for (let i=1; i < parts.length; i++) {
    const el = common.getFHIRElement(targetItem, elements, parts.slice(1, i+1).join('.'));
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
    if (rule instanceof mdls.FieldMappingRule) {
      text += `  ${sourcePathToString(rule.sourcePath, simple)} maps to ${rule.target}\n`;
    } else if (rule instanceof mdls.CardinalityMappingRule) {
      text += `  ${rule.target} is ${rule.cardinality.toString()}\n`;
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

class FHIRExportError extends Error {
  constructor(message = 'FHIR export error') {
    super(message);
    this.message = message;   // from Error
    this.name = 'FHIRExportError'; // from Error
  }
}

module.exports = {exportToFHIR, FHIRExporter, exportIG: exportIG};