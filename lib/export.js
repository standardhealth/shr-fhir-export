const mdls = require('shr-models');
const load = require('./load');
const common = require('./common');
const qa = new (require('./qa').QA)();
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
  otherTypeIncompatibility: false,
  needsSlice: false
};

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
    this._errors = [];
    this._profileIndicators = new Map();
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
    this.lastQA();

    /*
    // A file showing profiles that have fixed values -- useful for trying to guess the profile, as in the FHIR Scorecard.
    console.log('--------------- PROFILE INDICATORS ------------------');
    const indicatorJSON = {};
    for (const [, p] of this._profileIndicators) {
      if (p.hasFixedValues) {
        indicatorJSON[p.profileURL] = p.toJSON();
      }
    }
    console.log(JSON.stringify(indicatorJSON, null, 2));
    console.log('-----------------------------------------------------');
    */

    return {
      profiles: this._profiles,
      extensions: this._extensionExporter.extensions,
      valueSets: this._valueSetExporter.valueSets,
      codeSystems: this._codeSystemExporter.codeSystems,
      errors: this._errors.concat(qa.toErrors()),
      qaHTML: qa.toHTML()
    };
  }

  mappingToProfile(map) {
    // We need to enhance the map so some implicit things are made explicit for easier processing
    const originalMap = map;
    map = this.enhanceMap(map);

    const profileID = common.fhirID(map.identifier);
    const profileURL = common.fhirURL(map.identifier);
    this._profileIndicators.set(profileID, new ProfileIndicators(profileURL, map.targetItem));

    const def = this._fhir.find(map.targetItem);
    if (typeof def === 'undefined') {
      this._errors.push(new common.FHIRExportError(`Invalid FHIR target: ${map.targetItem}`));
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
    this.processMappingRules(map, profile);
    this.addExtensions(map, profile);
    if (map.targetItem == 'Basic') {
      this.setCodeOnBasic(map, profile);
    }

    // When SHR specifies a choice value, remove the others!
    for (const el of profile.snapshot.element) {
      if (el.path.endsWith('[x]')) {
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
        common.addSlicingToBaseElement(ssEl, null, 'url');
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

    this._profiles.push(profile);

    return profile;
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
      this.addFixedValueIndicator(profile, ssEl.path, ssEl.patternCodeableConcept);
    }
  }

  enhanceMap(map) {
    // We're going to mess with things, so let's just clone the mapping now!
    map = map.clone();

    // TODO: This is nearly ready to support slices in slices (which hopefully never actually happen) -- but doesn't
    // yet go the extra mile to actually support it.
    const unslicedMap = new Map();
    const sliceOnMap = new Map();
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

        // Start a new slice in the slice group!
        const sliceName = common.fhirID(rule.sourcePath[rule.sourcePath.length-1]);
        t.addInSliceCommand(`${sliceTargetStack.peekLast()}[${sliceName}]`);
        sliceNameStack.pop();
        sliceNameStack.push(sliceName);
      } else if (!sliceTargetStack.isEmpty() && t.target.startsWith(sliceTargetStack.peekLast())) {
        // Put it in the slice
        t.addInSliceCommand(`${sliceTargetStack.peekLast()}[${sliceNameStack.peekLast()}]`);
      } else {
        let count = unslicedMap.has(t.target) ? unslicedMap.get(t.target) + 1 : 1;
        unslicedMap.set(t.target, count);
      }
      rule._target = t.toRuleTarget(); // BAD BAD BAD
    }

    if (!disableError.needsSlice) {
      const targets = Array.from(unslicedMap.keys()).filter(k => unslicedMap.get(k) > 1);
      for (const t of targets) {
        let needsSlice = targets.every(other => t == other || !t.startsWith(other));
        if (needsSlice) {
          this._errors.push(new common.FHIRExportError(`${common.fhirID(map.identifier)}: Contains mappings to ${t} that should be sliced`));
        }
      }
    }

    // We want to process the rules by order of their targets to ensure parent targets are processed before children.
    // This is because it will make a difference when determining aggregate cardinalities.
    map.rules.sort((a, b) => {
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
    for (const rule of map.rules) {
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
    const def = this._specs.dataElements.findByIdentifier(map.identifier);
    this.addExtension(def, profile, rule.sourcePath, rule.target);
  }

  processFieldToFieldMappingRule(map, rule, profile) {
    const def = this._specs.dataElements.findByIdentifier(map.identifier);
    if (typeof def === 'undefined') {
      this._errors.push(new common.FHIRExportError(`${profile.id}: Could not resolve source element ${map.identifier.fqn}`));
      return;
    }

    const ss = this.getSnapshotElementForFieldTarget(profile, FieldTarget.parse(rule.target));
    if (typeof ss === 'undefined') {
      this._errors.push(new common.FHIRExportError(`${profile.id}: Invalid or unsupported target path: ${rule.target}`));
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

    this.processFieldToFieldCardinality(map, rule, profile, ss, df);
    this.processFieldToFieldType(def, rule, profile, ss, df);

    if (dfIsNew && Object.keys(df).length > 2) {
      profile.differential.element.push(df);
    }
  }

  unrollContentReference(profile, snapshotEl) {
    if (!snapshotEl.contentReference.startsWith('#')) {
      if (!disableError.externalCR) this._errors.push(new common.FHIRExportError(`${profile.id}: Unsupported: Unroll external contentReference ${snapshotEl.contentReference} on ${snapshotEl.id}`));
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
      if (!disableError.invalidTarget) this._errors.push(new common.FHIRExportError(`${profile.id}: ${snapshotEl.id} contains invalid contentReference ${snapshotEl.contentReference}`));
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
      this._errors(new common.FHIRExportError(`${profile.id}: Cannot unroll [x] elements.  Must make explicit choice elements first: ${snapshotEl.id}`));
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
        if (typeof sdToAdd === 'undefined') {
          this._errors.push(`${profile.id}: Can't unroll ${identifier} at ${snapshotEl.id}`);
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
      // Only unroll this element if it's not unrolled already -- this happens now because we don't support slicing
      // in the mapping (for example, in BloodPressure and BodyMassIndex Observation.component.value[x])
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
      this._errors.push(new common.FHIRExportError(`Call to make choice explicit, but element is not an [x]: ${snapshotEl.id}`));
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
        this._errors.push(`${profile.id}: Can't make explicit choice of ${sourceIdentifier} at ${snapshotEl.id}`);
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
    common.addSlicingToBaseElement(snapshotEl, differentialEl, '@type');

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
      if (!disableError.invalidTarget) this._errors.push(new common.FHIRExportError(`${profile.id}: Cannot apply cardinality constraint to ${profile.type}.  Invalid target path: ${target}`));
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
      if (!disableError.wideCardMapping) this._errors.push(new common.FHIRExportError(`${profile.id}: Cannot constrain ${profile.type}.${target} (${targetCard}) to ${rule.cardinality.toString()}`));
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
    // a[0..1].b[0..4], a[0..1].b[1..4], a[1..1].b[0..4], a[0..4].b[0..1], a[0..4].b[1..1], a[1..4].b[0..1].
    // For this reason, ambiguous cardinalities in intermediate paths must be explicitly declared in the mapping file.
    const target = FieldTarget.parse(rule.target).target;
    const aggSourceCard = this.getAggregateEffectiveCardinality(map.identifier, rule.sourcePath);
    const targetCard = getFHIRElementCardinality(snapshotEl);
    const targetPath = target.split('.');
    if (targetPath.length == 1 || (targetPath.length == 2 && targetPath[0].endsWith('[x]')) ) {
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
        if (!disableError.wideCardFieldMapping) this._errors.push(new common.FHIRExportError(`${profile.id}: Incompatible cardinality since ${sourcePathToString(rule.sourcePath, true)} (${srcAggStmt}${aggSourceCard.toString()}) does not fit in ${profile.type}.${targetPath.join('.')} (${tgtAggStmt}${targetCard})`));
        return;
      }
    } else {
      const aggTargetCard = getAggregateFHIRElementCardinality(profile, snapshotEl);
      if (aggSourceCard.equals(aggTargetCard)) {
        // For now we let it pass, but should we be checking to ensure all intermediate paths on target have profiled cardinality?
      } else if (aggSourceCard.fitsWithinCardinalityOf(aggTargetCard)) {
        // Check if all parts of target path are mapped.  If they aren't, then constraining the cardinality is ambiguous
        let isMatch = true;
        for (let i=0; i < targetPath.length; i++) {
          const tp = targetPath.slice(0, i+1).join('.');
          if (tp.endsWith('[x]')) {
            // Due to our target path syntax, this looks like an intermediate path, but it isn't really
            continue;
          } else if (!map.rulesFilter.withTarget(tp).hasRules) {
            isMatch = false;
            break;
          }
        }
        if (!isMatch) {
          if (!disableError.ambiguousCardMapping) this._errors.push(new common.FHIRExportError(`${profile.id}: Cannot constrain ${profile.type}.${target} to ${aggSourceCard.toString()} (from ${sourcePathToString(rule.sourcePath, true)}) because elements of its path are unconstrained, so cardinality placement is ambiguous.`));
          return;
        }

        // Whole target path is mapped so now we just have to try to apply a constraint to the last part of the path
        // that will get us to the cardinality we're looking for.
        const numToSlice = targetPath[targetPath.length-2].endsWith('[x]') ? -2 : -1; // If this represents a choice option, we need to go back 2
        const parentEl = common.getSnapshotElement(profile, targetPath.slice(0, numToSlice).join('.'));
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
          if (!disableError.impossibleAggregateCardMapping) this._errors.push(new common.FHIRExportError(`${profile.id}: Cannot constrain ${profile.type}.${target} to ${aggSourceCard.toString()} (from ${sourcePathToString(rule.sourcePath, true)}) because there is no tail cardinality min that can get us there.`));
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
          if (!disableError.impossibleAggregateCardMapping) this._errors.push(new common.FHIRExportError(`${profile.id}: Cannot constrain ${profile.type}.${target} to ${aggSourceCard.toString()} (from ${sourcePathToString(rule.sourcePath, true)}) because there is no tail cardinality max that can get us there.`));
          return;
        }

        const magicCard = new mdls.Cardinality(magicMin, magicMax);
        if (magicCard.fitsWithinCardinalityOf(targetCard)) {
          setCardinalityOnFHIRElements(magicCard, snapshotEl, differentialEl);
        } else {
          if (!disableError.impossibleAggregateCardMapping) this._errors.push(new common.FHIRExportError(`${profile.id}: Cannot constrain ${profile.type}.${target} to ${aggSourceCard.toString()} (from ${sourcePathToString(rule.sourcePath, true)}) because there is no tail cardinality that can get us there.`));
          return;
        }
      }
    }
  }

  processFieldToFieldType(def, rule, profile, snapshotEl, differentialEl) {
    const sourceValue = this.findValueByPath(rule.sourcePath, def);
    const match = this.processValueToFieldType(sourceValue, profile, snapshotEl, differentialEl);
    if (!match) {
      // collect some info for an AWESOME error message
      const sMapsTo = this._specs.maps.findByTargetAndIdentifier(TARGET, sourceValue.effectiveIdentifier);
      const value = this._specs.dataElements.findByIdentifier(sourceValue.effectiveIdentifier).value;
      let valueStatement = '';
      if (value instanceof mdls.IdentifiableValue) {
        valueStatement = ` (value: ${value.identifier.fqn})`;
      } else if (value) {
        valueStatement = ` (value: ${value.toString()})`;
      }
      const mapStatement = sMapsTo ? ` maps to ${sMapsTo.targetItem} but` : '';

      // TODO: Adjust to support allowable "conversions"
      // Special error supression for known cases to be fixed at a later time
      if (this.knownMappingIssue('shr.actor.Person', 'Patient', rule.sourcePath, value, snapshotEl.type)) {
        // Skip Person to Patient errors for now
      } else if (this.knownMappingIssue('unsignedInt', 'positiveInt', rule.sourcePath, value, snapshotEl.type)) {
        // Skip unsignedInt to positiveInt errors for now
      } else {
        const target = FieldTarget.parse(rule.target).target;
        if (!disableError.otherTypeIncompatibility) this._errors.push(new common.FHIRExportError(`${profile.id}: Source path ${sourcePathToString(rule.sourcePath)}${valueStatement}${mapStatement} can't map to ${profile.type}.${target} (types: ${typesToString(snapshotEl.type)}).`));
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

  conversionIsAllowed(sourceIdentifier, targetTypes) {
    // TODO: Should we consider the sourceIdentifier's basedOn elements as well?
    const fqn = sourceIdentifier.fqn;
    if (Array.isArray(allowedConversions[fqn])) {
      const allowed = allowedConversions[fqn].some(a => {
        return targetTypes.some(t => t.code == a || t.targetProfile == (`http://hl7.org/fhir/StructureDefinition/${a}`));
      });
      if (allowed) {
        return true;
      }
    }
    return false;
  }

  processValueToFieldType(sourceValue, profile, snapshotEl, differentialEl) {
    const sourceIdentifier = sourceValue.effectiveIdentifier;
    const targetTypes = snapshotEl.type;

    // If the source is a primitive, then the target must be the same primitive!
    if (sourceIdentifier.isPrimitive) {
      const match = targetTypes.some(t => sourceIdentifier.name == t.code);
      if (match) {
        this.applyConstraints(sourceValue, profile, snapshotEl, differentialEl, false);
        return true;
      } else if (this.conversionIsAllowed(sourceIdentifier, targetTypes)) {
        this.applyConstraintsForConversion(sourceValue, profile, snapshotEl, differentialEl);
        return true;
      }
      return false;
    }

    // It's a non-primitive source type.  First check if the field is mapped to a BackboneElement.
    if (targetTypes.length == 1 && targetTypes[0].code == 'BackboneElement') {
      // TODO: Determine what to do with backbone elements.  This signals that any source paths under it should put
      // the extension in the backbone rather than the root level.  This may also indicate a place where we need slices.
      // Until we figure out how to implement all that, just return true.
      return true;
    }

    // Check if the source field has a mapping to a FHIR profile.  If so, and it matches target, apply the profile to the target
    const sourceMap = this._specs.maps.findByTargetAndIdentifier(TARGET, sourceIdentifier);
    if (typeof sourceMap !== 'undefined') {
      let match = false;
      const allowableTargetTypes = this.getTypeHierarchy(sourceMap.targetItem);
      const allowableTargetProfiles = allowableTargetTypes.map(t => `http://hl7.org/fhir/StructureDefinition/${t}`);
      for (const t of targetTypes) {
        if (allowableTargetTypes.includes(t.code)) {
          match = true;
          t.profile = common.fhirURL(sourceMap.identifier);
          break;
        } else if (t.code == 'Reference' && allowableTargetProfiles.includes(t.targetProfile)) {
          match = true;
          t.targetProfile = common.fhirURL(sourceMap.identifier);
          break;
        }
      }
      if (match) {
        // We modified the types, so we need to apply the differential
        differentialEl.type = snapshotEl.type;
        this.applyConstraints(sourceValue, profile, snapshotEl, differentialEl, false);
        return true;
      } else if (this.conversionIsAllowed(sourceIdentifier, targetTypes)) {
        this.applyConstraintsForConversion(sourceValue, profile, snapshotEl, differentialEl);
        return true;
      }
      // It didn't have a match, so keep going to see if we can map on value instead
      // TODO: Determine if this really is the right approach (to fall through and keep going)
    }

    // If we got here, we still don't have a match, so now try the source's Value
    const sourceEl = this._specs.dataElements.findByIdentifier(sourceIdentifier);
    if (sourceEl && sourceEl.value) {
      if (sourceEl.value instanceof mdls.IdentifiableValue) {
        const mergedValue = this.mergeConstraintsToChild(sourceValue, sourceEl.value, true);
        const match = this.processValueToFieldType(mergedValue, profile, snapshotEl, differentialEl);
        // TODO: What do we do with all non-value fields when mapping a value?
        return match;
      } else if (sourceEl.value instanceof mdls.ChoiceValue) {
        // TODO: For now just try to map what we can, but we need to determine how this *should* work
        for (const opt of sourceEl.value.aggregateOptions) {
          if (opt instanceof mdls.IdentifiableValue) {
            // First merge the choicevalue onto the option value (TODO: Will this work right w/ aggregate options?)
            let mergedValue = this.mergeConstraintsToChild(sourceEl.value, opt);
            // Then merge the sourceValue onto the merged option value
            mergedValue = this.mergeConstraintsToChild(sourceValue, mergedValue);
            const match = this.processValueToFieldType(mergedValue, profile, snapshotEl, differentialEl);
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

    // TODO: None of these take into account slicing...  so they will report conflicts when things should be sliced
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
            this._errors.push(new common.FHIRExportError(`${profile.id}: Failed to resolve element path from ${snapshotEl.id} to ${path}`));
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
        //console.log(JSON.stringify(sourceValue.constraintsFilter.child.constraints));
      } else {
        this._errors.push(new common.FHIRExportError(`${profile.id}: Applying constraints to profiled children not yet supported.  SHR doesn't have a use case yet.`));
        /*
        // Get the target element's mapping since we'll need to know how to drill into it
        const sourceValueMapping = this._specs.maps.findByTargetAndIdentifier(TARGET, sourceValue.effectiveIdentifier);
        if (typeof sourceValueMapping === 'undefined') {
          // I don't think this can ever happen, but just in case
          this._errors.push(new common.FHIRExportError(`${profile.id}: Can't apply child constraints since there is no mapping for ${sourceValue.identifier}`));
          return;
        }
        // Iterate by path
        for (const csts of pathToConstraintMap.values()) {
          const path = csts[0].path;
          for (const cst of csts) {
            const rule = sourceValueMapping.rules.find(r => {
              return r instanceof mdls.FieldMappingRule && common.equalShrElementPaths(path, r.sourcePath);
            });
            if (typeof rule === 'undefined') {
              console.error('ACKS 2!', sourceValue.effectiveIdentifier, path, cst.constructor.name);
            }
          }
        }
        */
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
    //let extension = this._extensionExporter.lookupExtension(shrPath[0]);
    //const isSimple = common.getSnapshotElement(extension, 'extension').max == '0';
    const isSimple = profile.snapshot.element.find(e => e.id.startsWith(`${snapshotEl.id}.value`)).max == '1';
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
      this._errors.push(new common.FHIRExportError(`${profile.id}: Failed to resolve path from ${snapshotEl.id} to ${shrPath}`));
    }
    return this.getElementInExtension(shrPath.slice(1), profile, el);
  }

  applyOwnValueSetConstraints(sourceValue, profile, snapshotEl, differentialEl) {
    const vsConstraints = sourceValue.constraintsFilter.own.valueSet.constraints;
    if (vsConstraints.length > 0) {
      const vs = vsConstraints[0].valueSet;
      if (vs.startsWith('urn:tbd')) {
        // Skip TBD value set
        return;
      }
      const bind = snapshotEl.binding;
      if (bind) {
        if ((bind.valueSetReference && bind.valueSetReference.reference == vs) || bind.valueSetUri == vs) {
          // It's already bound to this same value set, so there's nothing to do
          return;
        } else if (bind.strength == 'required') {
          const bindVS = bind.valueSetReference ? bind.valueSetReference.reference : bind.valueSetUri;
          qa.overrideConstraint('value set', bindVS, vs, profile.id, snapshotEl.path);
          return;
        }
      }
      snapshotEl.binding = differentialEl.binding = {
        strength : 'required',
        valueSetReference : {
          reference : vsConstraints[0].valueSet
        }
      };
      if (vsConstraints.length > 1) {
        this._errors.push(new common.FHIRExportError(`${profile.id}: Found more than one value set to apply to ${snapshotEl.id}.  This should never happen and is probably a bug in the tool.`));
      }
    }
  }

  applyOwnCodeConstraints(sourceValue, profile, snapshotEl, differentialEl) {
    const codeConstraints = sourceValue.constraintsFilter.own.code.constraints;
    if (codeConstraints.length > 0) {
      this.fixCodeOnElement(sourceValue, profile, snapshotEl, differentialEl, codeConstraints[0].code);
      if (codeConstraints.length > 1) {
        this._errors.push(new common.FHIRExportError(`${profile.id}: Found more than one code to fix on ${snapshotEl.id}.  This should never happen and is probably a bug in the tool.`));
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
      this.fixCodeOnElement(sourceValue, profile, sliceSnapshotEl, sliceDifferentialEl, code, false);

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
        common.addSlicingToBaseElement(snapshotEl, differentialEl, 'value');
        break;
      case 'shr.core.Coding':
      case 'shr.core.Quantity':
        common.addSlicingToBaseElement(snapshotEl, differentialEl, 'system', 'code');
        break;
      case 'shr.core.CodeableConcept':
        common.addSlicingToBaseElement(snapshotEl, differentialEl, 'coding');
        break;
      default:
        this._errors.push(new common.FHIRExportError(`${profile.id}: Can't fix code on ${snapshotEl.id} because source value isn't code-like: ${sourceValue.identifier}.  This should never happen and is probably a bug in the tool.`));
        return;
      }
    }
  }

  fixCodeOnElement(sourceValue, profile, snapshotEl, differentialEl, code, usePattern=true) {
    if (code.system == 'urn:tbd') {
      // Skip TBD code
      return;
    }
    const prefix = usePattern ? 'pattern' : 'fixed';
    // Different behavior based on sourceValue type
    let property, value, matches;
    switch (sourceValue.identifier.fqn) {
    case 'code':
      property = 'fixedCode';
      value = code.code;
      matches = (ssValue) => ssValue = code.code;
      break;
    case 'shr.core.Coding':
      property = `${prefix}Coding`;
      value = { system: code.system, code: code.code };
      matches = (ssValue) => ssValue.system == code.system && ssValue.code == code.code;
      break;
    case 'shr.core.CodeableConcept':
      property = `${prefix}CodeableConcept`;
      value = { coding: [{ system: code.system, code: code.code }] };
      matches = (ssValue) => ssValue.coding && ssValue.coding.length == 1 && ssValue.coding[0].system == code.system && ssValue.coding[0].code == code.code;
      break;
    case 'shr.core.Quantity':
      property = `${prefix}Quantity`;
      value = { system: code.system, code: code.code };
      matches = (ssValue) => ssValue.system == code.system && ssValue.code == code.code;
      break;
    }

    if (typeof property === 'undefined') {
      this._errors.push(new common.FHIRExportError(`${profile.id}: Can't fix code on ${snapshotEl.id} because source value isn't code-like: ${sourceValue.identifier}.  This should never happen and is probably a bug in the tool.`));
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
        qa.overrideConstraint('code', snapshotEl[key], value, profile.id, snapshotEl.path);
        return;
      }
    }

    // If we made it this far, we can set the fixed value
    snapshotEl[property] = differentialEl[property] = value;
    this.addFixedValueIndicator(profile, snapshotEl.path, value);
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
        qa.overrideConstraint('boolean', snapshotEl.fixedBoolean, value, profile.id, snapshotEl.path);
        return;
      }
      snapshotEl.fixedBoolean = differentialEl.fixedBoolean = value;
      this.addFixedValueIndicator(profile, snapshotEl.path, value);
      if (boolConstraints.length > 1) {
        this._errors.push(new common.FHIRExportError(`${profile.id}: Found more than one boolean to fix on ${snapshotEl.id}.  This should never happen and is probably a bug in the tool.`));
      }
    }
  }

  // This function applies applicable constraints when there is a non-trival conversion -- and warns if constraints will be dropped.
  applyConstraintsForConversion(sourceValue, profile, snapshotEl, differentialEl) {
    const sourceIdentifier = sourceValue.effectiveIdentifier;
    const targetTypes = snapshotEl.type;

    if (sourceValue.constraintsFilter.own.boolean.hasConstraints) {
      // There's no conversion that can support boolean constraints
      qa.conversionDropsConstraint('boolean', sourceIdentifier.fqn, targetTypes, profile.id, snapshotEl.path);
    } else {
      const targetAllowsCodeConstraints = targetTypes.some(t => t.code == 'code' || t.code == 'Coding' || t.code == 'CodeableConcept' || t.code == 'string');
      if (targetAllowsCodeConstraints) {
        this.applyOwnValueSetConstraints(sourceValue, profile, snapshotEl, differentialEl);
        this.applyOwnCodeConstraints(sourceValue, profile, snapshotEl, differentialEl);
        // this.applyCodeIncludesConstraints(sourceValue, profile, snapshotEl, differentialEl);
        return;
      }
      if (sourceValue.constraintsFilter.own.valueSet.hasConstraints) {
        qa.conversionDropsConstraint('value set', sourceIdentifier.fqn, targetTypes, profile.id, snapshotEl.path);
      }
      if (sourceValue.constraintsFilter.own.code.hasConstraints) {
        qa.conversionDropsConstraint('code', sourceIdentifier.fqn, targetTypes, profile.id, snapshotEl.path);
      }
      if (sourceValue.constraintsFilter.own.includesCode.hasConstraints) {
        qa.conversionDropsConstraint('includes code', sourceIdentifier.fqn, targetTypes, profile.id, snapshotEl.path);
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
    let p = this._profiles.find(p => p.id == common.fhirID(identifier, false));
    if (typeof p === 'undefined' && createIfNeeded) {
      const mapping = this._specs.maps.findByTargetAndIdentifier(TARGET, identifier);
      if (typeof mapping !== 'undefined') {
        // Warning -- there CAN be a circular dependency here -- so watch out!  I warned you...
        p = this.mappingToProfile(mapping);
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

  getSnapshotElementForFieldTarget(profile, fieldTarget) {
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

    let path = parts.join('.');
    const elements = profile.snapshot.element.filter(e => e.path == path);
    if (elements.length == 0) {
      return;
    }

    let element;
    // If this field target requests a new slice section or indicates it's in a slice, we need to do some magic
    if (fieldTarget.hasSliceOnCommand()) {
      const baseElement = elements[0];

      // Apply the discriminator to the base element in the snapshot and the differential
      common.addSlicingToBaseElement(baseElement, null, fieldTarget.findSliceOnCommand().value);
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
        this._errors.push(new common.FHIRExportError(`${profile.id}: no slice name supplied for target: ${fieldTarget.toString()}`));
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
      // The base slice section element has slicing (from the copy), but we don't need to repeat that
      delete(sliceSection[0].slicing);
      sliceSection[0].sliceName = sliceName;
      // Add the differential w/ the sliceName
      profile.differential.element.push({ id: sliceSection[0].id, path: sliceSection[0].path, sliceName: sliceName });

      // Find the insertion point, which should be at the end of any current slices
      let i = profile.snapshot.element.findIndex(e => e == baseElement) + 1;
      for ( ; i < profile.snapshot.element.length && profile.snapshot.element[i].path.startsWith(baseElement.path); i++);
      // Insert the section
      profile.snapshot.element.splice(i, 0, ...sliceSection);

      element = profile.snapshot.element[i];
    } else if (elements.length > 1) {
      if (fieldTarget.hasInSliceCommand()) {
        const [/*match*/,/*path*/,sliceName] = /(.*)\s*\[(.*)\]/.exec(fieldTarget.findInSliceCommand());
        element = elements.find(s => {
          return profile.snapshot.element.some(e => s.id.startsWith(e.id) && e.sliceName == sliceName);
        });
        if (typeof element === 'undefined') {
          this._errors.push(new common.FHIRExportError(`${profile.id}: Couldn't find target ${fieldTarget.target} in slice ${sliceName}`));
          element = elements[0];
        }
      } else {
        this._errors.push(new common.FHIRExportError(`${profile.id}: Target resolves to multiple elements but is not sliced: ${fieldTarget.target}`));
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
  findValueByPath(path, def, valueOnly=false) {
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
    const value = this.findValueByIdentifier(path[0], valuesToSearch);
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
      const subValue = this.findValueByPath(path.slice(1), def, true);
      if (typeof subValue !== 'undefined') {
        return this.mergeConstraintsToChild(value, subValue, true);
      }
    }

    // Still haven't found it, so traverse the rest
    const subValue = this.findValueByPath(path.slice(1), def);
    if (typeof subValue !== 'undefined') {
      return this.mergeConstraintsToChild(value, subValue);
    }
  }

  // Given an identifier and a list of values, it will return the matching value, with all constraints aggregrated onto it
  findValueByIdentifier(identifier, values) {
    for (const value of values) {
      if (value instanceof mdls.IdentifiableValue && value.identifier.equals(identifier)) {
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

  lastQA() {
    for (const p of this._profiles) {
      switch(p.type) {
      case 'Basic':
        qa.basic(p.id);
        break;
      case 'Observation': {
        this.qaCheckMappedAndConstrained(p, 'code');
        this.qaCheckMappedAndConstrained(p, 'value[x]');
        break;
      }
      case 'Condition': {
        this.qaCheckMappedAndConstrained(p, 'code');
        break;
      }
      case 'AllergyIntolerance': {
        this.qaCheckMappedAndConstrained(p, 'code');
        break;
      }
      case 'Medication': {
        this.qaCheckMappedAndConstrained(p, 'code');
        break;
      }
      case 'MedicationStatement': {
        this.qaCheckMappedAndConstrained(p, 'medication[x]');
        break;
      }
      case 'MedicationRequest': {
        this.qaCheckMappedAndConstrained(p, 'medication[x]');
        break;
      }
      case 'ProcedureRequest': {
        this.qaCheckMappedAndConstrained(p, 'code');
        break;
      }
      }
    }
  }

  qaCheckMappedAndConstrained(profile, path) {
    const codeEl = common.getSnapshotElement(profile, path);
    if (this.elementTypeNotChanged(profile, codeEl)) {
      qa.propertyNotMapped(`${profile.type}.${path}`, profile.id, codeEl.path);
    } else if (this.elementTypeUnconstrainedCode(profile, codeEl)) {
      // Allow this for "base" classes
      if (!profile.id.endsWith(`-${profile.type}`)) {
        qa.codeNotConstrained(`${profile.type}.${path}`, profile.id, codeEl.path);
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
      const root = el.path.slice(0, -3);
      let unconstrained = true;
      for (const pEl of profile.snapshot.element) {
        if (pEl.path.startsWith(root) && this.elementTypeIsCodishOrQuantity(pEl)) {
          unconstrained = unconstrained && this.codeNotConstrained(pEl, rEl);
        }
      }
      return unconstrained;
    }
    return this.elementTypeIsCodishOrQuantity(el) && this.codeNotConstrained(el, rEl);
  }

  elementTypeIsCodishOrQuantity(el) {
    return el.type && el.type.some(t => ['code', 'Coding', 'CodeableConcept', 'Quantity'].includes(t.code));
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
    const matches = /([^\s\(]+)(\s+\(([^\)]+)\))?(\s+\/\/\s*(.*))?/.exec(ruleTarget);
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

  hasSliceOnCommand() {
    return this._commands.some(c => c.key == 'slice on');
  }
  findSliceOnCommand() {
    return this._commands.find(c => c.key == 'slice on');
  }
  addSliceOnCommand(on) {
    this._commands.push(new MappingCommand('slice on', on));
  }

  hasInSliceCommand() {
    return this._commands.some(c => c.key == 'in slice');
  }
  findInSliceCommand() {
    return this._commands.find(c => c.key == 'in slice');
  }
  addInSliceCommand(sliceName) {
    this._commands.push(new MappingCommand('in slice', sliceName));
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

module.exports = {exportToFHIR, FHIRExporter, exportIG: exportIG};