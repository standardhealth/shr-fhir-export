const bunyan = require('bunyan');
const mdls = require('shr-models');
const load = require('./load');
const common = require('./common');
const MVH = require('./multiVersionHelper');
const {FieldTarget} = require('./common');
const {insertElementInSnapshot, insertElementInDifferential} = require ('./insertElement');
const {CodeSystemExporter} = require('./codeSystems');
const {ValueSetExporter} = require('./valueSets');
const {ExtensionExporter} = require('./extensions');
const {ModelsExporter} = require('./logical/export');
const {exportIG} = require('./ig');

const TARGETS = ['FHIR_DSTU_2', 'FHIR_STU_3', 'FHIR_R4'];
const CONCEPT_ID = new mdls.PrimitiveIdentifier('concept');

// The following two constants toggle advanced developer features, usually not needed
// or wanted (since they cause performance degradation).
const TRACK_UNMAPPED_PATHS = false;
const REPORT_PROFILE_INDICATORS = false;

var rootLogger = bunyan.createLogger({name: 'shr-fhir-export'});
var logger = rootLogger;
function setLogger(bunyanLogger) {
  rootLogger = logger = bunyanLogger;
  require('./logical/export.js').setLogger(logger);
  require('./extensions.js').setLogger(logger);
  require('./ig.js').setLogger(logger);
}

const allowedConversions = {
  'boolean': ['code'],
  'dateTime': ['date', 'instant'],
  'positiveInt': ['unsignedInt', 'integer', 'decimal', 'Quantity'],
  'unsignedInt': ['integer', 'decimal', 'Quantity'],
  'integer': ['Quantity', 'decimal'],
  'markdown': ['string'],
  'uri': ['canonical', 'url'], // should we support uri --> canonical?
  'concept': ['CodeableConcept', 'Coding', 'code']
};

function exportToFHIR(specifications, configuration) {
  const exporter = new FHIRExporter(specifications, configuration);
  return exporter.export();
}

class FHIRExporter {
  constructor(specifications, configuration = {}) {
    this._specs = specifications;
    this._target = common.getTarget(configuration, this._specs);
    this._fhir = load(this._target);
    this._codeSystemExporter = new CodeSystemExporter(this._specs, this._fhir, configuration);
    this._valueSetExporter = new ValueSetExporter(this._specs, this._fhir, configuration);
    this._extensionExporter = new ExtensionExporter(this, this._specs, this._fhir, this._target, configuration);
    this._modelsExporter = new ModelsExporter(this._specs, this._fhir, configuration);
    this._profilesMap = new Map();
    if (REPORT_PROFILE_INDICATORS) {
      this._profileIndicators = new Map();
    }
    if (TRACK_UNMAPPED_PATHS) {
      this._unmappedPaths = new Map();
    }
    this._config = configuration;
    this._processTracker = new common.ProcessTracker();
  }

  // The process tracker is used to keep track of what profiles are currently being processed.  This allows us to
  // check for possible issues when looking up and using a profile that is currently mid-process.
  get processTracker() {
    return this._processTracker;
  }

  export() {
    // 03007, 'Exporting FHIR using target: ${target}',,
    logger.info({ target: this._target }, '03007');
    if (!(this._target === 'FHIR_DSTU_2')) {
      this._codeSystemExporter.export();
    }
    this._valueSetExporter.export();
    // TODO: Add support for models in DSTU2
    if (this._target !== 'FHIR_DSTU_2') {
      this._modelsExporter.export();
    }

    // Create mappings to Basic for all unmapped entries
    for (const entry of this._specs.dataElements.entries) {
      const map = this._specs.maps.findByTargetAndIdentifier(this._target, entry.identifier);
      if (typeof map === 'undefined') {
        this._specs.maps.add(new mdls.ElementMapping(entry.identifier, this._target, 'Basic'));
      }
    }
    // Iterate through the elements and do the mappings
    for (const element of this._specs.dataElements.all) {
      const map = this._specs.maps.findByTargetAndIdentifier(this._target, element.identifier);
      if (typeof map === 'undefined') {
        continue;
      } else if (typeof this.lookupProfile(map.identifier, false, false, true) !== 'undefined') {
        continue;
      }
      try {
        this.mappingToProfile(map);
      } catch (e) {
        //13049 , 'Unexpected error processing mapping to FHIR. Error is ${errorText}' , 'Unknown' , 'errorNumber'
        logger.error({errorText: e.stack },'13049');
      }
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
        // 03008, 'Unmapped fields in [ ${elements} ]:\n${fields}', 'Map fields to FHIR properties or to extensions', 'errorNumber'
        logger.info({ elements: elements.join(', '), fields: text }, '03008');
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
      // 03009, 'Profile Indicators JSON: ${profileIndicators}',,
      logger.info({ profileIndicators: JSON.stringify(indicatorJSON, null, 2) }, '03009');
    }

    // Delete intermediate variables
    const profiles = Array.from(this._profilesMap.values()).filter(p => common.isCustomProfile(p));
    // For use in shr-es6-export, create a noDiffProfiles array as well, so profiles that only
    // Contain mapping differences can be exported
    const noDiffProfiles = Array.from(this._profilesMap.values()).filter(p => !common.isCustomProfile(p));
    for (const p of profiles) {
      delete(p._shr);
    }
    for (const p of noDiffProfiles) {
      delete (p._shr);
    }

    const extensions = this._extensionExporter.extensions;

    // DSTU2 has a narrow definition of 'id', allowing only this regex: [A-Za-z0-9\-\.]{1,64}.
    // This means the normal approach toward identifying slices in ids (using :) and choices
    // (using [x]) is not valid. As a result, we must "fix" the ids in DSTU2 by removing invalid
    // characters and shortening the ids to 64 chars or less.
    if (this._target === 'FHIR_DSTU_2') {
      const fixID = (sd, element, shortenFn) => {
        // Get the diff element so we can fix that too
        const dfElement = common.getDifferentialElementById(sd, element.id, false);

        // First remove the namespaces from the slice names so the id is shorter
        // e.g., replace shr-core-SystolicBP with SystolicBP
        element.id = element.id.replace(/:([a-z][^\-.:]*-)+([A-Z][^\-.:]*)/g, ':$2');
        // Remove all []() characters
        element.id = element.id.replace(/[[\]()]/g, '');
        // Replace all other unsupported characters with -
        element.id = element.id.replace(/[^A-Za-z0-9\-.]/g, '-');
        // Last, shorten the id if necessary
        element.id = shortenFn(element.id);
        // And fix it on the diff element
        if (dfElement) {
          dfElement.id = element.id;
        }

        // If the name is not a slicename, then remove it!
        // One reason we do this is because the IG publisher will overwrite id w/ name if name exists!
        if (element.name && MVH.edSliceName(sd, element) == null) {
          delete(element.name);
          if (dfElement) {
            delete(dfElement.name);
          }
        }
      };
      [...profiles, ...extensions].forEach(sd => {
        const name2short = new Map();
        const short2Count = new Map();
        sd.snapshot.element.forEach(el => {
          // Define the "shorten" method used to shorten the id.
          // If the id is too long, start shortening parts from the end backward.
          const shorten = (id) => {
            if (id.length > 64) {
              let newLength = id.length;
              const idParts = id.split('.');
              for (let i=idParts.length-1; newLength > 64 && i > 0; i--) {
                const name = idParts[i];
                if (!name2short.has(name)) {
                  let short = name.slice(0, 3);
                  if (short2Count.has(short)) {
                    // a different name already shortened to these 3 chars, so add a number
                    const newCount = short2Count.get(short)+1;
                    short2Count.set(short, newCount);
                    short = `${short}${newCount}`;
                  } else {
                    short2Count.set(short, 0);
                  }
                  name2short.set(name, short);
                  idParts[i] = short;
                }
                idParts[i] = name2short.get(name);
                newLength -= (name.length - idParts[i].length);
              }
              return idParts.join('.');
            }
            return id;
          };
          fixID(sd, el, shorten);
        });
      });
    }

    return {
      profiles,
      extensions,
      _noDiffProfiles: noDiffProfiles,
      valueSets: this._valueSetExporter.valueSets,
      codeSystems: this._codeSystemExporter.codeSystems,
      models: this._modelsExporter.models,
      base: this._fhir,
    };
  }

  mappingToProfile(map) {
    // Setup a child logger to associate logs with the current map
    const lastLogger = logger;
    const targetItem = common.TargetItem.parse(map.targetItem);
    logger = rootLogger.child({ shrId: map.identifier.fqn, target: targetItem.target });
    // 03010, 'Start mapping element',,
    logger.debug('03010');
    this._processTracker.start(map.identifier.fqn, common.fhirID(map.identifier));
    try {
      // We need to enhance the map so some implicit things are made explicit for easier processing
      const originalMap = map;
      map = this.enhanceMap(map);

      const profileID = common.fhirID(map.identifier);
      const profileURL = common.fhirURL(map.identifier, this._config.fhirURL);
      if (REPORT_PROFILE_INDICATORS) {
        this._profileIndicators.set(profileID, new ProfileIndicators(profileURL, targetItem.target));
      }

      const def = this._fhir.find(targetItem.target);
      if (typeof def === 'undefined') {
        //13001 , 'Invalid FHIR target: ${target1}' , 'Unknown', 'errorNumber'
        logger.error( {target1: targetItem.target },'13001');
        return;
      }
      let profile = common.cloneJSON(def);

      // There are some bugs in STU3/R4 resources that cause errors in the IG publisher.  Let's fix them:
      // (1) Replace spaces in mapping URIs with %20
      // (2) Remove leading/trailing whitespace from map
      const fixMapping = (m) => {
        if (m.uri) {
          m.uri = m.uri.replace(/ /g, '%20');
        }
        if (typeof m.map === 'string') {
          m.map = m.map.trim();
        }
      };
      if (profile.mapping) {
        profile.mapping.forEach(fixMapping);
      }
      for (const ssEl of profile.snapshot.element) {
        if (ssEl.mapping) {
          ssEl.mapping.forEach(fixMapping);
        }
      }

      // (2) Fix incorrect display text for US jurisdiction
      if (profile.jurisdiction) {
        profile.jurisdiction.forEach(j => {
          if (j.coding) {
            j.coding.forEach(c => { if (c.code === 'US') c.display = 'United States of America'; });
          }
        });
      }

      // There are some bugs in Argonaut resources that cause errors in the IG publisher.
      // Fix invalid ids in mappings (e.g., "us-core-(stu3)")
      if (this._target === 'FHIR_DSTU_2' && targetItem.target.startsWith('http://fhir.org/guides/argonaut/')) {
        // Fix the mapping on the profile as well as each of its elements
        [profile, ...profile.snapshot.element].forEach(e => {
          if (e.mapping) {
            e.mapping.forEach(m => {
              // Ids can only have A-Z, a-z, 0-9, -, and .
              m.identity = m.identity.replace(/[^A-Za-z0-9\-.]/g, '');
            });
          }
        });
      }

      profile._shr = true;
      delete(profile.meta);
      delete(profile.extension);
      delete(profile.version);
      profile.id = profileID;
      profile.text = this.getText(originalMap);
      profile.url = profileURL;
      profile.identifier = [{ system: this._config.projectURL, value: map.identifier.fqn }];
      profile.name = common.tokenize(map.identifier.name);
      MVH.setSdTitle(profile, common.fhirID(map.identifier));
      profile.description = this.getDescription(map.identifier);
      profile.publisher = this._config.publisher;
      profile.contact = MVH.convertContactDetails(profile, this._config.contact);
      profile.date = this._config.publishDate || common.todayString();
      const keywords = this.getConcepts(map.identifier);
      if (keywords && keywords.length) {
        if (MVH.sdKeyword(profile) == null) {
          MVH.setSdKeyword(profile, []);
        }
        MVH.sdKeyword(profile).push(...keywords);
      }
      MVH.setSdBaseDefinition(profile, def.url);
      if (profile.fhirVersion === '1.0.2') {
        profile.constrainedType = MVH.sdType(profile);
      } else {
        profile.derivation = 'constraint';
      }

      // Modify the snapshot elements as appropriate
      for (const ssEl of profile.snapshot.element) {
        // Don't carry over the examples since they might be irrelevant to the specific profile use case.
        // (Also, some of the examples in STU 3.0.1 cause invariant violations!)
        delete(ssEl.example);
      }
      const rootSS = profile.snapshot.element[0];
      rootSS.short = MVH.sdTitle(profile);
      rootSS.definition = this.getDescription(map.identifier, rootSS.definition);

      // Reset the differential elements so we only have differences from our baseDefinition
      profile.differential = { element: [{
        id : rootSS.id,
        path : rootSS.path,
        short : rootSS.short,
        definition : rootSS.definition,
        mustSupport : rootSS.mustSupport,
        isModifier : rootSS.isModifier,
        isModifierReason : rootSS.isModifierReason,
        isSummary : rootSS.isSummary
      }] };

      if (TRACK_UNMAPPED_PATHS) {
        this._unmappedPaths.set(map.identifier.fqn, this.buildUnmappedPathsTree(map.identifier));
      }

      // Add it to the profiles now so if we get a recursive lookup, we find this instance
      this._profilesMap.set(profile.id, profile);

      this.processMappingRules(map, profile);
      this.addExtensions(map, profile);
      this.processContentProfileRules(map, profile);
      if (targetItem.target == 'Basic') {
        this.setCodeOnBasic(map, profile);
      }

      this.cleanupProfile(profile);

      // Check if this is a "no-diff" profile. A profile is considered "no-diff"
      // If the "mapping" is different, as the mappings are only used internally by other SHR profiles
      const allowedDiffKeys = ['id', 'path', 'short', 'definition', 'mapping'];
      const allowedDiffKeysForRoot = [...allowedDiffKeys, 'mustSupport', 'isModifier', 'isModifierReason', 'isSummary'];
      const isNoDiffProfile = profile.differential.element.length <= 1 || profile.differential.element.every(e => {
        const keys = Object.keys(e);
        const allowedKeys = (e.path.indexOf('.') === -1) ? allowedDiffKeysForRoot : allowedDiffKeys;
        return keys.every(k => {
          return e[k] == null || allowedKeys.indexOf(k) !== -1;
        });
      });
      if (isNoDiffProfile || targetItem.hasNoProfileCommand()) {
        // Now flag the profile as "not an SHR profile", so it doesn't get included in the
        // Profiles list displayed to the user
        profile._shr = false;
        this._profilesMap.set(profile.id, profile);
      } else if (profile._shr) { // In case no profile flag is already set by content profile
        // Perform additional QA
        this.additionalQA(profile);
      }

      return profile;
    } finally {
      this._processTracker.stop(map.identifier.fqn, common.fhirID(map.identifier));
      // Close out the logging for this mapping
      // 03011, 'Done mapping element',,
      logger.debug('03011');
      logger = lastLogger;
    }
  }

  cleanupProfile(profile) {
    // When SHR specifies a choice value, remove the others!
    const choiceElementIDsToRemove = [];
    for (const el of profile.snapshot.element) {
      if (el.path.endsWith('[x]') || (el.type && (el.type.length > 1 || this.optionIsSelected(el.type[0])))) {
        // Use a reduce to get only the highest priority selected types (or all, if none are selected)
        const shrSelected = el.type.reduce((selected, current) => {
          // Get priority of current type, using 100 if there is no priority
          const currentP = current._shrTypePriority || 100;
          // Compare to the currently selected priority and add, replace, or do nothing
          if (currentP === selected.p) {
            selected.types.push(current);
          } else if (currentP < selected.p) {
            selected.p = currentP;
            selected.types = [current];
          }
          // This reduce is dual purpose.  Also use it to remove the special markers!
          delete(current._shrTypePriority);
          delete(current._originalProfiles);
          delete(current._originalTargetProfiles);
          return selected;
        }, { p: 100, types: [] }).types;

        if (shrSelected.length > 0) {
          let df = common.getDifferentialElementById(profile, el.id);
          if (shrSelected.length < el.type.length) {
            el.type = shrSelected;
            // Do it in differential too
            if (typeof df === 'undefined') {
              df = { id: el.id, path: el.path };
              profile.differential.element.push(df);
            }
            df.type = el.type;
          } else if (typeof df !== 'undefined' && typeof df.type !== 'undefined') {
            df.type.forEach(t => {
              delete(t._shrTypePriority);
              delete(t._originalProfiles);
              delete(t._originalTargetProfiles);
            });
          }
        }
        // If it's a choice of one now, and there is an explicit path already, remove the choice.
        // e.g., don't have value[x] w/ only 'Quantity' *and* valueQuantity (as they're redundant).
        if (el.path.endsWith('[x]') && el.type.length === 1) {
          // Check to see if explicit path (e.g., valueQuantity) exists
          const idPrefix = el.id.replace(/\.[^.]+$/, '.');
          const explicitPath = el.path.replace(/\[x\]$/, common.capitalize(el.type[0].code));
          const explicitEl = profile.snapshot.element.find(e => e.path === explicitPath && e.id.startsWith(idPrefix));
          if (typeof explicitEl !== 'undefined') {
            // Since we're removing the [x], we don't need the special slice either
            if (el.slicing && el.slicing.discriminator.some(d => d.type === 'type' && d.path === '$this')) {
              if (explicitEl.id.endsWith(`:${MVH.edSliceName(profile, explicitEl)}`)) {
                // Grab the original ID and determine the new ID
                const originalID = explicitEl.id;
                const newID = originalID.substr(0, explicitEl.id.lastIndexOf(':'));
                // Remove slicename from the snapshot
                MVH.deleteEdSliceName(profile, explicitEl);
                // Fixup all snapshots rooted in this ID
                for (const thisEl of profile.snapshot.element) {
                  if (thisEl.id.startsWith(originalID)) {
                    thisEl.id = thisEl.id.replace(originalID, newID);
                  }
                }
                // Fixup the differential
                const explicitDfEl = common.getDifferentialElementById(profile, explicitEl.id);
                if (typeof explicitDfEl !== 'undefined') {
                  // Remove slicename from the differential
                  MVH.deleteEdSliceName(profile, explicitDfEl);
                }
                // Fixup all differentials rooted in this ID
                for (const thisEl of profile.differential.element) {
                  if (thisEl.id.startsWith(originalID)) {
                    thisEl.id = thisEl.id.replace(originalID, newID);
                  }
                }
              }
            }
            choiceElementIDsToRemove.push(el.id);
          } else {
            // There's only one choice, so change the id and path to the explicit version
            const newID = el.id.replace(/\[x\](:[^.]+)?$/, common.capitalize(el.type[0].code) + '$1');
            const newPath = el.path.replace(/\[x\]?$/, common.capitalize(el.type[0].code));
            const df = common.getDifferentialElementById(profile, el.id, false);
            if (typeof df !== 'undefined') {
              df.id = newID;
              df.path = newPath;
            }
            el.id = newID;
            el.path = newPath;
          }
        }
      }
    }
    // Remove any choice (e.g., value[x]) elements that were deemed redundant
    if (choiceElementIDsToRemove.length > 0) {
      profile.snapshot.element = profile.snapshot.element.filter(e => !choiceElementIDsToRemove.some(id => id === e.id));
      profile.differential.element = profile.differential.element.filter(e => !choiceElementIDsToRemove.some(id => id === e.id));
    }

    // Remove any temporary properties we used to help along the way
    for (const el of profile.differential.element) {
      delete(el._originalProperties);
    }

    // Fix any minimum cardinalities that should be bumped up due to slicing.
    for (let i=0; i < profile.snapshot.element.length; i++) {
      const baseEl = profile.snapshot.element[i];
      if (baseEl.slicing != null) {
        const totalMin = this.getBaseSliceMinCard(profile, baseEl);
        if (totalMin > baseEl.min) {
          if (baseEl.max !== '*' && totalMin > parseInt(baseEl.max)) {
            //13129, 'Cumulative slice min cardinalities ${totalMinimum} exceed the max cardinality (${maxCard}) for the containing array at ${baseArray}.', 'Unknown, 'errorNumber''
            logger.error({totalMinimum: totalMin, maxCard: baseEl.max, baseArray: baseEl.id}, '13129');
          }
          const dfEl = common.getDifferentialElementById(profile, baseEl.id, true);
          baseEl.min = dfEl.min = totalMin;
          // Whenever we set a min in a differential, we always set the max too.  It looks better that way.
          dfEl.max = baseEl.max;
        }
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

    // Remove any unnecessary (insignificant) diff elements or child elements that don't need to be "unrolled"
    const baseSD = this._fhir.find(MVH.sdBaseDefinition(profile));
    common.compactStructureDefinition(profile, baseSD);
  }

  getBaseSliceMinCard(profile, ssEl) {
    if (ssEl.slicing == null) {
      return ssEl.min;
    }
    // it's a base slice, so look through its children for slices with min > 1 and add to totalMin
    let totalMin = 0;
    const isChild = function(idx) {
      return profile.snapshot.element[idx].id.indexOf(`${ssEl.id}:`) === 0
        || profile.snapshot.element[idx].id.indexOf(`${ssEl.id}.`) === 0;
    };
    const baseIdLastDot = ssEl.id.lastIndexOf('.');
    const sliceLastColon = ssEl.id.length; // colon will be after the baseId
    const ssElIdx = profile.snapshot.element.findIndex(e => e === ssEl);
    for (let i=ssElIdx+1; i < profile.snapshot.element.length && isChild(i); i++) {
      const childEl = profile.snapshot.element[i];
      // Check if it's a direct child slice
      if (MVH.edSliceName(profile, childEl) && childEl.id.lastIndexOf('.') === baseIdLastDot && childEl.id.lastIndexOf(':') === sliceLastColon) {
        if (childEl.slicing != null) {
          totalMin += this.getBaseSliceMinCard(profile, childEl);
        } else {
          totalMin += childEl.min;
        }
      }
    }
    return totalMin;
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
      // For now, don't deal with _Concept.*
      if (p.isConceptKeyWord) {
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
  <p><b>${common.escapeHTML(map.identifier.name)} Profile</b></p>
  <p>${common.escapeHTML(this.getDescription(map.identifier))}</p>
  <p><b>Mapping Summary</b></p>
  <p><pre>${common.escapeHTML(mappingAsText(map, true))}</pre></p>
</div>`
    };
  }

  getDescription(identifier, defaultText) {
    const def = this._specs.dataElements.findByIdentifier(identifier);
    let description;
    if (def) {
      description = common.trim(def.description);
    }
    if (description == null || description == '') {
      description = common.trim(defaultText);
    }
    return description;
  }

  getDescriptionAsShort(identifier, defaultText) {
    let description = this.getDescription(identifier, defaultText);
    if (description == null) {
      return description;
    }

    const firstSentence = this.getFirstSentence(description);

    // Play by twitter rules (maybe somewhat less than arbitrary?)
    if (description.length <= 140) {
      if (description === firstSentence && description.slice(-1) === '.') {
        // Remove the trailing '.' if it's only one sentence, as that seems to be how FHIR does shorts
        return description.slice(0, description.length-1);
      }
      return description;
    }

    // If we got here, then the description is > 140 chars, so use first sentence
    if (firstSentence.slice(-1) === '.') {
      // Remove the trailing '.' if it's only one sentence, as that seems to be how FHIR does shorts
      return firstSentence.slice(0, firstSentence.length-1);
    }
    return firstSentence;
  }

  getFirstSentence(str) {
    // Start at index 2.  This allows us to skip some index checks in the logic, and we
    // don't want sentences shorter than that anyway.
    let i = 2;
    for (i=str.indexOf('.', i); i !== -1 && i < str.length; i = str.indexOf('.', i+1)) {
      // If the '.' is part of 'e.g.', 'i.e.', or 'vs.', skip it -- it's not the end of the sentence.
      // Otherwise if the '.' is followed by optional spaces and a newline, OR if it is followed by
      // one or more spaces and a capital letter or number, consider the '.' as the end of the sentence.
      // Also allow the " character to account for quoted sentences where the '.' is inside the quote.
      const surrounding = str.slice(i-1, i+3);
      if ( surrounding === 'e.g.' || surrounding === 'i.e.') {
        i += 2;
        continue;
      } else if (str.slice(i-2, i+1) === 'vs.') {
        continue;
      } else if (/^\.(([\s"]*\n)|([\s"]+[A-Z0-9]))/.test(str.slice(i))) {
        break;
      }
    }
    if (i === -1) {
      // Even though it was > 140 characters, it's all just one sentence, so keep the whole thing.
      return str;
    }
    // Truncate after the '.', but then check for unbalanced " marks because we might have truncated
    // inside a quoted phrase.  Balance the " marks by adding one at the end if necessary.
    const truncated = str.slice(0, i+1);
    const dqMatches = truncated.match(/"/g) || [];
    return dqMatches.length % 2 === 0 ? truncated : `${truncated}"`;
  }

  /**
   * Returns an array of code objects representing the concepts associated with an SHR DataElement definition
   * @param {Object} identifier - the SHR Identifier representinf the data element defining its concepts
   * @return {{system: string, code: string, display?: string}[]} the concepts as code objects
   */
  getConcepts(identifier) {
    const def = this._specs.dataElements.findByIdentifier(identifier);
    if (def && def.concepts) {
      return def.concepts.map(c => ({ system: c.system, code: c.code, display: common.trim(c.display) }));
    }
    return [];
  }

  setCodeOnBasic(map, profile) {
    const ssEl = common.getSnapshotElement(profile, 'code');
    if (typeof ssEl.fixedCodeableConcept === 'undefined' && typeof ssEl.patternCodeableConcept === 'undefined') {
      let dfEl =  common.getDifferentialElementById(profile, ssEl.id);
      if (typeof dfEl === 'undefined') {
        dfEl = {
          id: ssEl.id,
          path: ssEl.path
        };
        profile.differential.element.push(dfEl);
      }
      ssEl.patternCodeableConcept = dfEl.patternCodeableConcept = {
        coding: [ { system: `${this._config.fhirURL}/CodeSystem/${this._config.projectShorthand}-basic-resource-type`, code: profile.id }]
      };
      if (this._target === 'FHIR_DSTU_2') {
        this._valueSetExporter.addTypeToBasicResourceTypeDSTU2ValueSet(profile.id, MVH.sdTitle(profile));
      } else {
        this._codeSystemExporter.addTypeToBasicResourceTypeCodeSystem(profile.id, MVH.sdTitle(profile));
      }
      if (REPORT_PROFILE_INDICATORS) {
        this.addFixedValueIndicator(profile, ssEl.path, ssEl.patternCodeableConcept);
      }
    }
  }

  enhanceMap(map) {
    // We're going to mess with things, so let's just clone the mapping now!
    map = map.clone();
    const targetItem = common.TargetItem.parse(map.targetItem);

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
    const def = this._specs.dataElements.findByIdentifier(map.identifier);
    for (let i=0; i < map.rules.length; i++) {
      const rule = map.rules[i];
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
          // We need to keep track of the index where to insert extra includes type elements (if applicable)
          let includesInsertIdx;
          const includesTypeRules = [];
          for (const incl of includes) {
            if (incl.path.length > 0) {
              //13003 , 'Splicing on include type constraints with paths is not supported' , 'Unknown', 'errorNumber'
              logger.error('13003');
              continue;
            }
            // Substitute the original identifier in the path with the includesType identifier instead
            const newSourcePath = rule.sourcePath.slice();
            newSourcePath[newSourcePath.length-1] = incl.isA;
            // Create and store a new rule, but remove "slice strategy" from the commands since it only applies to parent
            includesTypeRules.push(new mdls.FieldMappingRule(newSourcePath, new FieldTarget(t.target, t.commands.filter(c => c.key != 'slice strategy')).toRuleTarget()));
            // Copy, update, and add specific child rules within the slice
            let j=i+1;
            for (; j < map.rules.length; j++) {
              const sliceRule = map.rules[j];
              // First check if this is a child of the slice path.  If not, stop looking and break.
              if (typeof sliceRule.sourcePath === 'undefined') {
                // pass through rules like "fix related.type to #has-member"
                continue;
              } else if (sliceRule.sourcePath.length <= rule.sourcePath.length) {
                break;
              } else if (!rule.sourcePath.every((p, pIdx) => p.equals(sliceRule.sourcePath[pIdx]))) {
                break;
              }
              // It's a match -- so it's a child of the slice path
              // Substitute the original identifier in the path with the includesType identifier instead
              const newSliceSourcePath = sliceRule.sourcePath.slice();
              newSliceSourcePath[rule.sourcePath.length-1] = incl.isA;
              includesTypeRules.push(new mdls.FieldMappingRule(newSliceSourcePath, sliceRule.target));
            }
            // We're at the end of the original rules defining the slices, so this is where we'll
            // eventually need to insert the new rules.
            includesInsertIdx = j;
          }

          // When we slice on something that has IncludesType constraints, the intention is not to make the base
          // type a slice.  Only the includes types should be slices.  So, *remove* the slice commands from the base.
          map.rules[i] = new mdls.FieldMappingRule(rule.sourcePath, t.target);
          // Now add the new rules we just created based on the includes types!
          map.rules.splice(includesInsertIdx, 0, ...includesTypeRules);
        } else {
          // The strategy says to slice on includes, but there are none, so modify the rule to remove slicing commands.
          // We don't want to slice on something that has no slices defined!
          map.rules[i] = new mdls.FieldMappingRule(rule.sourcePath, t.target);
        }
      }
    }

    const sliceOnMap = new Map();
    const sliceAtMap = new Map();
    const sliceTargetStack = new Stack();
    const sliceNameStack = new Stack();
    const getInSliceValue = function() {
      // Use the stack of slice targets and names to build up the slice-aware path, supporting nested slices.
      // E.g., 'foo:sliceA.bar:sliceB' represents sliceB of bar inside sliceA of foo.
      const [targetStack, nameStack] = [sliceTargetStack.clone(), sliceNameStack.clone()];
      let value = targetStack.peekLast();
      while (!targetStack.isEmpty()) {
        const [target, sliceName] = [targetStack.pop(), nameStack.pop()];
        let slicedReplacement;
        if (sliceAtMap.has(target)) {
          // If there is a slice at (meaning slice is higher up the path), we need to put the slice annotation
          // at the right place in the middle of the target path
          const sliceAt = sliceAtMap.get(target);
          slicedReplacement = target.replace(sliceAt, `${sliceAt}:${sliceName}`);
        } else {
          // No slice at, so we can put the slice annotation at the end of the target path
          slicedReplacement = `${target}:${sliceName}`;
        }
        value = value.replace(target, slicedReplacement);
      }
      return value;
    };
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

      if (t.hasSliceNumberCommand()) {
        const fhirDef = this._fhir.find(targetItem.target);
        const ss = common.getSnapshotElement(fhirDef, t.target, parseInt(t.findSliceNumberCommand().value, 10));
        if (typeof ss === 'undefined') {
          //13046 , 'Mapping to ${mapTarget} 's ${ruleTarget}: slice could not be found.' , 'Unknown', 'errorNumber'
          logger.error({ mapTarget: map.target , ruleTarget: rule.target }, '13046');
          continue;
        }
        if (t.target != sliceTargetStack.peekLast()) {
          sliceTargetStack.push(t.target);
        } else {
          // Since we're in the same slice group, pop the last slice name to make room for the next
          sliceNameStack.pop();
        }
        const sliceName = MVH.edSliceName(fhirDef, ss);
        sliceNameStack.push(sliceName);
        t.addInSliceCommand(getInSliceValue());
      } else if (t.hasSliceOnCommand()) {
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
        sliceNameStack.push(sliceName);
        t.addInSliceCommand(getInSliceValue());
      } else if (!sliceTargetStack.isEmpty() && t.target == sliceTargetStack.peekLast()) {
        // Associate with current slice group
        t.addSliceOnCommand(sliceOnMap.get(t.target));

        // Add slice at if applicable
        if (sliceAtMap.has(t.target)) {
          t.addSliceAtCommand(sliceAtMap.get(t.target));
        }

        // Start a new slice in the slice group!
        sliceNameStack.pop();
        const sliceName = common.fhirID(rule.sourcePath[rule.sourcePath.length-1]);
        sliceNameStack.push(sliceName);
        t.addInSliceCommand(getInSliceValue());
      } else if (!sliceTargetStack.isEmpty() && t.target.startsWith(sliceTargetStack.peekLast())) {
        // Put it in the slice
        t.addInSliceCommand(getInSliceValue());
      }
      rule._target = t.toRuleTarget(); // BAD BAD BAD
    }

    // Last, in case the author wanted to override slice assignment (by specifying a slice # for something otherwise already sliced via includes),
    // we look for the case of duplicate rules where the second rule contains only a slice #, in which case we update all the other rules to
    // reference the slice pointed at by the slice #.  See BloodPressure for an example.

    // Find rules that have only defined the slice # command (note: "in slice" was calculated and added above)
    const sliceNumRules = map.rules.filter(r => {
      const ft = FieldTarget.parse(r.target);
      return ft.hasSliceNumberCommand() && ft.hasInSliceCommand() && !ft.hasSliceAtCommand() && !ft.hasSliceOnCommand() && !ft.hasSliceOnTypeCommand() && !ft.hasSliceStrategyCommand();
    });
    // For each of those rules w/ only a slice #...
    for (const sliceNumRule of sliceNumRules) {
      const sliceNumSliceName = FieldTarget.parse(sliceNumRule.target).findInSliceCommand().value;
      let isDuplicate = false;
      // Iterate the rules looking for ones with the same root sourcePath but a different "in slice" vsalue
      for (const rule of map.rules) {
        if (rule.sourcePath && rule.sourcePath.length >= sliceNumRule.sourcePath.length && pathsAreEqual(sliceNumRule.sourcePath, rule.sourcePath.slice(0, sliceNumRule.sourcePath.length))) {
          const ft = FieldTarget.parse(rule.target);
          if (ft.hasInSliceCommand() && ft.findInSliceCommand() !== sliceNumSliceName) {
            isDuplicate = rule.sourcePath.length === sliceNumRule.sourcePath.length;
            // Create a new FieldTarget with the updated "in slice"
            const newFT = new FieldTarget(ft.target, ft.commands.filter(c => c.key !== 'in slice'), ft.comments);
            newFT.addInSliceCommand(sliceNumSliceName);
            rule._target = newFT.toRuleTarget();
          }
        }
      }
      // If this was a duplicate rule, delete the slice # variant since we don't need it anymore
      if (isDuplicate) {
        map.rules = map.rules.filter(r => r !== sliceNumRule);
      }
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

    // To see the enhanced mapping statements, uncomment below (and modify to target your specific element)
    // if (map.identifier.name === 'BloodPressure') {
    //   console.log(mappingAsText(map, true));
    // }

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
      // 03012, 'Start mapping rule',,
      logger.debug('03012');
      try {
        if (rule instanceof mdls.CardinalityMappingRule) {
          this.processCardinalityMappingRule(map, rule, profile);
        } else if (rule instanceof mdls.FixedValueMappingRule) {
          this.processFixedValueMappingRule(map, rule, profile);
        } else if (rule.sourcePath.some(p => p instanceof mdls.TBD)) {
          continue;
        } else if (rule instanceof mdls.FieldMappingRule) {
          const ft = FieldTarget.parse(rule.target);
          if (ft.isExtension()) {
            this.processFieldToExtensionMappingRule(map, rule, profile);
          } else {
            this.processFieldToFieldMappingRule(map, rule, profile);
          }
        }
      } catch (e) {
        //13050 , 'Unexpected error processing mapping rule. ${errorText} ' , 'Unknown' , 'errorNumber'
        logger.error({errorText: e.stack}, '13050');
      } finally {
        // 03013, 'Done mapping rule',,
        logger.debug('03013');
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
      if (!t.hasInSliceCommand() && !t.isExtension()) {
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
          //13004 , 'Slicing required to disambiguate multiple mappings to ${target1}' , 'Unknown', 'errorNumber'
          logger.error({target1: JSON.stringify(t)},'13004' );
        }
      }
    }
  }

  processFieldToExtensionMappingRule(map, rule, profile) {
    const def = this._specs.dataElements.findByIdentifier(map.identifier);
    if (TRACK_UNMAPPED_PATHS) {
      this.removeMappedPath(def, rule.sourcePath);
    }
    this.addExtension(map, profile, rule);
  }

  processFieldToFieldMappingRule(map, rule, profile) {
    const def = this._specs.dataElements.findByIdentifier(map.identifier);
    if (typeof def === 'undefined') {
      //13005 , 'Invalid source path ' , 'Unknown' , 'errorNumber'
      logger.error('13005');
      return;
    }

    const sourceValue = this.findValueByPath(rule.sourcePath, def);
    if (typeof sourceValue === 'undefined') {
      // This only happens in cases where a base class defined a mapping, but the subclass
      // constrained out that path so it no longer exists.  So... we can safely ignore it!
      return;
    }

    // If this sourceValue came from an includesType, then the includeType cardinality needs
    // to be set at the base of the slice.
    const fieldTarget = FieldTarget.parse(rule.target);
    let sliceCard;
    if (sourceValue._derivedFromIncludesTypeConstraint) {
      sliceCard = sourceValue.card;
    }


    let ss = this.getSnapshotElementForFieldTarget(profile, fieldTarget, sourceValue, sliceCard);
    if (typeof ss === 'undefined' && fieldTarget.target.endsWith('[x]')) {
      // In some cases (like FHIR VitalSigns profiles), the value[x] is removed and replaced w/ instance (e.g., valueQuantity)
      // TODO: Support when sourceValue is a choice
      if (sourceValue instanceof mdls.IdentifiableValue) {
        // We'll try to look up the SS element by the spelled out instance (e.g., valueQuantity).
        // To do this, we need to know what the source maps to (to determine the type to replace the [x])
        const map = this._specs.maps.findByTargetAndIdentifier(this._target, sourceValue.effectiveIdentifier);
        if (typeof map !== 'undefined') {
          const newTarget = fieldTarget.target.replace(/\[x\]$/, common.capitalize(common.TargetItem.parse(map.targetItem).target));
          const newFieldTarget = new FieldTarget(newTarget, fieldTarget.commands, fieldTarget.comments);
          ss = this.getSnapshotElementForFieldTarget(profile, newFieldTarget, sourceValue, sliceCard);
        }
      }

      // If it's still null, brute-force check through all the possible explicit types.
      // E.g. for component.value[x], check against any element that starts w/ component.value (and has same number of parts)
      if (ss == null) {
        // The prefix we will check for is the original path minus the [x] at the end
        const ssPathPrefix = `${MVH.sdType(profile)}.${fieldTarget.target.slice(0, -3)}`;
        // Find elements that start w/ the prefix and do not have any more '.' after the prefix (same number of parts)
        const explicitEls = profile.snapshot.element.filter(e => e.path.startsWith(ssPathPrefix) && e.path.indexOf('.', ssPathPrefix.length) === -1);
        const alreadyTried = [`${ssPathPrefix}[x]`];
        for (let i=0; i < explicitEls.length && ss == null; i++) {
          if (!alreadyTried.includes(explicitEls[i].path)) {
            // See if we can find a match against this explicit instance
            alreadyTried.push(explicitEls[i].path);
            const newPath = explicitEls[i].path.slice(explicitEls[i].path.indexOf('.')+1);
            const newFieldTarget = new FieldTarget(newPath, fieldTarget.commands, fieldTarget.comments);
            ss = this.getSnapshotElementForFieldTarget(profile, newFieldTarget, sourceValue, sliceCard);
            // NOTE: if ss is no longer null, the for loop will terminate
          }
        }
      }
    }
    if (typeof ss === 'undefined') {
      //13006 , 'Invalid or unsupported target path' , 'Unknown', 'errorNumber'
      logger.error('13006');
      return;
    }

    const df = common.getDifferentialElementById(profile, ss.id, true);

    // Check if the field being mapped is the definition's 'Value' element
    // TODO: If def.value is a ChoiceValue, test that at least one ID equals the sourceValue (using .some())
    const isValue = def.value !== undefined && common.choiceFriendlyEffectiveIdentifier(sourceValue) == def.value.identifier;
    if (isValue) {
      // If it is the 'Value' element, just map it through to the SHR 'Value'
      pushShrMapToElementMappings('<Value>', ss, df);
    } else {
      // If it isn't; and it's not derived from includes type constraints, map it to the fqn of the field being mapped
      // TODO: Determine why we're excluding derivedFromIncludesTypeConstraints
      if (!sourceValue._derivedFromIncludesTypeConstraint) {
        // Build the mapping based on the sourcePath for the rule, to handle nested elements
        const shrMap = rule.sourcePath.map((pathElem) => {
          return `<${pathElem.fqn}>`;
        }).join('.');
        pushShrMapToElementMappings(shrMap, ss, df);
      }
    }

    if (typeof ss.type === 'undefined' && typeof MVH.edContentReference(profile, ss) !== 'undefined') {
      // To profile a content reference, we must unroll it (see https://chat.fhir.org/#narrow/stream/implementers/topic/Profiling.20a.20contentReference)
      this.unrollContentReference(profile, ss);
    }

    if (typeof sliceCard === 'undefined') {
      this.processFieldToFieldCardinality(map, rule, profile, ss, df);
    }
    this.processFieldToFieldType(map, def, rule, profile, ss, df);
  }

  findContentReferencePath(profile, snapshotEl) {
    const cRef = MVH.edContentReference(profile, snapshotEl);
    if (!cRef.startsWith('#')) {
      //13007 , 'Cannot unroll contentReference ${contentReference} on ${element1} because it is not a local reference' , 'Unknown', 'errorNumber'
      logger.error({contentReference: cRef, element1 : snapshotEl.id }, '13007');
      return;
    }

    let crElem;
    if (this._target === 'FHIR_DSTU_2') {
      const name = cRef.slice(1);
      crElem = profile.snapshot.element.find(e => e.name === name);
    } else {
      const path = cRef.slice(1);
      crElem = profile.snapshot.element.find(e => e.path === path);
    }

    if (!crElem) {
      //13008 , 'Invalid content reference on ${element1}: ${contentReference}' , 'Unknown' , 'errorNumber'
      logger.error({element1 : snapshotEl.id, contentReference: cRef }, '13008');
      return;
    }
    return crElem.path;
  }

  unrollContentReference(profile, snapshotEl) {
    const cRef = MVH.edContentReference(profile, snapshotEl);
    const crPath = this.findContentReferencePath(profile, snapshotEl);
    if (crPath == null) {
      return; // error already logged in findContentReferencePath()
    }

    // Need to use the base resource to unroll the contentref, in case it points to something already profiled by us.
    // We wouldn't want to carry over the constraints from the profiled item.
    const def = this._fhir.find(MVH.sdType(profile));

    // Find all the elements we need to unroll from the content reference
    const unrolled = [];
    let rootId;
    for (const ss of def.snapshot.element) {
      if (ss.path.startsWith(crPath)) {
        if (typeof rootId === 'undefined') {
          // This is the "root" element where the contentReference is.  Replace the definitions in place as necessary.
          rootId = ss.id;
          MVH.deleteEdContentReference(profile, snapshotEl);
          snapshotEl.type = ss.type;
          snapshotEl.defaultValue = ss.defaultValue;
          snapshotEl.fixed = ss.fixed;
          snapshotEl.pattern = ss.pattern;
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
      //13008 , 'Invalid content reference on ${element1}: ${contentReference}' , 'Unknown' , 'errorNumber'
      logger.error({element1: snapshotEl.id ,contentReference: cRef }, '13008');
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
      //13009 , 'Cannot unroll ${element}. Create an explicit choice element first.' , 'Unknown', 'errorNumber'
      logger.error({element: snapshotEl.id},'13009' );
      return;
    }

    let sdToUnroll;
    if (identifier instanceof mdls.Identifier) {
      if (snapshotEl.type.length == 1 && snapshotEl.type[0].code == 'Extension') {
        // Lookup the extension
        const extURL = MVH.typeProfile(snapshotEl.type[0])[0];
        // If it's an extension defined by this IG, look it up in the extension exporter
        if (extURL === common.fhirURL(identifier, this._config.fhirURL, 'extension')) {
          sdToUnroll = this._extensionExporter.lookupExtension(identifier, true, true);
        } else {
          // else look it up in the FHIR specs
          sdToUnroll = this.lookupStructureDefinition(extURL, false);
        }
      } else {
        // Look up the profile
        sdToUnroll = this.lookupProfile(identifier, true, true);
        if (typeof sdToUnroll === 'undefined') {
          //13010 , 'Cannot unroll ${element1} at ${element2}: invalid SHR element.' , 'Unknown', 'errorNumber'
          logger.error({element1: identifier.fqn, element2: snapshotEl.id}, '13010');
          return;
        }
        // If the element types don't allow the looked up profile type, this may be a case of an allowable conversion
        // (e.g., CIMPL element is concept and FHIR type is CodeableConcept).  In this case, unroll the target FHIR type.
        if (!snapshotEl.type.some(t => t.code === MVH.sdType(sdToUnroll))) {
          // If there is an allowed conversion type, use that instead
          const allowed = this.findAllowedConversionTargetTypes(identifier, snapshotEl.type);
          if (allowed.length > 0) {
            // Multiple values are possible but not likely. There's no way to choose, so just take the first one.
            sdToUnroll = this.lookupStructureDefinition(allowed[0].code);
          } else {
            // Nothing matched.  This will fall through to an error.
            sdToUnroll = null;
          }
        }
      }
    } else {
      sdToUnroll = this.lookupStructureDefinition(identifier, true);
    }

    if (typeof sdToUnroll === 'undefined') {
      //13047 , 'Couldn't find sd to unroll ${element1} ${element2} ${element3}' , 'Unknown', 'errorNumber'
      logger.error({element1: identifier.fqn, element2: profile.id , element3: snapshotEl.id}, '13047');
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
      // Remove the SHR mappings since they are relative to the unrolled object (not to the path they're unrolled to)
      if (ss.mapping) {
        ss.mapping = ss.mapping.filter(m => m.identity !== 'shr');
      }
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

  addExplicitChoiceElement(identifier, profile, snapshotEl, differentialEl) {
    if (!snapshotEl.path.endsWith('[x]')) {
      //13011 , 'Cannot make choice element explicit since it is not a choice ([x]): ${element}' , 'Unknown', 'errorNumber'
      logger.error({element: snapshotEl.id}, '13011');
      return [];
    }
    let sdToAdd;
    if (typeof identifier === 'string') {
      sdToAdd = this.lookupStructureDefinition(identifier, true);
      if (typeof sdToAdd === 'undefined') {
        //13070, 'Cannot make choice element explicit at ${id1}. Invalid identifier: ${id2}. ', 'Unknown' , 'errorNumber'
        logger.error({id1:snapshotEl.id, id2:identifier.fqn }, '13070');
        return [];
      }
    } else if (snapshotEl.type.length == 1 && snapshotEl.type[0].code == 'Extension') {
      // Lookup the extension
      sdToAdd = this._extensionExporter.lookupExtension(identifier, true, true);
    } else {
      if (identifier.isPrimitive && identifier.name === 'concept') {
        const codeType = ['CodeableConcept', 'Coding', 'code'].find(c => snapshotEl.type.some(t => t.code === c));
        if (codeType) {
          sdToAdd = this.lookupStructureDefinition(codeType, true);
        }
      } else if (identifier.isPrimitive) {
        sdToAdd = this.lookupStructureDefinition(identifier.name, true);
      }
      else {
        sdToAdd = this.lookupProfile(identifier, true, true);
      }
      if (typeof sdToAdd === 'undefined') {
        //13012 , 'Cannot make choice element explicit at ${element}. Invalid SHR identifier: ${identifier}.' , 'Unknown', 'errorNumber'
        logger.error({element: snapshotEl.id, identifier:identifier.fqn }, '13012');
        return [];
      }
    }

    // Mark the choice as selected, so we can filter down the choice to selected types only later
    let allowableTargetTypes = common.getFHIRTypeHierarchy(this._fhir, sdToAdd.id);
    // If it's not a FHIR type (e.g., it's our own profile), then the above will return [].
    // In that case, get the type hierarcy from the profile type (which should be a FHIR type).
    if (allowableTargetTypes.length === 0) {
      allowableTargetTypes = common.getFHIRTypeHierarchy(this._fhir, MVH.sdType(sdToAdd));
    }
    const allowableTargetProfiles = allowableTargetTypes.map(t => this._fhir.find(t).url);
    const basedOnTargetProfiles = this.getRecursiveBasedOns(identifier).map(b => common.fhirURL(b, this._config.fhirURL));
    let matchedType;
    // First try to find the most direct matched type
    for (const t of snapshotEl.type) {
      if (t.code === MVH.sdType(sdToAdd)) {
        matchedType = t;
        this.markSelectedOptionsInChoice(snapshotEl.type, [t]);
        break;
      }
    }
    // If we didn't find a direct one, do a more thorough search
    if (matchedType == null) {
      for (const t of snapshotEl.type) {
        const originalProfiles = this.optionIsSelected(t) ? t._originalProfiles : MVH.typeProfile(t);
        const originalTargetProfiles = this.optionIsSelected(t) ? t._originalTargetProfiles : MVH.typeTargetProfile(t);
        if (allowableTargetTypes.includes(t.code) || allowableTargetProfiles.some(tp => originalProfiles && originalProfiles.includes(tp)) || basedOnTargetProfiles.some(bp => originalProfiles && originalProfiles.includes(bp))) {
          matchedType = t;
          break;
        } else if (t.code == 'Reference' && (allowableTargetProfiles.some(tp => originalTargetProfiles && originalTargetProfiles.includes(tp)) || basedOnTargetProfiles.some(bp => originalTargetProfiles && originalTargetProfiles.includes(bp)))) {
          matchedType = t;
          break;
        }
      }
    }
    // If we didn't find the matched type, it is an error.
    if (matchedType == null) {
      //13071, 'Cannot make choice element explicit at ${element1}. Could not find compatible type match for: ${element2}.', 'Unknown' , 'errorNumber'
      logger.error( {element1: snapshotEl.id, element2: MVH.sdType(sdToAdd) }, '13071');
      return [];
    }

    this.markSelectedOptionsInChoice(snapshotEl.type, [matchedType]);

    // Check to be sure we don't already have one
    const sliceName = sdToAdd.id;
    const baseId = `${snapshotEl.id.replace(/\[x\]$/, common.capitalize(matchedType.code))}:${sliceName}`;
    const existing = profile.snapshot.element.find(e => e.id == baseId);
    if (existing) {
      const dfExisting = common.getDifferentialElementById(profile, existing.id, true);
      return [existing, dfExisting];
    }

    // Slice the choice and add an explicit reference (e.g. value[x] --> valueCodeableConcept)
    // See: https://chat.fhir.org/#narrow/stream/implementers/subject/StructureDefinition.20with.20slice.20on.20choice
    common.addSlicingToBaseElement(profile, snapshotEl, differentialEl, 'type', '$this');

    // Build the new choice element
    const newType = { code: matchedType.code };
    if (matchedType.code === 'Reference') {
      MVH.setTypeTargetProfile(profile, newType, sdToAdd.url);
    }
    // If it's an extension, a custom profile, or a non-custom profile on the type, add the profile
    if (matchedType.code === 'Extension' || common.isCustomProfile(sdToAdd) || sdToAdd.id !== matchedType.code) {
      MVH.setTypeProfile(profile, newType, sdToAdd.url);
    }
    const ssChoiceEl = {
      id: baseId,
      path: snapshotEl.path.replace(/\[x\]$/, common.capitalize(matchedType.code)),
      [MVH.nameOfEdSliceName(profile)]: sliceName,
      short: snapshotEl.short,
      definition: snapshotEl.definition,
      min: snapshotEl.min,
      max: snapshotEl.max,
      base: {
        path: snapshotEl.path,
        min: snapshotEl.min,
        max: snapshotEl.max
      },
      type: [newType],
      isSummary: snapshotEl.isSummary
    };

    // Insert the explicit element into the snapshot
    let start = profile.snapshot.element.findIndex(e => e.id == snapshotEl.id) + 1;
    profile.snapshot.element.splice(start, 0, ssChoiceEl);

    // Find or create the corresponding differential
    let dfChoiceEl = common.getDifferentialElementById(profile, ssChoiceEl.id);
    if (typeof dfChoiceEl === 'undefined') {
      dfChoiceEl = {
        id: ssChoiceEl.id,
        path: ssChoiceEl.path,
        base: ssChoiceEl.base,
        type: ssChoiceEl.type
      };
      profile.differential.element.push(dfChoiceEl);
    }

    // If there are any SHR mappings, carry them over to the explicitChoice
    if (snapshotEl.mapping && snapshotEl.mapping.some(m => m.identity === 'shr')) {
      ssChoiceEl.mapping = dfChoiceEl.mapping = snapshotEl.mapping.filter(m => m.identity === 'shr');
    }

    return [ssChoiceEl, dfChoiceEl];
  }

  processCardinalityMappingRule(map, rule, profile) {
    const fieldTarget = FieldTarget.parse(rule.target);
    const ss = this.getSnapshotElementForFieldTarget(profile, fieldTarget);
    if (typeof ss === 'undefined') {
      //13013 , 'Invalid target path. Cannot apply cardinality constraint.' , 'Unknown', 'errorNumber'
      logger.error('13013');
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
      //13014 , 'Cannot constrain cardinality from ${cardinality1} to ${cardinality2} ' , 'Unknown' , 'errorNumber'
      logger.error({cardinality1: targetCard.toString(), cardinality2: rule.cardinality.toString()}, '13014' );
    }

    if (dfIsNew && Object.keys(df).length > 2) {
      profile.differential.element.push(df);
    }
  }

  processFixedValueMappingRule(map, rule, profile) {
    const fieldTarget = FieldTarget.parse(rule.target);
    const target = fieldTarget.target;
    const fixedValue = rule.value.trim();

    const ss = this.getSnapshotElementForFieldTarget(profile, fieldTarget);
    if (typeof ss === 'undefined') {
      //13015 , 'Invalid target path. Cannot apply fixed value.' , 'Unknown' , 'errorNumber'
      logger.error('13015');
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

    // If the path is something like value[x].boolean, get the intended type
    let targetType;
    const parts = target.split('.');
    if (parts.length > 1 && parts[parts.length-2].endsWith('[x]')) {
      targetType = parts[parts.length-1];
    }

    // A function to fix the code or print out a relevant error if it's not the right type
    const fixIt = (profile, ss, df, value, ...allowableTypes) => {
      let type;
      if (typeof targetType === 'undefined' || allowableTypes.indexOf(targetType) !== -1) {
        type = ss.type.find(t => {
          return allowableTypes.indexOf(t.code) >= 0;
        });
      }
      // If value is a function, it means it should be called w/ type to resolve to the real value
      if (typeof value === 'function') {
        value = value(type);
      }
      if (typeof type != 'undefined') {
        this.fixValueOnElement(profile, ss, df, value, type.code);
        if (dfIsNew && Object.keys(df).length > 2) {
          profile.differential.element.push(df);
        }
      } else {
        //13056 , 'Cannot fix ${target1} to ${value1} since ${target2} is not one of: ${allowableTypes1}.' , 'Unknown', 'errorNumber'
        logger.error({target1: target, value1 : fixedValue , target2 : target, allowableTypes1: allowableTypes.join(', ')}, '13056');
      }
    };

    // Guess the type based on the value (e.g., #bar is a code, 12 is an integer, etc)

    // Fixed codes (and fallback to URIs with a # character)
    const codeRE = /^(\w+:\/?\/?[^\s]+)?#[^\s]+$/; // regex that matches http://foo#bar or #bar
    if (codeRE.test(fixedValue)) {
      const allowableTypes = ['code', 'Coding', 'CodeableConcept'];
      if (fixedValue[0] !== '#') {
        allowableTypes.push('uri');
      }
      const value = (type) => {
        if (type && type.code !== 'uri') {
          const parts = fixedValue.split('#', 2);
          return new mdls.Concept(parts[0], parts[1]);
        }
        return fixedValue;
      };
      fixIt(profile, ss, df, value, ...allowableTypes);
      return;
    }

    // Fixed booleans
    const booleanRE = /^(true|false)$/; // regex that matches true or false
    if (booleanRE.test(fixedValue)) {
      fixIt(profile, ss, df, fixedValue === 'true', 'boolean');
      return;
    }

    // Fixed strings
    // NOTE that the grammar right now chokes if you try to fix to a string with a space in it
    const stringRE = /^(('(.*)')|("(.*)"))$/; // regex that matches 'hello' or "hello"
    const matches = fixedValue.match(stringRE);
    if (matches) {
      fixIt(profile, ss, df, fixedValue[0] === `'` ? matches[3] : matches[5], 'string');
      return;
    }

    // Fixed numbers (and fallback to 4-digit year-only dates)
    const numberRE = /^-?\d+(\.\d+)?$/; // regex that matches 10, 10.2, -10, -10.2, etc.
    if (numberRE.test(fixedValue)) {
      const isInteger = fixedValue.indexOf('.') === -1;
      const numValue = isInteger ? parseInt(fixedValue) : parseFloat(fixedValue);
      const allowableTypes = [];
      if (isInteger) {
        allowableTypes.push('integer');
        // if it's not negative, it could also be an unsignedInt or (maybe) positiveInt
        if (numValue >= 0) {
          allowableTypes.push('unsignedInt');
          // If it's not zero, it could be a positiveInt
          if (fixedValue > 0) {
            allowableTypes.push('positiveInt');
          }
        }
      }
      allowableTypes.push('decimal');
      // If it's a positive or negative 4-digit integer, it may be a year, so allow date/dateTime as well,
      // but add this to the end of allowable types, since we'll "prefer" an integer type if possible
      if (isInteger) {
        if ((numValue >= 0 && fixedValue.length === 4) || (numValue < 0 && fixedValue.length === 5)) {
          allowableTypes.push('date', 'dateTime');
        }
      }
      const value = (type) => type && ! type.code.startsWith('date') ? numValue : fixedValue;
      fixIt(profile, ss, df, value, ...allowableTypes);
      return;
    }

    // Fixed datesTimes (regex from FHIR spec)
    const dateRE = /^-?[0-9]{4}(-(0[1-9]|1[0-2])(-(0[0-9]|[1-2][0-9]|3[0-1])(T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]+)?(Z|(\+|-)((0[0-9]|1[0-3]):[0-5][0-9]|14:00)))?)?)?$/; // regex from FHIR spec
    if (dateRE.test(fixedValue)) {
      const allowableTypes = fixedValue.indexOf('T') >= 0 ? ['dateTime', 'instant'] : ['date', 'dateTime'];
      fixIt(profile, ss, df, fixedValue, ...allowableTypes);
      return;
    }

    // Fixed times
    const timeRE = /^([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]+)?$/; // regex from FHIR spec
    if (timeRE.test(fixedValue)) {
      fixIt(profile, ss, df, fixedValue, 'time');
      return;
    }

    // Fixed URIs
    const uriRE = /^\w+:\/?\/?[^\s]+$/; // regex that matches http://google.com or urn:1.2.3.4.5
    if (uriRE.test(fixedValue)) {
      fixIt(profile, ss, df, fixedValue, 'uri');
      return;
    }

    // If we got this far, it's a currently unsupported use case
    //13057 , 'Could not fix ${target1} to ${value1}; failed to detect compatible type for value ${value2}.' , 'Unknown', 'errorNumber'
    logger.error( {target1: target, value1: fixedValue, value2: fixedValue }, '13057' );
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
        //13017 , 'Incompatible cardinality (using aggregation). Source cardinality ${srcCardinality} does not fit in target cardinality ${targetCardinality}' , 'Unknown', 'errorNumber'
        logger.error( {srcCardinality: aggSourceCard.toString(), targetCardinality : targetCard}, '13017' );
        return;
      }
    } else {
      // When getting an aggregate cardinality, we may need to "override" a sliced array's cardinality with the
      // cardinality of the slice (rather than cardinality of the whole array).  This gives us more accurate
      // aggregated cardinality results.
      const cardOverride = {};
      const fieldTarget = FieldTarget.parse(rule.target);
      if (fieldTarget.hasSliceOnCommand() || fieldTarget.hasSliceAtCommand()) {
        // It's a slice so set the override cardinality for that path
        const sliceAt = fieldTarget.hasSliceAtCommand() ? fieldTarget.findSliceAtCommand().value : fieldTarget.target;
        cardOverride[sliceAt] = aggSourceCard; //?
      }
      const aggTargetCard = getAggregateFHIRElementCardinality(profile, snapshotEl, cardOverride);
      if (aggSourceCard.equals(aggTargetCard)) {
        // For now we let it pass, but should we be checking to ensure all intermediate paths on target have profiled cardinality?
      } else if (aggSourceCard.fitsWithinCardinalityOf(aggTargetCard)) {
        // If the aggSourceCard is 0..0, our job is easy.  Just do it.
        if (aggSourceCard.isZeroedOut) {
          setCardinalityOnFHIRElements(aggSourceCard, snapshotEl, differentialEl);
          return;
        }
        // Check if all parts of target path are mapped.  If they aren't, then constraining the cardinality is ambiguous
        const targetPath = FieldTarget.parse(rule.target).target.split('.');
        let isMatch = true;
        for (let i=0; i < targetPath.length; i++) {
          const tp = targetPath.slice(0, i+1).join('.');
          if (tp.endsWith('[x]')) {
            // Due to our target path syntax, this looks like an intermediate path, but it isn't really
            continue;
          } else if (cardOverride[tp]) {
            // This cardinality is specified by a slice, so we can continue since that's based on a mapping
            continue;
          } else if (!map.rules.some(r => typeof r.target !== 'undefined' && FieldTarget.parse(r.target).target == tp)) {
            isMatch = false;
            break;
          }
        }
        if (!isMatch) {
          //13018 , 'Cannot constrain cardinality to ${card} because cardinality placement is ambiguous. Explicitly constrain' , 'parent elements in target path.', 'errorNumber'
          logger.error( {card : aggSourceCard.toString()}, '13018');
          return;
        }

        // Whole target path is mapped so now we just have to try to apply a constraint to the last part of the path
        // that will get us to the cardinality we're looking for.
        const parentEl = common.getSnapshotElementById(profile, targetID.substr(0, targetID.lastIndexOf('.')));
        const aggParentCard = getAggregateFHIRElementCardinality(profile, parentEl, cardOverride);

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
          //13019 , 'Cannot constrain cardinality to ${card} because there is no tail cardinality min that can get us there' , 'Unknown', 'errorNumber'
          logger.error({card: aggSourceCard.toString() } , '13019' );
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
          //13020 , 'Cannot constrain cardinality to ${card} because there is no tail cardinality max that can get us there' , 'Unknown', 'errorNumber'
          logger.error({card: aggSourceCard.toString() }, '13020' );
          return;
        }

        const magicCard = new mdls.Cardinality(magicMin, magicMax);
        if (magicCard.fitsWithinCardinalityOf(targetCard)) {
          setCardinalityOnFHIRElements(magicCard, snapshotEl, differentialEl);
        } else {
          //13021 , 'Cannot constrain cardinality to ${card} because there is no tail cardinality that can get us there' , 'Unknown' , 'errorNumber'
          logger.error({card : aggSourceCard.toString()}, '13021' );
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
      const sourceIdentifier = common.choiceFriendlyEffectiveIdentifier(sourceValue);
      let sourceString = sourceIdentifier.fqn;
      if (!sourceIdentifier.isPrimitive) {
        const value = this._specs.dataElements.findByIdentifier(sourceIdentifier).value;
        if (value instanceof mdls.IdentifiableValue) {
          sourceString += `[Value: ${value.effectiveIdentifier.fqn}]`;
        } else if (value) {
          sourceString += `[Value: ${value.toString()}]`;
        }
      }

      const sMapsTo = this._specs.maps.findByTargetAndIdentifier(this._target, sourceIdentifier);
      if (sMapsTo) {
        sourceString += ` (mapped to ${common.TargetItem.parse(sMapsTo.targetItem).target})`;
      }
      //13022 , 'Mismatched types. Cannot map ${sourceValue} to ${mapping}' , 'Find the EntryElement referenced in the error details and change it to match data type of target field'. 'Unknown', 'errorNumber'
      logger.error({sourceValue: sourceString, mapping: typesToString(snapshotEl.type) }, '13022');
      return;
    }

    const originalShort = snapshotEl.short;
    const originalDefinition = snapshotEl.definition;

    // If this is mapped from the element's value, make the definition refer to the element's definition
    if (def.description && rule.sourcePath.length === 1 && def.value) {
      const id = rule.sourcePath[0];
      const val = def.value;
      const isElementValue = id.isValueKeyWord
        || (val.identifier && val.getPossibleIdentifiers().some(vid => vid.equals(id)))
        || (val.options && val.aggregateOptions.some(o => id.equals(o.identifier) || id.equals(o.effectiveIdentifier)));
      if (isElementValue) {
        const desc = `${common.capitalize(common.valueName(val))} representing ${common.lowerFirst(common.trim(def.description))}`;
        snapshotEl.short = differentialEl.short = this.getDescriptionAsShort(def.identifier, def.identifier.name);
        if (originalDefinition !== desc) {
          snapshotEl.definition = differentialEl.definition = desc;
        }
      }
    }

    // If the original short definition was an enumeration, we should try to replace it if possible
    if (originalShort && originalShort.indexOf('|') !== -1) {
      // Only replace it if we provide a value set constraint
      if (sourceValue.constraintsFilter.own.valueSet.hasConstraints) {
        const vsURL = sourceValue.constraintsFilter.own.valueSet.constraints[0].valueSet;
        const short = this.getShortFromValueSet(vsURL);
        if (short && originalShort !== short) {
          snapshotEl.short = differentialEl.short = short;
          // Note: Only change the definition if we've changed the short
          const definition = this.getDefinitionFromValueSet(vsURL);
          if (definition && originalDefinition !== definition) {
            snapshotEl.definition = differentialEl.definition = definition;
          }
        }
      }
    } else if (sourceValue.constraintsFilter.own.type.hasConstraints) {
      // If original short has not changed yet, and we have a single source identifier, update it
      const sourceIdentifier = common.choiceFriendlyEffectiveIdentifier(sourceValue);
      if (sourceIdentifier && snapshotEl.definition === originalDefinition) {
        const description = this.getDescription(sourceIdentifier);
        if (description != null && description !== originalDefinition) {
          snapshotEl.short = this.getDescriptionAsShort(sourceIdentifier);
          if (snapshotEl.short !== originalShort) {
            differentialEl.short = snapshotEl.short;
          }
          // Update definition last to maintain order of short, definition
          snapshotEl.definition = differentialEl.definition = description;
        }
      }
    }

    return;
  }

  getShortFromValueSet(vsURL) {
    let short;
    if (vsURL.startsWith('http://hl7.org/fhir/ValueSet' || vsURL.startsWith('urn:tbd'))) {
      // It's an HL7 or TBD VS.  Just leave what's there in place...
    } else {
      if (vsURL.startsWith(this._config.projectURL)) {
        // It's an CIMPL-defined value set, so we can be smart about constructing a short
        const items = [];
        const vs = this._specs.valueSets.findByURL(vsURL);
        if (vs) {
          for (const r of vs.rules) {
            if (r instanceof mdls.ValueSetIncludesCodeRule) {
              items.push(r.code.code);
            } else if (r instanceof mdls.ValueSetIncludesDescendentsRule) {
              items.push(`descendents of ${r.code.code}`);
            } else if (r instanceof mdls.ValueSetExcludesDescendentsRule) {
              items.push(`not descendents of ${r.code.code}`);
            } else if (r instanceof mdls.ValueSetIncludesFromCodeRule) {
              items.push(`codes from ${r.code.code}`);
            } else if (r instanceof mdls.ValueSetIncludesFromCodeSystemRule) {
              items.push(`codes from ${r.system}`);
            }
          }
          short = items.slice(0, 5).join(' | ');
          if (items.length > 5) {
            short += ' | ...';
          }
        }
      }

      if (short == null) {
        // It's an external value set, so just reference it
        short = `codes from ${vsURL}`;
      }
    }
    return common.trim(short);
  }

  getDefinitionFromValueSet(vsURL) {
    let definition;
    if (vsURL.startsWith('http://hl7.org/fhir/ValueSet' || vsURL.startsWith('urn:tbd'))) {
      // It's an HL7 or TBD VS.  Just leave what's there in place...
    } else if (vsURL.startsWith(this._config.projectURL)) {
      // It's a CIMPL-defined value set, so we can be smart about constructing a short
      const vs = this._specs.valueSets.findByURL(vsURL);
      if (vs && vs.description && vs.description.length > 0) {
        definition = vs.description;
      }
    }
    return common.trim(definition);
  }

  knownMappingIssue(lhs, rhs, sourcePath, value, types) {
    const identifier = sourcePath[sourcePath.length - 1];
    if (identifier.fqn == lhs || (value && value.identifier && value.identifier.fqn == lhs)) {
      // left-hand side is satisfied, now check right-hand side
      const profile = this._fhir.find(rhs);
      return types.some(t => t.code == rhs || (profile && MVH.typeHasProfile(t, profile.url))
        || (t.code == 'Reference' && (profile && MVH.typeHasTargetProfile(t, profile.url))));
    }
    return false;
  }

  findAllowedConversionTargetTypes(sourceIdentifier, targetTypes) {
    // TODO: Should we consider the sourceIdentifier's basedOn elements as well?
    const fqn = sourceIdentifier.fqn;
    const allowedTargetTypes = [];
    if (Array.isArray(allowedConversions[fqn])) {
      for (const type of allowedConversions[fqn]) {
        const profile = this._fhir.find(type);
        const allowedTypes = targetTypes.filter(t => t.code == type
          || (profile && MVH.typeHasProfile(t, profile.url)
          || (profile && t.code == 'Reference' && MVH.typeHasTargetProfile(t, profile.url))));
        allowedTargetTypes.push(...allowedTypes);
      }
    }
    return allowedTargetTypes;
  }

  processValueToFieldType(map, sourcePath, sourceValue, profile, snapshotEl, differentialEl) {

    // NOTE: Very similar (but slightly different) code exists in #applyOwnTypeConstraintsOnExtension.  At some point
    // these could potentially be refactored, but to do it in a non-hacky way will require some work.  Until then, if
    // something changes in this function, check to see if it should also change in #applyOwnTypeConstraintsOnExtension.

    const clonedPath = sourcePath.map(p => p.clone());
    const sourceIdentifier = common.choiceFriendlyEffectiveIdentifier(sourceValue);
    const targetTypes = snapshotEl.type;

    // If the source is a primitive, then the target must be the same primitive!
    if (sourceIdentifier.isPrimitive) {
      const matchedTypes = targetTypes.filter(t => sourceIdentifier.name == t.code);
      if (matchedTypes.length > 0) {
        this.markSelectedOptionsInChoice(targetTypes, matchedTypes);
        this.applyConstraints(sourceValue, profile, snapshotEl, differentialEl, false, sourcePath);
        return [clonedPath];
      }
      const allowedConvertedTypes = this.findAllowedConversionTargetTypes(sourceIdentifier, targetTypes);
      if (allowedConvertedTypes.length > 0) {
        this.markSelectedOptionsInChoice(targetTypes, allowedConvertedTypes);
        this.applyConstraintsForConversion(sourceValue, profile, snapshotEl, differentialEl, sourcePath);
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
    const originalTargetTypes = common.cloneJSON(targetTypes);
    const matchedType = this.findMatchingType(sourceValue, targetTypes);
    if (typeof matchedType !== 'undefined') {
      // We got a match!
      const sourceProfile = this.lookupProfile(sourceIdentifier, true, false);
      // Check to see if this is trying to map a different element than the one that was previously mapped.
      const mappedProfiles = typeof MVH.typeProfile(matchedType) !== 'undefined' ? MVH.typeProfile(matchedType) : MVH.typeTargetProfile(matchedType);
      if (typeof mappedProfiles !== 'undefined' && mappedProfiles.length > 0 && !mappedProfiles.includes(sourceProfile.url)) {
        // It's trying to map a different element than the one that was previously mapped.  Conflict!
        // 03001, 'Trying to map ${profile} to ${code}  but ${otherProfile} was previously mapped to it', 'Unknown', 'errorNumber'
        logger.warn({ profile: sourceProfile.url, code: matchedType.code, otherProfile: mappedProfiles.join(' | ') }, '03001');
      } else {
        // We successfully mapped the type, so we need to apply the differential and constraints
        if (typeof mappedProfiles !== 'undefined' && !typesHaveSameCodesProfilesAndTargetProfiles(originalTargetTypes, snapshotEl.type)) {
          differentialEl.type = snapshotEl.type;
        }
        this.applyConstraints(sourceValue, profile, snapshotEl, differentialEl, false, sourcePath);
        matchedPaths.push(clonedPath);
      }
    } else {
      const allowedConvertedTypes = this.findAllowedConversionTargetTypes(sourceIdentifier, targetTypes);
      if (allowedConvertedTypes.length > 0) {
        this.markSelectedOptionsInChoice(targetTypes, allowedConvertedTypes);
        this.applyConstraintsForConversion(sourceValue, profile, snapshotEl, differentialEl, sourcePath);
        matchedPaths.push(clonedPath);
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
            const fullPath2 = [...clonedPath, common.choiceFriendlyEffectiveIdentifier(field)];
            if (!map.rulesFilter.withSourcePath(fullPath).hasRules && !map.rulesFilter.withSourcePath(fullPath2).hasRules) {
              // No mapping rules exist for this required field, so it's not appropriate to map the value
              return matchedPaths.length > 0 ? matchedPaths : undefined;
            }
          }
        }
      }

      let sourceElValue = sourceEl.value.clone();
      if (sourceValue._derivedFromIncludesTypeConstraint) {
        sourceElValue._derivedFromIncludesTypeConstraint = sourceValue._derivedFromIncludesTypeConstraint;
      }
      // If it's a choice, but it has a type constraint, we need to re-model it appropriately
      if (sourceElValue instanceof mdls.ChoiceValue) {
        const typeCst = sourceValue.constraintsFilter.type.constraints.filter(c => c.onValue);
        typeCst.push(...sourceElValue.constraintsFilter.type.own.constraints);
        if (typeCst.length === 1) {
          // Find the IdentifierValue in the choices by first trying to get an exact match
          let matchingOption = sourceElValue.aggregateOptions.find(o => typeCst[0].isA.equals(o.effectiveIdentifier));
          // If not found, look based on base types as well
          if (matchingOption == null) {
            const baseTypes = this.getRecursiveBasedOns(typeCst[0].isA);
            matchingOption = sourceElValue.aggregateOptions.find(o => baseTypes.some(id => id.equals(o.effectiveIdentifier)));
          }

          if (matchingOption != null) {
            const origConstraints = sourceElValue.constraints.length > 0 ? sourceElValue.constraints.map(c => c.clone()) : [];
            sourceElValue = matchingOption.clone();
            origConstraints.forEach(c => {
              if (!c.equals(typeCst)) {
                sourceElValue.addConstraint(c);
              }
            });
          }
        } else if (typeCst.length > 1) {
          // This shouldn't happen
        }
      }

      // It's potentially appropriate to map the value
      if (sourceElValue instanceof mdls.IdentifiableValue) {
        const mergedValue = this.mergeConstraintsToChild(sourceValue.constraints, sourceElValue, true);
        const newPath = [...clonedPath, mergedValue.effectiveIdentifier];
        const valMatchedPaths = this.processValueToFieldType(map, newPath, mergedValue, profile, snapshotEl, differentialEl);
        if (typeof valMatchedPaths !== 'undefined') {
          matchedPaths.push(...valMatchedPaths);
        }
      } else if (sourceElValue instanceof mdls.ChoiceValue) {
        for (const opt of sourceElValue.aggregateOptions) {
          if (opt instanceof mdls.IdentifiableValue) {
            // First merge the choicevalue onto the option value (TODO: Will this work right w/ aggregate options?)
            let mergedValue = this.mergeConstraintsToChild(sourceElValue.constraints, opt);
            // Then merge the sourceValue onto the merged option value
            mergedValue = this.mergeConstraintsToChild(sourceValue.constraints, mergedValue);
            const newPath = [...clonedPath, common.choiceFriendlyEffectiveIdentifier(mergedValue)];
            const optMatchedPaths = this.processValueToFieldType(map, newPath, mergedValue, profile, snapshotEl, differentialEl);
            if (optMatchedPaths) {
              let loggedWarning = false; // Only need to log the warning once per choice
              for (const omp of optMatchedPaths) {
                if (matchedPaths.some(mp => mp !== omp && pathsAreEqual(mp, omp))) {
                  if (!loggedWarning) {
                    // 03002, 'Choice has equivalent types  so choice options may overwrite or override each other when mapped to FHIR.', 'Unknown', 'errorNumber'
                    logger.warn('03002');
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

  findMatchingType(sourceValue, targetTypes) {
    const sourceIdentifier = common.choiceFriendlyEffectiveIdentifier(sourceValue);
    const sourceMap = this._specs.maps.findByTargetAndIdentifier(this._target, sourceIdentifier);
    if (sourceMap == null) {
      return;
    }

    let matchedType;
    const sourceProfile = this.lookupProfile(sourceIdentifier, true, true);
    const allowableTargetTypes = common.getFHIRTypeHierarchy(this._fhir, common.TargetItem.parse(sourceMap.targetItem).target);
    const allowableTargetProfiles = allowableTargetTypes.map(t => this._fhir.find(t).url);
    const basedOnTargetProfiles = this.getRecursiveBasedOns(sourceIdentifier).map(b => common.fhirURL(b, this._config.fhirURL));
    for (let i=0; i < targetTypes.length; i++) {
      const t = targetTypes[i];
      const originalProfiles = this.optionIsSelected(t) ? t._originalProfiles : MVH.typeProfile(t);
      const originalTargetProfiles = this.optionIsSelected(t) ? t._originalTargetProfiles : MVH.typeTargetProfile(t);
      // @ts-ignore
      if (allowableTargetTypes.includes(t.code) || allowableTargetProfiles.some(tp => originalProfiles && originalProfiles.includes(tp)) || basedOnTargetProfiles.some(bp => originalProfiles && originalProfiles.includes(bp))) {
        matchedType = t;
        // Only change the type if it hasn't already been selected (e.g. changed) by the mapper
        // or if the original type is a supertype (i.e., a profile of one of its basedOn types)
        if (this.optionIsSelected(t)) {
          // This type has already been mapped to once.  Determine if we should add another type to represent
          // additional applicable profiles.  This is done by checking if its part of an includes type slice, and/or
          // by checking if the new profile fits in the old type / profile.
          if (common.isCustomProfile(sourceProfile)) {
            // @ts-ignore
            if (originalProfiles == null || allowableTargetProfiles.some(tp => originalProfiles.includes(tp)) || basedOnTargetProfiles.some(bp => originalProfiles.includes(bp))) {
              if (sourceValue._derivedFromIncludesTypeConstraint) {
                // This is the result of an includes type slicing, so we want the new profile to replace the existing one
                // (which was copied over in the slicing operation), since it's a sub-type of the existing profile
                MVH.setTypeProfile(sourceProfile, t, sourceProfile.url);
              } else {
                // If the profiles are different, we should represent both the existing and the new profile, so create
                // a new type for the additional profile and splice it into the types
                if (!MVH.typeHasProfile(t, sourceProfile.url)) {
                  matchedType = MVH.addTypeProfile(sourceProfile, targetTypes, t.code, sourceProfile.url, i+1);
                }
              }
              // Mark it again to ensure it is set at priority 1
              this.markSelectedOptionsInChoice(targetTypes, [matchedType]);
            }
            // else it wasn't a valid sub-type of the original type, and this will cause an error further down
          } else {
            // The existing type narrows it to a profile, but since this new type represents a no-profile type,
            // remove the profile from the existing type
            delete(t.profile);
            // Mark it again to ensure it is set at priority 1
            this.markSelectedOptionsInChoice(targetTypes, [matchedType]);
          }
          break;
        } else {
          // This is the first time mapping to this type, so overwrite profile if applicable, and mark as selected
          if (common.isCustomProfile(sourceProfile) || sourceProfile.id !== t.code) {
            if (MVH.typeProfile(t) != null && MVH.typeProfile(t).length > 0) {
              // keep track of the original profile so we can check on other options in the future
              t._originalProfiles = MVH.typeProfile(t);
            }
            MVH.setTypeProfile(sourceProfile, t, sourceProfile.url);
          }
          this.markSelectedOptionsInChoice(targetTypes, [t]);
        }
        break;
      // @ts-ignore
      } else if (t.code == 'Reference' && (allowableTargetProfiles.some(tp => originalTargetProfiles && originalTargetProfiles.includes(tp)) || basedOnTargetProfiles.some(bp => originalTargetProfiles && originalTargetProfiles.includes(bp)))) {
        matchedType = t;
        // Only change the type if it hasn't already been selected (e.g. changed) by the mapper
        // or if the previous is a supertype (i.e., a profile of one of its basedOn types)
        if (this.optionIsSelected(t)) {
          // This type has already been mapped to once, and we've already determined that the new profile is a match.
          if (sourceValue._derivedFromIncludesTypeConstraint) {
            // This is the result of an includes type slicing, so we want the new profile to replace the existing one
            // (which was copied over in the slicing operation), since it's a sub-type of the existing profile
            MVH.setTypeTargetProfile(sourceProfile, t, sourceProfile.url);
          } else {
            // If the profiles are different, we should represent both the existing and the new profile, so create
            // a new type for the additional profile and splice it into the types
            if (!MVH.typeHasTargetProfile(t, sourceProfile.url)) {
              matchedType = MVH.addTypeTargetProfile(sourceProfile, targetTypes, t.code, sourceProfile.url, i+1);
            }
          }
          // Mark it again to ensure it is set at priority 1
          this.markSelectedOptionsInChoice(targetTypes, [matchedType]);
        } else {
          // This is the first time mapping to this type, so overwrite targetProfile and mark as selected
          t._originalTargetProfiles = MVH.typeTargetProfile(t);
          MVH.setTypeTargetProfile(sourceProfile, t, sourceProfile.url);
          this.markSelectedOptionsInChoice(targetTypes, [t]);
        }
        break;
      }
    }
    return matchedType;
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
      //13023 , 'Cannot resolve element definition for ${element}' , 'Unknown' , 'errorNumber'
      logger.error( { element: identifier.fqn  }, '13023' );
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
    for (const t of selectedTypes) {
      t._shrTypePriority = 1;
    }
  }

  optionIsSelected(option) {
    return option && option._shrTypePriority ? true : false;
  }

  applyConstraints(sourceValue, profile, snapshotEl, differentialEl, isExtension, sourcePath) {
    let [snapshotElForCodishConstraints, differentialElForCodishConstraints, sourcePathForCodishConstraints, addedType] = [snapshotEl, differentialEl, sourcePath, false];
    if (this.isUnitConceptPathOnQuantityBasedProfile(profile, sourcePath)) {
      // TODO: might need to add the type
      snapshotElForCodishConstraints = profile.snapshot.element[0];
      if (snapshotElForCodishConstraints.type == null) {
        snapshotElForCodishConstraints.type = [{code: 'Quantity'}];
        addedType = true;
      }
      differentialElForCodishConstraints = common.getDifferentialElementById(profile, snapshotElForCodishConstraints.id, true);
      sourcePathForCodishConstraints = [];
    }
    // As a *very* special (and unfortunate) case, we must special-case quantity.  Essentially, the problem is that
    // Quantity maps Units[concept] onto itself, so the constraints on Units[concept] need to be applied to Quantity instead.
    const choiceFriendlyId = common.choiceFriendlyEffectiveIdentifier(sourceValue);
    if ((sourceValue.identifier && sourceValue.identifier.isQuantity) || (choiceFriendlyId && choiceFriendlyId.isQuantity)) {
      const quantityNS = (sourceValue.identifier && sourceValue.identifier.isQuantity) ? sourceValue.identifier.namespace : choiceFriendlyId.namespace;
      // Move all constraints from Units[concept] to the Quantity, but first -- clone!
      sourceValue = sourceValue.clone();
      const unitsConceptCsts = sourceValue.constraintsFilter.withPath([new mdls.Identifier(quantityNS, 'Units'), new mdls.PrimitiveIdentifier('concept')]).constraints;
      for (const cst of unitsConceptCsts) {
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
      [snapshotEl, differentialEl] = this.addExplicitChoiceElement(common.choiceFriendlyEffectiveIdentifier(sourceValue), profile, snapshotEl, differentialEl);
    }

    // First handle own constraints
    this.applyOwnValueSetConstraints(sourceValue, profile, snapshotElForCodishConstraints, differentialElForCodishConstraints, sourcePathForCodishConstraints);
    this.applyOwnCodeConstraints(sourceValue, profile, snapshotElForCodishConstraints, differentialElForCodishConstraints);
    if (addedType) {
      delete snapshotElForCodishConstraints.type;
      delete differentialElForCodishConstraints.type;
    }
    this.applyOwnIncludesCodeConstraints(sourceValue, profile, snapshotEl, differentialEl);
    this.applyOwnBooleanConstraints(sourceValue, profile, snapshotEl, differentialEl);
    this.applyOwnFixedValueConstraints(sourceValue, profile, snapshotEl, differentialEl);
    if (isExtension) {
      this.applyOwnIncludesTypeConstraintsOnExtension(sourceValue, profile, snapshotEl, differentialEl);
    }

    // Handle child constraints if necessary -- this will require "unrolling" the element
    if (sourceValue.constraintsFilter.child.hasConstraints) {
      // Unroll the current element so we can dive into it
      this.unrollElement(common.choiceFriendlyEffectiveIdentifier(sourceValue), profile, snapshotEl);

      // Organize constraints by path
      const pathToConstraintMap = new Map();
      for (const cst of sourceValue.constraintsFilter.child.constraints) {
        let path = cst.path.map(p => `(${p.fqn})`).join('.');
        if (cst.onValue) {
          path = path.length > 0 ? `${path}.Value` : 'Value';
        }
        if (!pathToConstraintMap.has(path)) {
          pathToConstraintMap.set(path, []);
        }
        pathToConstraintMap.get(path).push(cst);
      }
      if (isExtension) {
        // Iterate by path-grouped constraints
        for (const csts of pathToConstraintMap.values()) {
          const path = csts[0].path.slice();
          if (csts[0].onValue) {
            path.push(new mdls.Identifier('', '_Value'));
          }
          const element = this.getElementInExtension([common.choiceFriendlyEffectiveIdentifier(sourceValue), ...path], profile, snapshotEl);
          if (typeof element === 'undefined') {
            //13024 , 'Failed to resolve element path from ${element1} to ${path1}' , 'Unknown', 'errorNumber'
            logger.error({element1 : snapshotEl.id, element2 : path }, '13024' );
            continue;
          }
          let childSourceValue;
          const childIdentifier = path[path.length-1];
          if (childIdentifier.isValueKeyWord) {
            const rootIdentifier = path.length > 1 ? path[path.length-2] : sourceValue.identifier;
            const def = this._specs.dataElements.findByIdentifier(rootIdentifier);
            childSourceValue = def.value.clone();
          } else {
            childSourceValue = new mdls.IdentifiableValue(path[path.length-1]);
          }
          for (const childCst of csts) {
            // Add the constraint, cloning it and making its path at the root
            const newChildCst = childCst.clone().withPath([]);
            if (newChildCst.onValue) {
              newChildCst.onValue = false;
            }
            childSourceValue.addConstraint(newChildCst);
          }
          // There probably isn't a differential element, so check and create if necessary
          let diffElement = common.getDifferentialElementById(profile, element.id);
          const dfIsNew = (typeof diffElement === 'undefined');
          if (dfIsNew) {
            diffElement = { id: element.id, path: element.path };
          }
          this.applyOwnTypeConstraintsOnExtension(childSourceValue, profile, element, diffElement);
          this.applyOwnValueSetConstraints(childSourceValue, profile, element, diffElement, sourcePath);
          this.applyOwnCodeConstraints(childSourceValue, profile, element, diffElement);
          this.applyOwnIncludesCodeConstraints(childSourceValue, profile, element, diffElement);
          this.applyOwnBooleanConstraints(childSourceValue, profile, element, diffElement);
          this.applyOwnFixedValueConstraints(childSourceValue, profile, element, diffElement);
          if (childSourceValue.constraintsFilter.includesType.hasConstraints) {
            // 03014, 'Nested include types are currently not supported when applied to extensions', 'Unknown', 'errorNumber'
            logger.warn('03014');
          }
          // TODO: Do we need to do anything special for IncludesTypeConstraints?
          if (dfIsNew && Object.keys(diffElement).length > 2) {
            profile.differential.element.push(diffElement);
          }

          // Only push the mapping for nested properties (the top property is already represented in a mapping)
          if (path.length > 0) {
            const shrMap = [common.choiceFriendlyEffectiveIdentifier(sourceValue), ...path].map((pathElem) => {
              return `<${pathElem.fqn}>`;
            }).join('.');
            pushShrMapToElementMappings(shrMap, element, diffElement);
          }
        }
      } else {
        // Determine the unique subpaths which must be addressed
        const cstPaths = [];
        for (const cst of sourceValue.constraintsFilter.child.constraints) {
          const cstPath = cst.path.slice();
          if (cst.onValue) {
            cstPath.push(new mdls.Identifier('', '_Value'));
          }
          if(!cstPaths.some(cp => common.equalShrElementPaths(cp, cstPath))) {
            cstPaths.push(cstPath);
          }
        }
        // For each subpath, try to find what it maps to and then apply the constraints
        for (const cstPath of cstPaths) {
          const sourceIdentifier = common.choiceFriendlyEffectiveIdentifier(sourceValue);
          const targetSubPath = this.findTargetFHIRPath(sourceIdentifier, cstPath);
          if (targetSubPath) {
            // Get the childValue with all constraints merged to it
            const def = this._specs.dataElements.findByIdentifier(sourceIdentifier);
            const childValue = this.findValueByPath(cstPath, def, false, sourceValue.constraints);
            // Get the target snapshot and differential elements
            const targetPath = `${snapshotEl.path}.${targetSubPath}`;
            const fieldTarget = new FieldTarget(targetPath.slice(targetPath.indexOf('.')+1)); // Remove resource prefix
            const targetSS = this.getSnapshotElementForFieldTarget(profile, fieldTarget, childValue);
            const targetDf = common.getDifferentialElementById(profile, targetSS.id, true);
            // Since applyConstraints doesn't apply cardinality constraints, do that now before calling applyConstraints
            const targetCard = getFHIRElementCardinality(targetSS);
            if (childValue.effectiveCard.fitsWithinCardinalityOf(targetCard)) {
              setCardinalityOnFHIRElements(childValue.effectiveCard, targetSS, targetDf);
            } else {
              //13014 , 'Cannot constrain cardinality from ${cardinality1} to ${cardinality2} ' , 'Unknown' , 'errorNumber'
              logger.error( {cardinality1: targetCard.toString(), cardinality2 : childValue.effectiveCard.toString()}, '13014');
            }
            // Call applyConstraints to apply any other constraints to the child value
            this.applyConstraints(childValue, profile, targetSS, targetDf, false, cstPath);
          } else {
            const friendlyPath = [sourceIdentifier, ...cstPath].map(id => id.name).join('.');
            //13060 , 'Could not determine how to map nested value (${elementPath}) to FHIR profile.'
            logger.error( {elementPath: friendlyPath }, '13060');
          }
        }
      }
    }
  }

  // In the profiles, type constraints are applied as we traverse the path, but this is not so in extensions since we
  // traverse extensions in a different way (by necessity).  Instead, we must apply the type constraints separately.
  applyOwnTypeConstraintsOnExtension(sourceValue, profile, snapshotEl, differentialEl) {

    // NOTE: Very similar (but slightly different) code exists in #processValueToFieldType.  At some point these could
    // potentially be refactored, but to do it in a non-hacky way will require some work.  Until then, if something
    // changes in this function, check to see if it should also change in #processValueToFieldType.

    const typeConstraints = sourceValue.constraintsFilter.own.type.constraints;
    if (typeConstraints.length > 0) {
      [snapshotEl, differentialEl] = this.findConstrainableElement(sourceValue, profile, snapshotEl, differentialEl);

      const sourceIdentifier = common.choiceFriendlyEffectiveIdentifier(sourceValue);
      const targetTypes = snapshotEl.type;

      // If the source is a primitive, then the target must be the same primitive!
      if (sourceIdentifier.isPrimitive) {
        const matchedTypes = targetTypes.filter(t => sourceIdentifier.name == t.code);
        if (matchedTypes.length > 0) {
          this.markSelectedOptionsInChoice(targetTypes, matchedTypes);
          return;
        }
        const allowedConvertedTypes = this.findAllowedConversionTargetTypes(sourceIdentifier, targetTypes);
        if (allowedConvertedTypes.length > 0) {
          this.markSelectedOptionsInChoice(targetTypes, allowedConvertedTypes);
          return;
        }
        return;
      }

      // It's a non-primitive source type.  First check if the field is mapped to a BackboneElement.
      if (targetTypes.length == 1 && targetTypes[0].code == 'BackboneElement') {
        // TODO: Determine what to do with backbone elements.
        return;
      }

      // Check if the source field has a mapping to a FHIR profile.  If so, and it matches target, apply the profile to the target
      const originalTargetTypes = common.cloneJSON(targetTypes);
      const matchedType = this.findMatchingType(sourceValue, targetTypes);
      if (typeof matchedType !== 'undefined') {
        // We got a match!
        const sourceProfile = this.lookupProfile(sourceIdentifier, true, false);
        // Check to see if this is trying to map a different element than the one that was previously mapped.
        const mappedProfiles = typeof MVH.typeProfile(matchedType) !== 'undefined' ? MVH.typeProfile(matchedType) : MVH.typeTargetProfile(matchedType);
        if (typeof mappedProfiles !== 'undefined' && mappedProfiles.length > 0 && !mappedProfiles.includes(sourceProfile.url)) {
          // It's trying to map a different element than the one that was previously mapped.  Conflict!
          // 03001, 'Trying to map ${profile} to ${code}  but ${otherProfile} was previously mapped to it', 'Unknown', 'errorNumber'
          logger.warn({ profile: sourceProfile.url, code: matchedType.code, otherProfile: mappedProfiles.join(' | ') }, '03001');        } else {
          // We successfully mapped the type, so we need to apply the definition and update the differential
          let short = this.getDescriptionAsShort(sourceIdentifier);
          short = short ? `${sourceIdentifier.name}: ${short}` : sourceIdentifier.name;
          snapshotEl.short = differentialEl.short = short;
          snapshotEl.definition = differentialEl.definition = this.getDescription(sourceIdentifier, sourceIdentifier.name);
          if (typeof mappedProfiles !== 'undefined' && !typesHaveSameCodesProfilesAndTargetProfiles(originalTargetTypes, snapshotEl.type)) {
            differentialEl.type = snapshotEl.type;
          }
          return;
        }
      } else {
        const allowedConvertedTypes = this.findAllowedConversionTargetTypes(sourceIdentifier, targetTypes);
        if (allowedConvertedTypes.length > 0) {
          this.markSelectedOptionsInChoice(targetTypes, allowedConvertedTypes);
          return;
        }
      }

      // TODO: Do we need to consider mapping based on values (like in processValueToFieldType?)
    }
  }

  // In the profiles, includes type constraints are applied as slicing directives to the mapping statements, but since
  // extensions don't have mapping statements (by definition), we can't really take this approach for extensions.
  // Instead, we must apply the type constraints separately.
  applyOwnIncludesTypeConstraintsOnExtension(sourceValue, profile, snapshotEl, differentialEl) {

    // NOTE: Very similar (but slightly different) code exists in #processValueToFieldType.  At some point these could
    // potentially be refactored, but to do it in a non-hacky way will require some work.  Until then, if something
    // changes in this function, check to see if it should also change in #processValueToFieldType.

    const ictConstraints = sourceValue.constraintsFilter.own.includesType.constraints;
    if (ictConstraints.length === 0) {
      return;
    }

    // To apply IncludesType constraints to extensions, we need to slice them.  So apply the slicing and discriminator
    for (const ictConstraint of ictConstraints) {
      const fieldTarget = new FieldTarget(snapshotEl.id.substr(snapshotEl.id.indexOf('.')+1));
      fieldTarget.addSliceOnCommand('valueReference.reference.resolve()');
      fieldTarget.addSliceOnTypeCommand('profile');
      fieldTarget.addSliceStrategyCommand('includes');
      const slice = this.createSliceFromBase(profile, snapshotEl, ictConstraint.isA.name, fieldTarget, sourceValue, ictConstraint.card);
      const sliceDf = common.getDifferentialElementById(profile, slice.id, true);
      let short = this.getDescriptionAsShort(ictConstraint.isA);
      short = short ? `${ictConstraint.isA.name}: ${short}` : ictConstraint.isA.name;
      slice.short = sliceDf.short = short;
      slice.definition = sliceDf.definition = this.getDescription(ictConstraint.isA, ictConstraint.isA.name);
      let [valueSnapshotEl, valueDifferentialEl] = this.findConstrainableElement(sourceValue, profile, slice);

      const type = this.findMatchingType(new mdls.IdentifiableValue(ictConstraint.isA), valueSnapshotEl.type);
      if (type != null) {
        if (valueDifferentialEl == null) {
          valueDifferentialEl = common.getDifferentialElementById(profile, valueSnapshotEl.id, true);
        }
        valueDifferentialEl.type = valueSnapshotEl.type;
      }
    }
  }

  findTargetFHIRPath(rootIdentifier, shrPath) {
    if (shrPath.length === 0) {
      return '';
    }

    // As a *very* special (and unfortunate) case, we must special-case quantity.  Essentially, the problem is that
    // Quantity maps Units[concept] onto itself, so the paths for Units[concept] need to be applied to Quantity instead.
    // E.g., system and code are actually at the *root* of Quantity
    if (rootIdentifier && rootIdentifier.isQuantity) {
      // Change path from Units[concept] to empty...
      if (shrPath.length >= 2 && new mdls.Identifier(rootIdentifier.namespace, 'Units').equals(shrPath[0]) && new mdls.PrimitiveIdentifier('concept').equals(shrPath[1])) {
        return this.findTargetFHIRPath(rootIdentifier, shrPath.slice(2));
      }
    }

    // Lookup rootIdentifier mapping
    const map = this._specs.maps.findByTargetAndIdentifier(this._target, rootIdentifier);
    // Look for fieldmapping w/ shrPath
    if (map) {
      const rules = map.rulesFilter.field.withSourcePath(shrPath).rules;
      if (rules.length > 0) {
        // There should only be one, so just grab it
        return rules[0].target;
      } else if (shrPath.length > 1) {
        // It couldn't find by the path, but if the path length is > 1, we should see if we can chain rules
        // together to get the right path (e.g., if the root is A and path is [B, C, D], then see if there is a rule
        // for A [B, C] and another rule for C [D] -- because this would also get us to the full path A [B, C, D]).
        for (let i=1; i < shrPath.length; i++) {
          const path1 = this.findTargetFHIRPath(rootIdentifier, shrPath.slice(0, shrPath.length-i));
          if (path1) {
            const path2 = this.findTargetFHIRPath(shrPath[shrPath.length-i-1], shrPath.slice(shrPath.length - i));
            if (path1 && path2) {
              return `${path1}.${path2}`;
            }
          }
        }
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
    } else if (shrPath.length <= 1) {
      // It's not simple, but we can't dig any deeper, so this must be it
      return snapshotEl;
    } else {
      const url = common.fhirURL(shrPath[1], this._config.fhirURL, 'extension');
      el = profile.snapshot.element.find(e => {
        return e.id.startsWith(snapshotEl.id) && e.path == `${snapshotEl.path}.extension`
          && e.type && e.type.some(t => MVH.typeHasProfile(t, url));
      });
    }
    if (el == null) {
      //13026 , 'Failed to resolve path from ${element1} to ${path1} ' , 'Unknown' , 'errorNumber'
      logger.error({element1:snapshotEl.id, path1: shrPath }, '13026');
      return;
    }
    if (el.type.length == 1 && el.type[0].code == 'Extension') {
      return this.getElementInExtension(shrPath.slice(1), profile, el);
    } else {
      // We hit a non-extension element, so do the standard element search from the parent extension down the rest of the path
      const targetRootPath = el.path.substring(el.path.lastIndexOf('.')+1);
      const targetSubPath = this.findTargetFHIRPath(shrPath[1], shrPath.slice(2));
      const fieldTarget = targetSubPath.length === 0 ? new FieldTarget(targetRootPath) : new FieldTarget(`${targetRootPath}.${targetSubPath}`);
      return this.getSnapshotElementFromParentToFieldTarget(profile, snapshotEl, fieldTarget);
    }
  }

  // When applying constraints to an extension, we need actually apply it to the extension's value (if present)
  findConstrainableElement(sourceValue, profile, snapshotEl, differentialEl) {
    if (snapshotEl.type.length === 1 && snapshotEl.type[0].code === 'Extension') {
      let valueEl = profile.snapshot.element.find(e => e.id.startsWith(snapshotEl.id) && /^.*\.value[^.]+$/.test(e.path));
      if (typeof valueEl === 'undefined') {
        this.unrollElement(common.choiceFriendlyEffectiveIdentifier(sourceValue), profile, snapshotEl);
        valueEl = profile.snapshot.element.find(e => e.id.startsWith(snapshotEl.id) && /^.*\.value[^.]+$/.test(e.path));
      }
      if (valueEl.max !== '0') {
        snapshotEl = valueEl;
        differentialEl = common.getDifferentialElementById(profile, snapshotEl.id, true);
      }
    }
    return [snapshotEl, differentialEl];
  }

  applyOwnValueSetConstraints(sourceValue, profile, snapshotEl, differentialEl, sourcePath) {
    const vsConstraints = sourceValue.constraintsFilter.own.valueSet.constraints;
    if (vsConstraints.length > 0) {
      [snapshotEl, differentialEl] = this.findConstrainableElement(sourceValue, profile, snapshotEl, differentialEl);
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
        //13027 , 'Unsupported binding strength: ${bindingStrength1}' , 'Unknown', 'errorNumber'
        logger.error( {bindingStrength1 : vsConstraint.bindingStrength }, '13027');
        return;
      }

      const bind = snapshotEl.binding;
      if (bind) {
        if (!allowedBindingStrengthChange(bind.strength, strength)) {
          //13028 , 'Cannot change binding strength from ${bindingStrength1} to ${bindingStrength2}' , 'Unknown', 'errorNumber'
          logger.error( {bindingStrength1: bind.strength, bindingStrength2: strength}, '13028');
          return;
        }

        const bindVSURI = MVH.edBindingValueSet(profile, snapshotEl, true);
        if (bindVSURI == vsURI) {
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
          if (!this.isValueSetSubsetOfOther(vsURI, bindVSURI)) {
            //13029 , 'Cannot override value set constraint from ${uri1} to ${uri2}' , 'Unknown' , 'errorNumber'
            logger.error({uri1: bindVSURI, uri2: vsURI}, '13029');
            return;
          }
        } else if (bind.strength == 'extensible') {
          if (!this.isValueSetSubsetOfOther(vsURI, bindVSURI)) {
            if (this._config.showDuplicateErrors || !this.shouldConsiderSnapshotElementVSConstraintDuplicate(profile, snapshotEl, sourcePath)) {
              //03003 , 'Overriding extensible value set constraint from ${vs1} to ${vs2}. Only allowed when new codes do not overlap meaning of old codes.' , 'Unknown' , 'errorNumber'
              logger.warn({vs1: bindVSURI, vs2: vsURI}, '03003' );
              // this is technically allowed, so don't return yet -- just continue...
            }
          }
        }
      }
      MVH.setEdBindingStrenghtAndValueSet(profile, snapshotEl, strength, vsConstraint.valueSet);
      differentialEl.binding = snapshotEl.binding;
      if (vsConstraints.length > 1) {
        //13030 , 'Found more than one value set to apply to ${element1}. This should never happen and is probably a bug in the tool.' , 'Unknown', 'errorNumber'
        logger.error({element1: snapshotEl.id }, '13030');
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

  /*
    Determines whether a ValueSetConstraint on a mapped element is inherited from a parent.
    Inheritance is determined by matching sourcePath of the mapping with fields from
    the mapped element, and determining inheritance status at each level of depth
  */
  shouldConsiderSnapshotElementVSConstraintDuplicate(profile, snapshotEl, sourcePath) {
    var vscIsDuplicate = false;

    const snapshotElNameIndex = profile.id.search(/-[A-Z]/);
    const snapshotElNamespace = profile.id.slice(0, snapshotElNameIndex).replace(/-/g, '.');
    const snapshotElName = profile.id.slice(snapshotElNameIndex + 1);
    const snapshotElID = { 'name': snapshotElName, 'namespace': snapshotElNamespace };
    const snapshotDataElement = this._specs.dataElements.findByIdentifier(snapshotElID);

    if (snapshotDataElement) {
      const pathClone = [...sourcePath]; //clone the source path to not mutate the original
      let currEl = snapshotDataElement;

      //Search the mapped element for relevant field (being mapped)
      //Use the full sourcePath array to capture 'submappings', e.g. a mapping on dataabsentreason.component
      while (pathClone.length > 1) {
        const pathID = pathClone.shift();
        let matchedField;
        const combinedFieldsAndValue = (currEl.fields && currEl.value) ? [currEl.value, ...currEl.fields] : (currEl.fields) ? currEl.fields : [currEl.value]; //potentially more thorough than current implentation, although tests show no difference

        if (snapshotEl.id.split(':').length > 0) { //This is used to determine whether or not this is an 'includesType' slice. Includes type slices have at least one ':' path
          //Handle normal slices

          //Find the field on the element
          //Additionally, account for TypeConstraints that would also match field's path
          matchedField = combinedFieldsAndValue.find(f => f.identifier && f.identifier.equals(pathID) || f.constraintsFilter.type.constraints.filter(c => c.isA.equals(pathID)).length > 0);

        } else {
          //Handle complex 'includesType' slices
          matchedField = combinedFieldsAndValue
            .filter(f => f.constraintsFilter.includesType.hasConstraints)
            .filter(f => f.constraintsFilter.includesType.constraints.some(c => c.isA.equals(pathID)));
          if (matchedField.length >= 1) {
            matchedField = matchedField[0];
          }
        }

        if (matchedField) {
          let compareToParentMaps = () => {
            //If it is inherited, check mapping differences with parent
            const childMaps = this._specs.maps.findByTargetAndIdentifier(this._target, currEl.identifier);
            const parentMaps = this._specs.maps.findByTargetAndIdentifier(this._target, currEl.basedOn[0]);
            if (!parentMaps || !childMaps) {
              return false;
            }

            //If it's 'inherited' then it has no further constraints (and especially no VS constraints).
            //Parent mapping comparison
            const matchedParentMapping = parentMaps.rules.filter(r=>r.sourcePath && r.sourcePath[0].equals(matchedField.identifier));
            const matchedChildMapping = childMaps.rules.filter(r=>r.sourcePath && r.sourcePath[0].equals(matchedField.identifier));
            const matchedIsDuplicate = JSON.stringify(matchedChildMapping) === JSON.stringify(matchedParentMapping);
            return matchedIsDuplicate;
          };

          if (!matchedField.inheritance) {
            //If it's not inherited, it's not a duplicate
            vscIsDuplicate = false;
            break;
          } else if (matchedField.inheritance == 'inherited') {
            vscIsDuplicate = compareToParentMaps();
            break;
          } else if (matchedField.inheritance == 'overridden') {
            //Only overrides relevant are ValueSetConstraint overrides, which would make it unique.
            //Although, with a Type Constraint, you should skip and check the Type'd Element
            if (!matchedField.constraintsFilter.valueSet.hasConstraints) {
              if (!matchedField.constraintsFilter.own.type.hasConstraints) {
                vscIsDuplicate = compareToParentMaps();
                break;
              }
            } else {
              vscIsDuplicate = false;
              break;
            }
          }
        } else {
          //If there are no matching fields, it's hard to determine.
          //Default to showing warning as opposed to suppressing
          vscIsDuplicate = false;
          break;
        }

        //If there was a type constraint field, and it is an original definition
        currEl = this._specs.dataElements.findByIdentifier(pathID);
      }
    }

    return vscIsDuplicate;
  }

  applyOwnCodeConstraints(sourceValue, profile, snapshotEl, differentialEl) {
    const codeConstraints = sourceValue.constraintsFilter.own.code.constraints;
    if (codeConstraints.length > 0) {
      [snapshotEl, differentialEl] = this.findConstrainableElement(sourceValue, profile, snapshotEl, differentialEl);
      this.fixCodeOnElement(sourceValue.identifier, profile, snapshotEl, differentialEl, codeConstraints[0].code);
      if (codeConstraints.length > 1) {
        //13031 , 'Found more than one code to fix on ${element1}. This should never happen and is probably a bug in the tool.' , 'Unknown', 'errorNumber'
        logger.error({element1 : snapshotEl.id}, '13031');
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
      const sliceName = `Includes_${code.code}`;
      let sliceSnapshotEl = {
        id: `${snapshotEl.id}:${sliceName}`,
        path: snapshotEl.path,
        [MVH.nameOfEdSliceName(profile)]: sliceName,
        definition: snapshotEl.definition,
        min: 1,
        max: '1',
        base: snapshotEl.base,
        type: common.cloneJSON(snapshotEl.type),
      };
      let sliceDifferentialEl = common.cloneJSON(sliceSnapshotEl);

      // Add the slices to the profile
      let start = profile.snapshot.element.findIndex(e => e.id == snapshotEl.id) + 1;
      profile.snapshot.element.splice(start, 0, sliceSnapshotEl);
      start = profile.differential.element.findIndex(e => e.id == differentialEl.id) + 1;
      profile.differential.element.splice(start, 0, sliceDifferentialEl);

      // Fix the code on the slices
      [sliceSnapshotEl, sliceDifferentialEl] = this.findConstrainableElement(sourceValue, profile, sliceSnapshotEl, sliceDifferentialEl);
      this.fixCodeOnElement(sourceValue.identifier, profile, sliceSnapshotEl, sliceDifferentialEl, code);

      sliced = true;
    }

    if (sliced) {
      if (sourceValue.identifier.fqn !== 'concept') {
        // 13032, 'Cannot fix code on ${element1} because source value is not code-like. This should never happen and is probably a bug in the tool. ', 'Unknown', 'errorNumber'
        logger.error({ element1: snapshotEl.id }, '13032');
        return;
      }
      // Need to set the slicing up on the base element
      if (snapshotEl.type.some(t => t.code === 'code')) {
        common.addSlicingToBaseElement(profile, snapshotEl, differentialEl, 'value', '$this');
      } else if (snapshotEl.type.some(t => t.code === 'Coding')) {
        common.addSlicingToBaseElement(profile, snapshotEl, differentialEl, 'value', 'system');
        common.addSlicingToBaseElement(profile, snapshotEl, differentialEl, 'value', 'code');
      } else if (snapshotEl.type.some(t => t.code === 'CodeableConcept')) {
        common.addSlicingToBaseElement(profile, snapshotEl, differentialEl, 'value', 'coding');
      }
    }
  }

  fixCodeOnElement(identifier, profile, snapshotEl, differentialEl, code) {
    if (code.system == 'urn:tbd') {
      // Skip TBD code
      return;
    }

    if (snapshotEl.path.endsWith('[x]')) {
      [snapshotEl, differentialEl] = this.addExplicitChoiceElement(identifier, profile, snapshotEl, differentialEl);
    }

    const codeType = ['Quantity', 'CodeableConcept', 'Coding', 'code'].find(c => snapshotEl.type.some(t => t.code === c));

    // Different behavior based on code type
    switch (codeType) {
    case 'code':
      if (snapshotEl.fixedCode && snapshotEl.fixedCode !== code.code) {
        //13034 , 'Cannot override code constraint from ${value1} to ${value2} ' , 'Unknown' , 'errorNumber'
        logger.error({value1: snapshotEl.fixedCode, value2: code.code}, '13034');
      } else {
        snapshotEl.fixedCode = differentialEl.fixedCode = code.code;
        if (REPORT_PROFILE_INDICATORS) {
          this.addFixedValueIndicator(profile, snapshotEl.path, code.code);
        }
      }
      return; // we're done here!
    case 'Coding':
    case 'Quantity': {
      // First check if there's an existing fixed[x] or pattern[x] applied
      let fixedPropName;
      for (const propName of ['fixedCoding', 'patternCoding', 'fixedQuantity', 'patternQuantity']) {
        if (snapshotEl[propName]) {
          fixedPropName = propName;
          break;
        }
      }
      if (fixedPropName) {
        const fixedX = snapshotEl[fixedPropName];
        if ((fixedX.system && fixedX.system != code.system) || (fixedX.code && fixedX.code != code.code)) {
          //13048 , 'Cannot override code constraint from ${system1} | ${code1} to ${system2} | ${code2}'' , 'Unknown', 'errorNumber'
          logger.error({system1: fixedX.system, code1: fixedX.code, system2: code.system, code2: code.code }, '13048' );
        } else if (!fixedX.system || !fixedX.code) {
          // Use the fixed[x] or pattern[x] since it's already established, but add the missing property
          if (typeof code.system !== 'undefined' && code.system !== null) {
            fixedX.system = code.system;
          }
          fixedX.code = code.code;
          differentialEl[fixedPropName] = common.cloneJSON(fixedX);
          if (code.display) {
            snapshotEl.short = snapshotEl.definition = differentialEl.short = differentialEl.definition = common.trim(code.display);
          }
        }
        return;
      }

      // Now check for subpaths (system and code)
      const [systemEl, codeEl] = this.findSystemAndCodeElements(profile, snapshotEl, 'Quantity');
      if ((systemEl.fixedUri && systemEl.fixedUri != code.system) || (codeEl.fixedCode && codeEl.fixedCode != code.code)) {
        //13048 , 'Cannot override code constraint from ${system1} | ${code1} to ${system2} | ${code2}'' , 'Unknown', 'errorNumber'
        logger.error({system1: systemEl.fixedUri, code1: codeEl.fixedCode, system2:code.system, code2: code.code }, '13048');
        return;
      }
      if (typeof code.system !== 'undefined' && code.system !== null) {
        const systemDf = common.getDifferentialElementById(profile, systemEl.id, true);
        systemEl.fixedUri = systemDf.fixedUri = code.system;
      }
      const codeDf = common.getDifferentialElementById(profile, codeEl.id, true);
      codeEl.fixedCode = codeDf.fixedCode = code.code;

      if (code.display) {
        snapshotEl.short = snapshotEl.definition = differentialEl.short = differentialEl.definition = common.trim(code.display);
      }

      if (REPORT_PROFILE_INDICATORS) {
        this.addFixedValueIndicator(profile, snapshotEl.path, code);
      }
    } return;
    case 'CodeableConcept': {
      // First check if there's an existing fixedCodeableConcept or patternCodeableConcept applied
      let fixedPropName;
      for (const propName of ['fixedCodeableConcept', 'patternCodeableConcept']) {
        if (snapshotEl[propName]) {
          fixedPropName = propName;
          break;
        }
      }
      if (fixedPropName) {
        const fixedX = snapshotEl[fixedPropName];
        if (typeof fixedX.coding === 'undefined' || fixedX.coding.length === 0) {
          // I can't imagin this ever happening, but just in case
          fixedX.coding = [{}];
        }

        // We assume there won't ever be a fixed CodeableConcept w/ more than one coding in it (let's hope we're right)
        if ((fixedX.coding[0].system && fixedX.coding[0].system != code.system) || (fixedX.coding[0].code && fixedX.coding[0].code != code.code)) {
          //13048 , 'Cannot override code constraint from ${system1} | ${code1} to ${system2} | ${code2}'' , 'Unknown', 'errorNumber'
          logger.error({system1: fixedX.coding[0].system, code1: fixedX.coding[0].code, system2: code.system, code2: code.code }, '13048');
        } else if (!fixedX.coding[0].system || !fixedX.coding[0].code) {
          // Use the fixedCodeableConcept or patternCodeableConcept since it's already established, but add the missing property
          fixedX.coding[0].system = code.system;
          fixedX.coding[0].code = code.code;
          differentialEl[fixedPropName] = common.cloneJSON(fixedX);
          if (code.display) {
            snapshotEl.short = snapshotEl.definition = differentialEl.short = differentialEl.definition = common.trim(code.display);
          }
        }
        return;
      }

      // Now check if the base coding is fixed to the code.  This is not usually the right way to fix a code, but we've seen it done.
      // For example, the FHIR vital-signs profile fixes the category this way (so they're essentially saying "You can have as many
      // category.codings as you'd like, as long as every single one is the same vital-signs code!").  The correct way is to use a
      // slice, but we don't want to add a slice if the base coding already fixes it to what we need (right or not)!
      const codingBase = profile.snapshot.element.find(e => e.id.startsWith(snapshotEl.id) && e.path === `${snapshotEl.path}.coding` && MVH.edSliceName(profile, e) == null);
      if (codingBase) {
        const [baseSystemEl, baseCodeEl] = this.findSystemAndCodeElements(profile, codingBase, identifier, false);
        if (baseSystemEl.fixedUri && baseSystemEl.fixedUri == code.system && typeof baseCodeEl.fixedCode && baseCodeEl.fixedCode == code.code) {
          // Nothing to do here.  We're good!
          return;
        }
      }

      // Go through the existing slices to see if there are system/code pairs we can modify.
      // If a slice has no system or code fixed, we'll fix both.  If system is fixed and matches, but code is not fixed,
      // we'll fix just the code.  If the code is fixed and matches, but the system is not fixed, we'll fix just the
      // system.  If system and/or code are fixed but do not match, we'll issue an error.
      const codingSlices = profile.snapshot.element.filter(e => e.id.startsWith(snapshotEl.id) && e.path === `${snapshotEl.path}.coding` && MVH.edSliceName(profile, e));
      for (const slice of codingSlices) {
        const [systemEl, codeEl] = this.findSystemAndCodeElements(profile, slice, identifier, false);
        if (systemEl.fixedUri == null && codeEl.fixedCode == null) {
          // fix the code and system (if present)
          if (code.system) {
            const systemDf = common.getDifferentialElementById(profile, systemEl.id, true);
            systemEl.fixedUri = systemDf.fixedUri = code.system;
          }
          const codeDf = common.getDifferentialElementById(profile, codeEl.id, true);
          codeEl.fixedCode = codeDf.fixedCode = code.code;
          if (code.display) {
            const sliceDf = common.getDifferentialElementById(profile, slice.id, true);
            slice.short = slice.definition = sliceDf.short = sliceDf.definition = common.trim(code.display);
          }
          return;
        } else if (systemEl.fixedUri && systemEl.fixedUri == code.system && codeEl.fixedCode == null) {
          // system matches, fix only the code
          const codeDf = common.getDifferentialElementById(profile, codeEl.id, true);
          codeEl.fixedCode = codeDf.fixedCode = code.code;
          if (code.display) {
            const sliceDf = common.getDifferentialElementById(profile, slice.id, true);
            slice.short = slice.definition = sliceDf.short = sliceDf.definition = common.trim(code.display);
          }
          return;
        } else if (systemEl.fixedUri == null && code.system && codeEl.fixedCode && codeEl.fixedCode == code.code) {
          // code matches, fix only the system
          const systemDf = common.getDifferentialElementById(profile, systemEl.id, true);
          systemEl.fixedUri = systemDf.fixedUri = code.system;
          if (code.display) {
            const sliceDf = common.getDifferentialElementById(profile, slice.id, true);
            slice.short = slice.definition = sliceDf.short = sliceDf.definition = common.trim(code.display);
          }
          return;
        } else if ((systemEl.fixedUri && code.system && systemEl.fixedUri != code.system) || (codeEl.fixedCode && codeEl.fixedCode != code.code)) {
          // system or code does not match -- log an error and return without doing anything
          // 13048, 'Cannot override code constraint from ${system1} | ${code1} to ${system2} | ${code2} ', 'Unknown', 'errorNumber'
          logger.error({system1: systemEl.fixedUri, code1: codeEl.fixedCode, system2: code.system, code2: code.code}, '13048');
          return;
        } else if (systemEl.fixedUri && systemEl.fixedUri == code.system && typeof codeEl.fixedCode && codeEl.fixedCode == code.code) {
          // Nothing to do here.  We're good!
          return;
        }
      }

      // There were either no slices, or none of the slices were suitable for updating w/ the fixed code
      let baseCoding = profile.snapshot.element.find(e => e.id.startsWith(snapshotEl.id) && e.path === `${snapshotEl.path}.coding`);
      if (typeof baseCoding === 'undefined') {
        this.unrollElement('CodeableConcept', profile, snapshotEl);
        baseCoding = profile.snapshot.element.find(e => e.id.startsWith(snapshotEl.id) && e.path === `${snapshotEl.path}.coding`);
      }

      const baseCodingDf = common.getDifferentialElementById(profile, baseCoding.id, true);
      common.addSlicingToBaseElement(profile, baseCoding, baseCodingDf, 'value', 'code');
      const sliceName = `Fixed_${code.code}`;
      const sliceEl = {
        id: `${baseCoding.id}:${sliceName}`,
        path: baseCoding.path,
        [MVH.nameOfEdSliceName(profile)]: sliceName,
        short: code.display ? common.trim(code.display) : baseCoding.short,
        definition: code.display ? common.trim(code.display) : common.trim(baseCoding.definition),
        min: 1, // We're fixing the coding, so make it 1..1
        max: '1', // We're fixing the coding, so make it 1..1
        base: baseCoding.base,
        type: common.cloneJSON(baseCoding.type),
        isSummary: baseCoding.isSummary
      };
      // Insert the sliced element into the snapshot and differential
      const start = profile.snapshot.element.findIndex(e => e.id == baseCoding.id) + 1;
      profile.snapshot.element.splice(start, 0, sliceEl);
      profile.differential.element.push(common.cloneJSON(sliceEl));
      // Add the code constraint
      const [systemEl, codeEl] = this.findSystemAndCodeElements(profile, sliceEl, 'Coding');
      if (typeof code.system !== 'undefined' && code.system !== null) {
        const systemDf = common.getDifferentialElementById(profile, systemEl.id, true);
        systemEl.fixedUri = systemDf.fixedUri = code.system;
      }
      const codeDf = common.getDifferentialElementById(profile, codeEl.id, true);
      codeEl.fixedCode = codeDf.fixedCode = code.code;

    } return;
    }
  }

  findSystemAndCodeElements(profile, snapshotEl, identifier, createIfMissing=true) {
    let rootEl = snapshotEl;
    let systemEl, codeEl;
    if (snapshotEl.type[0].code === 'Extension') {
      const valueEl = profile.snapshot.element.find(e => e.id.startsWith(snapshotEl.id) && e.path.startsWith(`${snapshotEl.path}.value`));
      if (typeof valueEl !== 'undefined') {
        rootEl = valueEl;
        [systemEl, codeEl] = this.findSystemAndCodeElements(profile, rootEl, identifier, createIfMissing);
      }
    } else {
      rootEl = snapshotEl;
      systemEl = profile.snapshot.element.find(e => e.id.startsWith(snapshotEl.id) && e.path === `${snapshotEl.path}.system`);
      codeEl = profile.snapshot.element.find(e => e.id.startsWith(snapshotEl.id) && e.path === `${snapshotEl.path}.code`);
    }

    if (createIfMissing && (typeof systemEl === 'undefined' || typeof codeEl === 'undefined')) {
      this.unrollElement(identifier, profile, rootEl);
      return this.findSystemAndCodeElements(profile, rootEl, identifier);
    }

    return [systemEl, codeEl];
  }

  applyOwnBooleanConstraints(sourceValue, profile, snapshotEl, differentialEl) {
    const boolConstraints = sourceValue.constraintsFilter.own.boolean.constraints;
    if (boolConstraints.length > 0) {
      [snapshotEl, differentialEl] = this.findConstrainableElement(sourceValue, profile, snapshotEl, differentialEl);
      const boolValue = boolConstraints[0].value;
      this.fixValueOnElement(profile, snapshotEl, differentialEl, boolValue, 'boolean');
      if (boolConstraints.length > 1) {
        //13036 , 'Found more than one boolean to fix on ${element1}. This should never happen and is probably a bug in the tool.' , 'Unknown', 'errorNumber'
        logger.error({ element1: snapshotEl.id }, '13036' );
      }
    }
  }

  applyOwnFixedValueConstraints(sourceValue, profile, snapshotEl, differentialEl) {
    const fixedConstraints = sourceValue.constraintsFilter.own.fixedValue.constraints;
    if (fixedConstraints.length > 0) {
      [snapshotEl, differentialEl] = this.findConstrainableElement(sourceValue, profile, snapshotEl, differentialEl);
      const value = fixedConstraints[0].value;
      const type = fixedConstraints[0].type;
      this.fixValueOnElement(profile, snapshotEl, differentialEl, value, type);
      if (fixedConstraints.length > 1) {
        //13036 , 'Found more than one boolean to fix on ${element1}. This should never happen and is probably a bug in the tool.' , 'Unknown', 'errorNumber'
        logger.error({ element1: snapshotEl.id }, '13036' );
      }
    }
  }

  fixValueOnElement(profile, snapshotEl, differentialEl, value, typeCode) {
    if (! snapshotEl.type.some(t => t.code === typeCode)) {
      // This can't be fixed to the value, as it's not the right type
      //13058 , 'Cannot fix ${target1} to ${value1} since it is not a ${type1} type.' , 'Unknown' , 'errorNumber'
      logger.error({target1 : snapshotEl.path, value1 : value, type1 : typeCode }, '13058' );
      return;
    }
    // Codes require special handling, so outsource to the code-specific function if needed
    if (['code', 'Coding', 'CodeableConcept'].indexOf(typeCode) !== -1) {
      this.fixCodeOnElement(typeCode, profile, snapshotEl, differentialEl, value);
      return;
    }
    const property = `fixed${common.capitalize(typeCode)}`;
    if (typeof snapshotEl[property] !== 'undefined') {
      if (snapshotEl[property] === value) {
        // It's already fixed to this value, so there's nothing to do.
        return;
      }
      // Found another non-matching fixed value.  Put on the brakes.
      //13059 , 'Cannot fix ${target1} to ${value1} since it is already fixed to ${otherValue1}' , 'Unknown', 'errorNumber'
      logger.error({target1: snapshotEl.path, value1: value, otherValue1 : snapshotEl[property] }, '13059');
      return;
    }
    snapshotEl[property] = differentialEl[property] = value;
    // If max cardinality is 1, then remove all other types from the choice
    if (snapshotEl.max === '1' && snapshotEl.type.length > 1) {
      snapshotEl.type = differentialEl.type = snapshotEl.type.filter(t => t.code === typeCode);
    }
    if (REPORT_PROFILE_INDICATORS) {
      this.addFixedValueIndicator(profile, snapshotEl.path, value);
    }
  }

  // This function applies applicable constraints when there is a non-trival conversion -- and warns if constraints will be dropped.
  applyConstraintsForConversion(sourceValue, profile, snapshotEl, differentialEl, sourcePath) {
    const sourceIdentifier = common.choiceFriendlyEffectiveIdentifier(sourceValue);
    const targetTypes = snapshotEl.type;

    if (sourceValue.constraintsFilter.own.boolean.hasConstraints) {
      // There's no conversion that can support boolean constraints
      //13037 , 'Conversion from ${value1} to one of ${type1} drops boolean constraints' , 'Unknown', 'errorNumber'
      logger.error({value1 : sourceIdentifier.fqn, type1 : targetTypes }, '13037');
    } else {
      const targetAllowsCodeConstraints = targetTypes.some(t => t.code == 'code' || t.code == 'Coding' || t.code == 'CodeableConcept' || t.code == 'string');
      if (targetAllowsCodeConstraints) {
        let [snapshotElForCodishConstraints, differentialElForCodishConstraints, sourcePathForCodishConstraints, addedType] = [snapshotEl, differentialEl, sourcePath, false];
        if (this.isUnitConceptPathOnQuantityBasedProfile(profile, sourcePath)) {
          // TODO: might need to add the type
          snapshotElForCodishConstraints = profile.snapshot.element[0];
          if (snapshotElForCodishConstraints.type == null) {
            snapshotElForCodishConstraints.type = [{code: 'Quantity'}];
            addedType = true;
          }
          differentialElForCodishConstraints = common.getDifferentialElementById(profile, snapshotElForCodishConstraints.id, true);
          sourcePathForCodishConstraints = [];
        }
        this.applyOwnValueSetConstraints(sourceValue, profile, snapshotElForCodishConstraints, differentialElForCodishConstraints, sourcePathForCodishConstraints);
        this.applyOwnCodeConstraints(sourceValue, profile, snapshotElForCodishConstraints, differentialElForCodishConstraints);
        if (addedType) {
          delete snapshotElForCodishConstraints.type;
          delete differentialElForCodishConstraints.type;
        }
        this.applyOwnIncludesCodeConstraints(sourceValue, profile, snapshotEl, differentialEl);
        return;
      }
      if (sourceValue.constraintsFilter.own.valueSet.hasConstraints) {
        //13038 , 'Conversion from ${value1} to one of ${type1} drops value set constraints' , 'Unknown', 'errorNumber'
        logger.error({value1 : sourceIdentifier.fqn, type1: targetTypes }, '13038');
      }
      if (sourceValue.constraintsFilter.own.code.hasConstraints) {
        //13039 , 'Conversion from ${value1} to one of ${type1} drops code constraints' , 'Unknown' , 'errorNumber'
        logger.error({value1 : sourceIdentifier.fqn, type1: targetTypes }, '13039' );
      }
      if (sourceValue.constraintsFilter.own.includesCode.hasConstraints) {
        //13040 , 'Conversion from ${value1} to one of ${type1} drops includesCode constraints' , 'Unknown', 'errorNumber'
        logger.error({value1 : sourceIdentifier.fqn, type1: targetTypes }, '13040');
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
        if (!map.rules.some(r => r.sourcePath && r.sourcePath.length > 0 && r.sourcePath[0].equals(field.effectiveIdentifier))) {
          const lastLogger = logger;
          logger = logger.child({ extension: field.effectiveIdentifier.fqn });
          // 03015, 'Start mapping extension',,
          logger.debug('03015');
          try {
            // By convention (for now) modifiers have the word "Modifier" in their name
            const isModifier = (/modifier/i).test(field.effectiveIdentifier.name);
            const extPath = isModifier ? 'modifierExtension' : 'extension';
            const rule = new mdls.FieldMappingRule([field.effectiveIdentifier], extPath);
            this.addExtension(map, profile, rule);
            if (TRACK_UNMAPPED_PATHS) {
              this.removeMappedPath(def, rule.sourcePath);
            }
          } catch (e) {
            //13051 , 'Unexpected error adding extension. ${errorText}' , 'Unknown' , 'errorNumber'
            logger.error({errorText: e.stack }, '13051');
          } finally {
            // 03016, 'Done mapping extension',,
            logger.debug('03016');
            logger = lastLogger;
          }
        }
        // TODO: Should also dive into elements that are mapped and check if their sub-fields are mapped (recursively)
      } else {
        // TODO: Support choices
      }
    }
  }

  addExtension(map, profile, rule) {
    const def = this._specs.dataElements.findByIdentifier(map.identifier);
    const sourceValue = this.findValueByPath(rule.sourcePath, def);
    const aggSourceCard = this.getAggregateEffectiveCardinality(def.identifier, rule.sourcePath);

    const identifier = common.choiceFriendlyEffectiveIdentifier(sourceValue);

    if (identifier && identifier._namespace === 'unknown') {
      //13041 , 'Unable to establish namespace for ${elementName1}' , 'Double check imports and element name spelling.', 'errorNumber'
      logger.error({elementName1: identifier.fqn }, '13041');
      return;
    }

    const ft = FieldTarget.parse(rule.target);
    let extURL, extPath;
    if (ft.isExtensionURL()) {
      if (rule.sourcePath.length > 1) {
        // 03017, 'Deep path mapped to extension URL, but extension placed at root level.',,
        logger.info('03017');
      }
      extURL = ft.target;
      extPath = 'extension';
    } else {
      extURL = this._extensionExporter.lookupExtension(identifier).url;
      extPath = ft.target;
    }

    const isModifier = /modifierExtension$/.test(extPath);
    const baseExtEl = this.getSnapshotElementForFieldTarget(profile, new FieldTarget(extPath), sourceValue);

    // First, look to see if the extension is already there (in the case of profiling a profile)
    let ssEl = profile.snapshot.element.find(e => {
      return e.path === `${MVH.sdType(profile)}.${extPath}` && e.type.length === 1 && MVH.typeHasProfile(e.type[0], extURL);
    });

    let dfEl; // To be assigned later
    if (typeof ssEl === 'undefined') {
      // Don't add a new extension if the card is 0..0, because that doesn't add value.  It only confuses.
      if (aggSourceCard.max == 0) {
        return;
      }

      // We'll be adding an extension, so ensure we have the base slicing defined
      if (!common.hasSlicingOnBaseElement(profile, baseExtEl, 'value', 'url')) {
        const baseExtDiffEl = common.getDifferentialElementById(profile, baseExtEl.id, true);
        common.addSlicingToBaseElement(profile, baseExtEl, baseExtDiffEl, 'value', 'url');
      }

      // Find the base extension element from which this extension will be derived
      ssEl = common.cloneJSON(baseExtEl);
      ssEl.id = `${ssEl.id}:${common.shortID(identifier)}`;
      MVH.setEdSliceName(profile, ssEl, common.shortID(identifier));
      ssEl.definition = this.getDescription(identifier, identifier.name);
      // NOTE: Set initial cardinality in simple way, but will be re-processed later
      ssEl.min = aggSourceCard.min;
      ssEl.max = typeof aggSourceCard.max === 'undefined' ? '*' : aggSourceCard.max.toString();
      ssEl.type = [MVH.convertType(profile, { code : 'Extension', profile : [extURL] })];
      // TODO: Do we need to add the condition and constraints here?
      if (isModifier) {
        ssEl.mustSupport = ssEl.isModifier = true;
        if (this._target === 'FHIR_R4') {
          ssEl.isModifierReason = this.getDescription(identifier, `${identifier.name} modifies the meaning`);
        }
      }
      delete(ssEl.short);
      MVH.deleteEdComment(profile, ssEl);
      delete(ssEl.alias);
      delete(ssEl.mapping);
      delete(ssEl.slicing);
      insertElementInSnapshot(ssEl, profile);

      dfEl = common.cloneJSON(ssEl);
      insertElementInDifferential(dfEl, profile);
    } else {
      // There is an existing snapshot element for this extension, so we'll modify that.
      // Grab the matching differential element before we change the snapshot id
      dfEl = common.getDifferentialElementById(profile, ssEl.id);
      const dfIsNew = typeof dfEl === 'undefined';
      if (dfIsNew) {
        dfEl = {};
      }
      // Modify the things that should be modified
      dfEl.id = ssEl.id = ssEl.id.replace(/:[^.]+$/, ':' + common.shortID(identifier));
      dfEl.path = ssEl.path;
      // If it already has a slicename, there's no reason to change it
      if (typeof MVH.edSliceName(profile, ssEl) === 'undefined') {
        MVH.setEdSliceName(profile, ssEl, common.shortID(identifier));
        MVH.setEdSliceName(profile, dfEl, common.shortID(identifier));
      }
      // If it already has a definition, just keep it as is since we shouldn't be changing semantic meaning
      if (typeof ssEl.definition === 'undefined') {
        dfEl.definition = ssEl.definition = this.getDescription(identifier, identifier.name);
      }
      // NOTE: Cardinalities will be handled later
      if (isModifier && (typeof ssEl.mustSupport === 'undefined' || !ssEl.mustSupport)) {
        dfEl.mustSupport = ssEl.mustSupport = true;
      }
      if (isModifier && (typeof ssEl.isModifier === 'undefined' || !ssEl.isModifier)) {
        dfEl.isModifier = ssEl.isModifier = true;
        if (this._target === 'FHIR_R4') {
          ssEl.isModifierReason = this.getDescription(identifier, `${identifier.name} modifies the meaning`);
        }
      }
      delete(ssEl.short);
      delete(dfEl.short);
      // Some IGs (e.g., US Core) repeat the slicing element in the extension.  I don't think this is right.
      if (ssEl.slicing && baseExtEl.slicing && ssEl.slicing.id === baseExtEl.slicing.id) {
        delete(ssEl.slicing);
        delete(dfEl.short);
      }

      if (dfIsNew) {
        insertElementInDifferential(dfEl, profile);
      }
    }

    // Set the cardinalities, using aggregates to ensure proper cardinality mapping
    this.processFieldToFieldCardinality(map, rule, profile, ssEl, dfEl);

    // If there isn't already a base, add it.  It's always defined in the base resource and has 0..* cardinality.
    if (!ssEl.base) {
      ssEl.base = dfEl.base = {
        path: `${MVH.sdType(profile)}.${extPath}`,
        min: 0,
        max: '*'
      };
    }

    const shrMap = rule.sourcePath.map((pathElem) => {
      return `<${pathElem.fqn}>`;
    }).join('.');
    pushShrMapToElementMappings(shrMap, ssEl, dfEl);

    this.applyConstraints(sourceValue, profile, ssEl, dfEl, true, rule.sourcePath);

    return;
  }

  /**
   * Processes the ContentProfile rules.  Currently this is only used to flag elements
   * as MustSupport and NoProfile.
   *
   * @param {Object} map - the SHR ElementMapping to process content profiles for
   * @param {Object} profile - the generated FHIR profile
   */
  processContentProfileRules(map, profile) {
    // Handle no profile flag
    if (common.hasContentProfileNoProfile(map, this._specs.contentProfiles)) {
      profile._shr = false;
      this._profilesMap.set(profile.id, profile);
    }

    // Look up the ContentProfile
    const cp = this._specs.contentProfiles.findByIdentifier(map.identifier);
    if (cp == null) {
      return;
    }
    // Iterate the rules one at a time
    for (const cpr of cp.rules) {

      if (cpr.primaryProfile || cpr.noProfiles) {
        continue;
      }

      // Each rule has a path of SHR element identifiers.  Use these to try to find the corresponding
      // FHIR element in the profile.  To do this, we'll re-use the SHR mappings that are stored for
      // the ES6 exporter (since they map SHR paths to FHIR elements). This may not get us all the way,
      // but try to find the most complete partial map available.
      const cprMappingPath = cpr.path.map(p => `<${p.fqn}>`).join('.');
      // Use array reduce to keep track of the longest matching path while iterating elements
      const closestMatch = profile.snapshot.element.reduce((closest, current) => {
        if (current.mapping != null) {
          current.mapping.forEach(m => {
            if (m.identity === 'shr' && cprMappingPath.startsWith(m.map)) {
              if (closest == null || closest.path.length < m.map.length) {
                // Store it as a simple object with a path and array of elements
                // (It is possible to have one path map to multiple elements)
                closest = { path: m.map, elements: [current] };
              } else if (closest.path.length === m.map.length) {
                closest.elements.push(current);
              }
            }
          });
        }
        return closest;
      }, null);

      if (closestMatch) {
        const matchedElements = [];
        if (closestMatch.path === cprMappingPath) {
          // Exact match!
          matchedElements.push(...closestMatch.elements);
        } else {
          // Partial match: dive further into the element to get the full match.
          // First convert the matched string-style path back to an array of identifiers
          const matchedPath = closestMatch.path.slice(1, -1).split('>.<').map(fqn => {
            const parts = fqn.split('.');
            const [name, namespace] = [parts.pop(), parts.join('.')];
            return new mdls.Identifier(namespace, name);
          });
          // Now get the expected FHIR subpath for the remaining identifier path
          const rootIdentifier = matchedPath[matchedPath.length - 1];
          const remainingPath = cpr.path.slice(matchedPath.length);
          const targetSubPath = this.findTargetFHIRPath(rootIdentifier, remainingPath);
          if (targetSubPath) {
            // The subpath was determined, so now get the "Value" for the tail of the path,
            // which is needed when getting the corresponding snapshot element
            const def = this._specs.dataElements.findByIdentifier(rootIdentifier);
            const tailValue = this.findValueByPath(remainingPath, def, false, []);
            // Get the deeper snapshot elements for each of the matched elements
            closestMatch.elements.forEach(el => {
              const targetPath = `${el.path}.${targetSubPath}`;
              // Convert to a field target so we can use an existing function
              const fieldTarget = new FieldTarget(targetPath.slice(targetPath.indexOf('.') + 1)); // Remove resource prefix
              const targetSS = this.getSnapshotElementForFieldTarget(profile, fieldTarget, tailValue);
              if (targetSS) {
                matchedElements.push(targetSS);
              } else {
                //13063, 'Could not find FHIR element with ${path1} %s for content profile rule with ${path2}',  'Unknown' , 'errorNumber'
                logger.error({ path1: targetPath, path2: cpr.path.map(p => p.name).join('.') }, '13063');
              }
            });
          } else {
            // Identifying the FHIR subpath failed.  This may happen when the rest of the path is "Value" or "_Value".
            const remainingPath = cpr.path.slice(matchedPath.length);
            if (remainingPath.length === 1 && remainingPath[0].isValueKeyWord) {
              // Determine if value was actually used when the mapping was applied.  If so, then the SHR data element's value
              // should be compatible with the FHIR element's value.
              const rootIdentifier = matchedPath[matchedPath.length - 1];
              const def = this._specs.dataElements.findByIdentifier(rootIdentifier);
              const value = def.value;
              if (value) {
                // Define a function that check's if a FHIR type is compatibile with an SHR value type
                const isMatchForType = (val, types) => {
                  if (types.length == 1 && types[0].code == 'Extension') {
                    // If the FHIR type is an extension, see if it matches the value's extension representation
                    const ext = this._extensionExporter.lookupExtension(val.effectiveIdentifier, false, false);
                    if (ext) {
                      return MVH.typeHasProfile(types[0], ext.url);
                    }
                  } else if (val.effectiveIdentifier.isPrimitive) {
                    // If the value is a primitive, then just look for an exact match by name
                    return types.some(t => t.code === val.effectiveIdentifier.name);
                  } else {
                    // Otherwise, find the base type of the value's profile and see if it is valid in the FHIR type
                    const prf = this.lookupProfile(val.effectiveIdentifier, false, false);
                    if (prf) {
                      return types.some(t => t.code === MVH.sdType(prf));
                    }
                  }
                  return false;
                };

                // Now check if the value is a match (w/ slightly different logic for choices and non-choices)
                if (value instanceof mdls.ChoiceValue) {
                  closestMatch.elements.forEach(el => {
                    if (value.aggregateOptions.some(opt => isMatchForType(opt, el.type))) {
                      matchedElements.push(el);
                    } else {
                      //13064, 'Could not find FHIR element for content profile rule with path ${path}' ,  'Unknown' , 'errorNumber'
                      logger.error({ path: cpr.path.map(p => p.name).join('.') }, '13064');
                    }
                  });
                } else {
                  closestMatch.elements.forEach(el => {
                    if (isMatchForType(value.effectiveIdentifier, el.type)) {
                      matchedElements.push(el);
                    } else {
                      //13064, 'Could not find FHIR element for content profile rule with path ${path}' ,  'Unknown' , 'errorNumber'
                      logger.error({ path: cpr.path.map(p => p.name).join('.') }, '13064');
                    }
                  });
                }
              } else {
                //13064, 'Could not find FHIR element for content profile rule with path ${path}' ,  'Unknown' , 'errorNumber'
                logger.error({ path: cpr.path.map(p => p.name).join('.') }, '13064');
              }
            } else {
              //13064, 'Could not find FHIR element for content profile rule with path ${path}' ,  'Unknown' , 'errorNumber'
              logger.error({ path: cpr.path.map(p => p.name).join('.') }, '13064');
            }
          }
        }

        // Apply Must Support to the elements
        matchedElements.forEach(el => {
          if (cpr.mustSupport && el.mustSupport !== true) {
            const dfEl = common.getDifferentialElementById(profile, el.id, true);
            el.mustSupport = dfEl.mustSupport = true;
          }
        });
      } else {
        //13064, 'Could not find FHIR element for content profile rule with path ${path}' ,  'Unknown' , 'errorNumber'
        logger.error({ path: cpr.path.map(p => p.name).join('.') }, '13064');
      }
    }
  }

  lookupProfile(identifier, createIfNeeded=true, warnIfProfileIsProcessing=false, warnIfUsingMappingNoProfile=false) {
    const mapping = this._specs.maps.findByTargetAndIdentifier(this._target, identifier);
    // Maintain support for 'no profile' in mapping file
    if (mapping != null) {
      const targetItem = common.TargetItem.parse(mapping.targetItem);
      if (targetItem.hasNoProfileCommand()) {
        // For now allow setting no profile in mapping file, but warn that it should be stopped
        if (warnIfUsingMappingNoProfile) {
          // 03025, 'Setting 'no profile' for ${target} in mapping file is deprecated and should done in content profile instead', 'Unknown', 'errorNumber'
          logger.warn({target: targetItem.target}, '03025');
        }
        return this.lookupStructureDefinition(targetItem.target);
      }
    }
    // Check for 'no profile' in content profile file
    if (common.hasContentProfileNoProfile(mapping, this._specs.contentProfiles)) {
      const targetItem = common.TargetItem.parse(mapping.targetItem);
      return this.lookupStructureDefinition(targetItem.target);
    }

    let p = this._profilesMap.get(common.fhirID(identifier));
    if (typeof p === 'undefined' && createIfNeeded) {
      if (typeof mapping !== 'undefined') {
        // Warning -- there CAN be a circular dependency here -- so watch out!  I warned you...
        p = this.mappingToProfile(mapping);
      } else {
        // This must be an Element that has no mapping provided, so... map to Basic
        const basicMapping = new mdls.ElementMapping(identifier, this._target, 'Basic');
        this._specs.maps.add(basicMapping);
        p = this.mappingToProfile(basicMapping);
      }
    } else if (warnIfProfileIsProcessing && this._processTracker.isActive(identifier)) {
      // 13054, 'Using profile that is currently in the middle of processing: ${profileId}.', 'Unknown', 'errorNumber'
      logger.debug({ profileId: common.fhirID(identifier) }, '13054');
    }
    // If this is really a no-diff profile, then return the base structuredef instead!
    if (typeof p !== 'undefined' && !common.isCustomProfile(p)) {
      return this.lookupStructureDefinition(MVH.sdBaseDefinition(p));
    }
    return p;
  }

  lookupStructureDefinition(id, warnIfStructureDefinitionIsProcessing=false) {
    // First check profiles
    const profile = this._profilesMap.get(id);
    if (typeof profile !== 'undefined') {
      if (warnIfStructureDefinitionIsProcessing && this._processTracker.isActive(id)) {
        // 13054, 'Using profile that is currently in the middle of processing: ${profileId}.', 'Unknown', 'errorNumber'
        logger.debug({ profileId: common.fhirID(id) }, '13054');
      }
      // If this is really a no-diff profile, then return the base structuredef instead!
      if (!common.isCustomProfile(profile)) {
        return this.lookupStructureDefinition(MVH.sdBaseDefinition(profile));
      }
      return profile;
    }
    const ext = this._extensionExporter.extensions.find(e => e.id == id);
    if (typeof ext !== 'undefined') {
      if (warnIfStructureDefinitionIsProcessing && this._extensionExporter.processTracker.isActive(id)) {
        // 13055, 'Using extension that is currently in the middle of processing: ${extensionId}.', 'Unknown', 'errorNumber'
        logger.warn({ extensionId: common.fhirID(id) }, '13055');
      }
      return ext;
    }
    return this._fhir.find(id);
  }

  getSnapshotElementForFieldTarget(profile, fieldTarget, sourceValue, sliceCard) {
    const parentEl = profile.snapshot.element[0];
    return this.getSnapshotElementFromParentToFieldTarget(profile, parentEl, fieldTarget, sourceValue, sliceCard);
  }

  getSnapshotElementFromParentToFieldTarget(profile, parentEl, fieldTarget, sourceValue, sliceCard) {
    // Get the slice-aware path (by combining in-slice value with the target)
    const targetPathArray = fieldTarget.target.split('.');
    if (fieldTarget.hasInSliceCommand()) {
      const slicePathArray = fieldTarget.findInSliceCommand().value.split('.');
      for (let i=0; i < slicePathArray.length; i++) {
        if (targetPathArray[i] != slicePathArray[i].split(':')[0]) {
          //13072, 'Target path ${targetPath1} and slice path ${slicePath1} are not compatible. ' , 'Unknown' , 'errorNumber'
          logger.error({targetPath1: fieldTarget.target, slicePath1: fieldTarget.findInSliceCommand().value }, '13072');
          return;
        }
        targetPathArray[i] = slicePathArray[i];
      }
    }

    // Try to find the path one segment as a time, unrolling child elements and creating slices as necessary
    let elements = profile.snapshot.element.filter(e => e.id === parentEl.id || e.id.startsWith(`${parentEl.id}.`));
    let cumulativePath = parentEl.path;

    // Path parts can have multiple components -- the root part, an optional id or choice specifier, and a slice name
    // e.g., foo, foo[bar], foo[x], foo:baz, foo[bar]:baz, or foo[x].baz
    // This regex separates out those components so we can process based on them
    const pathPartRegex = /^([^[:]+)(\[([^\]]+)\])?(:(.*))?$/;
    const extRegEx = /^(modifierE|e)xtension$/;
    // Now iterate the path one part at a time
    for (let i=0; i < targetPathArray.length; i++) {
      // Match on the part
      const match = targetPathArray[i].match(pathPartRegex);
      const isExt = extRegEx.test(match[1]); // test if match[1] (the root) is extension or modifierExtension
      const pathPart = isExt ? match[1] : `${match[1]}${match[2] || ''}`; // In the case of value[x], match[2] is [x]
      const extName = isExt ? match[3] : null; // match[3] is the bit inside the bracks (the extension id)
      const sliceName = match[5]; // match[5] is the slicename (after the ':')
      cumulativePath += `.${pathPart}`;
      let root = elements.find(e => {
        if (isExt && extName != null) {
          // Lookup the extension by its ID, supporting cases where the profile is an id or URL w/ id at end
          const extType = e.type ? e.type.find(t => t.code === 'Extension') : null;
          const extProfiles = MVH.typeProfile(extType);
          return e.path === cumulativePath
            && extProfiles
            && (extProfiles.includes(extName) || extProfiles.some( ep => ep.endsWith(`/${extName}`)))
            && (sliceName == null || MVH.edSliceName(profile, e) === sliceName);
        } else {
          // No extension name specified, so just search by path and slicename (if applicable)
          return e.path === cumulativePath && MVH.edSliceName(profile, e) === sliceName;
        }
      });
      if (root != null) {
        // Re-set the parent and narrow elements to only those under this path/slice (including the root)
        parentEl = root;
        elements = elements.filter(e => e.id === root.id || e.id.startsWith(`${root.id}.`));
        continue;
      }

      // The path doesn't exist.  We may need to "create" it.

      // If this is a path pointing to a slice, then we may need to create the slice from the base (if the base exists)
      if (sliceName != null) {
        const isDeepestSlice = targetPathArray.every((tp, j) => (j <= i) || tp.indexOf(':') === -1);
        if (!isDeepestSlice) {
          // We couldn't find the slice, BUT the missing slice is a parent slice to the slice the slice this target
          // is actually associated to (e.g., nested slices and we can't find one of the higher containing slices).
          // We don't have enough info to create the parent slice, so this is a problem. Technically, this parent slice
          // should have already been created by the time we got here, so it's probably a bug in tooling.
          //13073, 'Could not resolve sliced path: ${slicedPath1} (likely a tooling issue).',  'Unknown' , 'errorNumber'
          logger.error({slicedPath1 : targetPathArray.slice(0, i+1).join('.') }, '13073' );
          return;
        }
        const base = elements.find(e => MVH.edSliceName(profile, e) == null && e.path === cumulativePath);
        if (base != null) {
          root = this.createSliceFromBase(profile, base, sliceName, fieldTarget, sourceValue, sliceCard);
          // Re-set the parent and narrow elements to only those under this path/slice (including the root)
          parentEl = root;
          // Since we added new elements (when we sliced), we need to filter on the whole profile again
          elements = profile.snapshot.element.filter(e => e.id === root.id || e.id.startsWith(`${root.id}.`));
          continue;
        }
      }

      // If we still haven't found it, but the parent is a choice, and the path is an option, make the choice explicit
      if (parentEl.path.endsWith('[x]') && parentEl.type.some(t => t.code === pathPart)) {
        // The target path references a type in a choice (e.g., value[x].Quantity), so we need to make an explicit
        // choice element for that type, and then update the path to reference it
        const parentDfEl = common.getDifferentialElementById(profile, parentEl.id, true);
        [root] = this.addExplicitChoiceElement(pathPart, profile, parentEl, parentDfEl);
        // If this had a slice name, we know we need to create the slice too
        if (sliceName != null) {
          root = this.createSliceFromBase(profile, root, sliceName, fieldTarget, sourceValue, sliceCard);
        }
        // Re-set the parent and narrow elements to only those under this path/slice (including the root)
        parentEl = root;
        // Since we added/replaced new elements, we'll need to filter on the whole profile again
        elements = profile.snapshot.element.filter(e => e.id === root.id || e.id.startsWith(`${root.id}.`));
        continue;
      }

      if (Array.isArray(parentEl.type)) {
        if (parentEl.type.length != 1 || parentEl.type[0].code == null || parentEl.type[0].code == 'Reference') {
          // The parent isn't a drillable element
          return;
        }
        // At this point, it looks like we may need to "unroll" the parent to get to this part of the path
        // If there is a profile, that's what we want to unroll, otherwise the type
        const type = common.getUnrollableType(parentEl.type[0]);
        const sd = this.lookupStructureDefinition(type, true);
        // Before we unroll it, check to be sure the sub-element exists (otherwise we needlessly unroll it)
        const sdType = MVH.sdType(sd);
        if (sd.snapshot.element.some(e => e.path == `${sdType}.${pathPart}`)) {
          this.unrollElement(type, profile, parentEl);
          // Now that we unrolled, we want to run this cycle of the loop again with the new elements
          // Since we added/replaced new elements, we'll need to filter on the whole profile again
          elements = profile.snapshot.element.filter(e => e.id === parentEl.id || e.id.startsWith(`${parentEl.id}.`));
          // Trim back the cumulative path and decrement i so we run this cycle of the loop through again
          cumulativePath = cumulativePath.substring(0, cumulativePath.lastIndexOf('.'));
          i--;
        } else {
          // The sub-element doesn't exist in the type
          return;
        }
      } else if (MVH.edContentReference(profile, parentEl) != null) {
        // Unroll the content reference to get to the path
        const crPath = this.findContentReferencePath(profile, parentEl);
        if (crPath == null) {
          // Invalid content reference
          return;
        }
        // Before we unroll it, check to be sure the sub-element exists (otherwise we needlessly unroll it)
        if (profile.snapshot.element.some(e => e.path == `${crPath}.${pathPart}`)) {
          this.unrollContentReference(profile, parentEl);
          // Now that we unrolled, we want to run this cycle of the loop again with the new elements
          // Since we added/replaced new elements, we'll need to filter on the whole profile again
          elements = profile.snapshot.element.filter(e => e.id === parentEl.id || e.id.startsWith(`${parentEl.id}.`));
          // Trim back the cumulative path and decrement i so we run this cycle of the loop through again
          cumulativePath = cumulativePath.substring(0, cumulativePath.lastIndexOf('.'));
          i--;
        } else {
          // The sub-element doesn't exist in the content reference
          return;
        }
      } else {
        // Not a drillable element so return undefined
        return;
      }
    }

    // The root (which is what we want) is the first in the array
    return elements[0];
  }

  createSliceFromBase(profile, baseElement, sliceName, fieldTarget, sourceValue, sliceCard) {
    if (fieldTarget.hasSliceOnCommand()) {
      // If the mapping has a slice at command, then that's where we need to set the base element to apply slicing info
      if (fieldTarget.hasSliceAtCommand()) {
        const sliceAtPath = `${MVH.sdType(profile)}.${fieldTarget.findSliceAtCommand().value}`;
        let sliceAtElement;
        for (const idParts = baseElement.id.split('.'); idParts.length > 0; idParts.pop()) {
          const element = profile.snapshot.element.find(e => e.id === idParts.join('.'));
          if (element && element.path === sliceAtPath) {
            sliceAtElement = element;
            break;
          }
        }
        if (sliceAtElement == null) {
          //13074, 'Could not find element to slice at ${slicePath1}'  'Unknown' , 'errorNumber'
          logger.error({slicePath1 : sliceAtPath }, '13074' );
          return;
        }
        baseElement = sliceAtElement;
      }


      // Apply the discriminator to the base element in the snapshot and the differential
      const discType = fieldTarget.hasSliceOnTypeCommand() ? fieldTarget.findSliceOnTypeCommand().value : 'value';
      common.addSlicingToBaseElement(profile, baseElement, null, discType, fieldTarget.findSliceOnCommand().value);
      let df = common.getDifferentialElementById(profile, baseElement.id);
      if (typeof df === 'undefined') {
        df = { id: baseElement.id, path: baseElement.path };
        profile.differential.element.push(df);
      }
      df.slicing = baseElement.slicing;

      // Now add the snapshot and differential sections for the slice!
      const ssSection = profile.snapshot.element.filter(e => {
        return e.id == baseElement.id || e.id.startsWith(`${baseElement.id}.`);
      });
      const sliceMapper = (e) => {
        const element = common.cloneJSON(e);
        element.id = element.id.replace(baseElement.id, `${baseElement.id}:${sliceName}`);
        // If we're copying over any "selected" types, we want to remember they are selected, but
        // note that they're lower priority in case the slice applies it's own type.  E.g., if the slice
        // applies its own type, just keep that one.  Otherwise keep all of the previously selected ones.
        if (element.type) {
          element.type.forEach(t => {
            if (t._shrTypePriority) {
              t._shrTypePriority++;
            }
          });
        }
        return element;
      };
      const ssSliceSection = ssSection.map(sliceMapper);

      // If there were existing differentials, we want to copy them over too
      const dfSliceSection = ssSection.filter(e => common.getDifferentialElementById(profile, e.id, false))
        .map(e => common.getDifferentialElementById(profile, e.id, false))
        .map(sliceMapper);
      // If there weren't existing differentials, at least add the base slice differential
      if (dfSliceSection.length === 0 || dfSliceSection[0].id != ssSliceSection[0].id) {
        dfSliceSection.splice(0, 0, { id: ssSliceSection[0].id, path: ssSliceSection[0].path, sliceName: sliceName });
      }

      // Set the slice name
      MVH.setEdSliceName(profile, ssSliceSection[0], sliceName);
      MVH.setEdSliceName(profile, dfSliceSection[0], sliceName);

      // Set the base
      if (!ssSliceSection[0].base) {
        ssSliceSection[0].base = dfSliceSection[0].base = {
          path: baseElement.path,
          min: baseElement.min,
          max: baseElement.max
        };
      }

      // The base slice section element has slicing (from the copy), but we don't need to repeat that
      delete(ssSliceSection[0].slicing);
      delete(dfSliceSection[0].slicing);
      // We also don't really need to repeat the comment and requirements
      MVH.deleteEdComment(profile, ssSliceSection[0]);
      MVH.deleteEdComment(profile, dfSliceSection[0]);
      delete(ssSliceSection[0].requirements);
      delete(dfSliceSection[0].requirements);

      // "Personalize" the base slice to this specific element
      if (typeof sourceValue !== 'undefined' && sourceValue instanceof mdls.IdentifiableValue) {
        let short = this.getDescriptionAsShort(sourceValue.effectiveIdentifier);
        short = short ? `${sourceValue.effectiveIdentifier.name}: ${short}` : sourceValue.effectiveIdentifier.name;
        ssSliceSection[0].short = dfSliceSection[0].short = short;
        ssSliceSection[0].definition = dfSliceSection[0].definition =
          this.getDescription(sourceValue.effectiveIdentifier, sourceValue.effectiveIdentifier.name);
      }

      // If a sliceCard was passed in, set it
      if (typeof sliceCard !== 'undefined') {
        setCardinalityOnFHIRElements(sliceCard, ssSliceSection[0], dfSliceSection[0], false);
      }

      // Add the differentials
      profile.differential.element.push(...dfSliceSection);

      // Find the insertion point, which should be at the end of any current slices
      let i = profile.snapshot.element.findIndex(e => e == baseElement) + 1;
      for ( ; i < profile.snapshot.element.length && profile.snapshot.element[i].path.startsWith(baseElement.path); i++);
      // Insert the section
      profile.snapshot.element.splice(i, 0, ...ssSliceSection);

      return ssSliceSection[0];
    }
    //13075, 'Cannot create slice since there is no slice-on command.' ,  'Unknown' , 'errorNumber'
    logger.error('13075');
  }

  // Given a path (identifier array) and a SHR data element definition, it will return the matching value at the tail
  // of the path with all constraints aggregrated onto it
  findValueByPath(path, def, valueOnly=false, parentConstraints=[]) {
    if (path.length == 0) {
      return;
    }

    const fieldsToSearch = [];
    if (typeof def.value !== 'undefined') {
      fieldsToSearch.push(this.mergeConstraintsToChild(parentConstraints, def.value, true));
    }
    if (!valueOnly) {
      fieldsToSearch.push(...(def.fields.map(f => this.mergeConstraintsToChild(parentConstraints, f, false))));
    }
    // Find the value at the root of the path
    let value = this.findValueByIdentifier(path[0], fieldsToSearch);

    // Some special case logic for _Concept (implicit field)
    if (typeof value === 'undefined' && path[0].isConceptKeyWord) {
      if (path.length == 1) {
        // This is the end of the path, so just give them a 1..1 CodeableConcept
        const conceptValue = new mdls.IdentifiableValue(CONCEPT_ID).withMinMax(1, 1);
        if (def.concepts.length == 1) {
          // Add code constraint
          conceptValue.addConstraint(new mdls.CodeConstraint(def.concepts[0]));
        } else if (def.concepts.length > 1) {
          // Update the card to be n to many and add includesCode constraints
          conceptValue.card = new mdls.Cardinality(def.concepts.length);
          for (const c of def.concepts) {
            conceptValue.addConstraint(new mdls.IncludesCodeConstraint(c));
          }
        }
        return conceptValue;
      } else {
        //13061, `Mapping ${pathName1} sub-fields is currently not supported.' ,  'Unknown' , 'errorNumber'
        logger.error({pathName1 : path[0].name }, '13061');
      }
    }

    // If we didn't find the value, it could be one of those cases where we replaced the original identifier with
    // an includesType identifier, so we should check the constraints to look for a match on the includesType.
    if (typeof value === 'undefined' && parentConstraints.length > 0) {
      const cf = new mdls.ConstraintsFilter(parentConstraints);
      for (const itc of cf.includesType.constraints) {
        if (itc.path.length == 1 && itc.isA.equals(path[0])) {

          value = this.findValueByIdentifier(itc.path[0], fieldsToSearch);
          if (typeof value !== 'undefined') {
            value = new mdls.IdentifiableValue(itc.isA).withCard(itc.card).withConstraints(value.constraints);
            // Apply special marker used only in FHIR Exporter.  There is probably a more elegant way, but the
            // alternative right now seems to require a ton of code
            value._derivedFromIncludesTypeConstraint = true;
          }
        }
      }
    }

    if (typeof value !== 'undefined') {
      //value = this.mergeConstraintsToChild(parentConstraints, value, isValueField);
    } else {
      return; // invalid path
    }

    if (path.length == 1) {
      return value; // this was the tail of the path
    }

    // We're not at the end of the path, so we must dig deeper
    def = this._specs.dataElements.findByIdentifier(common.choiceFriendlyEffectiveIdentifier(value));
    if (typeof def === 'undefined') {
      return; // invalid path
    }

    // First see if we can continue the path by traversing the value
    if (typeof def.value !== 'undefined') {
      const subValue = this.findValueByPath(path.slice(1), def, true, value.constraints);
      if (typeof subValue !== 'undefined') {
        return this.mergeConstraintsToChild(value.constraints, subValue, true);
      }
    }

    // Still haven't found it, so traverse the rest
    const subValue = this.findValueByPath(path.slice(1), def, false, value.constraints);
    if (typeof subValue !== 'undefined') {
      return subValue;
    }
  }

  // Given an identifier and a list of values, it will return the matching value, with all constraints aggregrated onto it
  findValueByIdentifier(identifier, values) {
    for (let value of values) {
      if (value instanceof mdls.IdentifiableValue && value.possibleIdentifiers.some(pid => pid.equals(identifier))) {
        // If the identifier isn't the value's direct identifier or effective identifier, it's
        // probably from an includes type.  Check for that case.
        if (!identifier.equals(value.identifier) && !identifier.equals(value.effectiveIdentifier)) {
          for (const itc of value.constraintsFilter.includesType.constraints) {
            if (itc.path.length == 0 && itc.isA.equals(identifier)) {
              // It did resolve from an includes type, so return a value referencing the includes type instead!
              // Remove any of the direct type-ish constraints and card constraints since we're setting type & card
              const constraintsToCopy = value.constraints.filter(c => {
                return c.path.length === 0
                  && !(c instanceof mdls.IncludesTypeConstraint)
                  && !(c instanceof mdls.TypeConstraint)
                  && !(c instanceof mdls.CardConstraint);
              });
              value = new mdls.IdentifiableValue(itc.isA).withCard(itc.card).withConstraints(constraintsToCopy);
              // Apply special marker used only in FHIR Exporter.  There is probably a more elegant way, but the
              // alternative right now seems to require a ton of code
              value._derivedFromIncludesTypeConstraint = true;
              break;
            }
          }
        }
        return value;
      } else if (value instanceof mdls.ChoiceValue) {
        // First check to see if there is a type constraint to make this a single value type
        const typeConstrained = value.constraintsFilter.own.type.constraints.some(c => c.isA.equals(identifier));

        let opt = this.findValueByIdentifier(identifier, value.options);
        if (typeof opt !== 'undefined') {
          // We need to modify cardinality to:
          // (a) use the choice's cardinality, because choice options are now ALWAYS 1..1
          // (b) set min to 0 if there are multiple options (since it will have 0 instances if not selected)
          opt = opt.clone().withCard(value.effectiveCard.clone());
          if (value.options.length > 1 && !typeConstrained) {
            opt.card.min = 0;
          }
          return this.mergeConstraintsToChild(value.constraints, opt);
        }
      }
    }
  }

  mergeConstraintsToChild(parentConstraints, childValue, childIsElementValue=false) {
    let constraints = [];
    for (const cst of parentConstraints) {
      if (childIsElementValue && cst.path.length == 0 && cst.onValue) {
        const transferredCst = cst.clone();
        transferredCst.onValue = false;
        constraints.push(transferredCst);
      } else if (cst.path.length > 0 && (cst.path[0].equals(childValue.identifier) || cst.path[0].equals(common.choiceFriendlyEffectiveIdentifier(childValue)) )) {
        const transferredCst = cst.clone();
        transferredCst.path.shift(); // Remove the first element of the path since we're transferring this to the child
        constraints.push(transferredCst);
      }
    }
    // Remove any type constraints that are no-ops
    constraints = constraints.filter(c => !(c instanceof mdls.TypeConstraint && c.isA.equals(common.choiceFriendlyEffectiveIdentifier(childValue))));
    if (constraints.length == 0) {
      return childValue;
    }
    const mergedChild = childValue.clone();
    // Preserve special marker used only in FHIR Exporter.  There is probably a more elegant way, but the
    // alternative right now seems to require a ton of code
    if (childValue._derivedFromIncludesTypeConstraint) {
      mergedChild._derivedFromIncludesTypeConstraint = true;
    }
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
    switch (MVH.sdType(profile)) {
    case 'Basic': {
      const fqn = profile.identifier[0].value.split('.');
      const identifier = { 'name': fqn.pop(), 'namespace': fqn.join('.') };
      const def = this._specs.dataElements.findByIdentifier(identifier);

      if (!def.isAbstract) {
        let parent, parentProfile;
        if (def.basedOn.length > 0) {
          parent = this._specs.dataElements.findByIdentifier(def.basedOn[0]);
          parentProfile = this.lookupProfile(def.basedOn[0]);
        }

        //Hide warning if the parent profile is also Basic (avoid duplicates through inheritance)
        //Override and show warning anyway if the parent is abstract, as children of abstract should show message
        //Also show warning if there is no warning
        //a. No Parent
        //b. The parent is abstract
        //b. The parent type isn't also basic (avoid duplicate error message) AND the parent isn't abstract (show children of abstracts even if duplicate)
        if (!parentProfile || MVH.sdType(parentProfile) != 'Basic' || parent.isAbstract) {
          // 03004, 'Element profiled on Basic. Consider a more specific mapping.', 'The Basic profile should not be used in most cases. Consider a more specific profile mapping that categorizes the Element being mapped.', 'errorNumber'
          logger.warn('03004');
        }
      }

      break;
    }
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

    if (typeof codeEl === 'undefined' || (codeEl.min == 0 && codeEl.max == '0')) {
      // No need for mapping or constraints when it's profiled out
    } else if (this.elementTypeUnconstrainedCode(profile, codeEl)) {
      // Allow this for "base" classes
      if (!profile.id.endsWith(`-${MVH.sdType(profile)}`)) {
        if (!def._isAbstract) {
          // 03006, 'The ${property} property is not bound to a value set  fixed to a code  or fixed to a quantity unit. This property is core to the target resource and usually should be constrained ', 'Unknown', 'errorNumber'
          logger.info({ property: path }, '03006');
        } else {
          // 03018, 'Abstract Class: The \'${property}\' property is not bound to a value set or fixed to a code. This property is core to the target resource and usually should be constrained.', 'Constrain the property if possible', 'errorNumber'
          logger.warn({ property: path }, '03018');
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
      if (this.codeNotConstrained(profile, pEl, rEl)) {
        const root = el.path.slice(0, -3); // e.g., root of Observation.value[x] is Observation.value
        // As we iterate through, if we find codish or quantity types, we need to check if perhaps they
        // are constrained in a slice.  For example, if value[x] had a CodeableConcept choice, we
        // need to also check the path for valueCodeableConcept.  So we setup a variable to collect
        // the unconstrained paths to check.
        const unconstrainedCodePaths = [];
        for (const t of pEl.type) {
          if (this.typeCodeIsCodishOrQuantity(t.code)) {
            // Push on the constructed slice path (e.g., Observation.valueCodeableConcept)
            unconstrainedCodePaths.push(root + common.capitalize(t.code));
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
            if (! this.codeNotConstrained(profile, pEl2, rEl2)) {
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
    return this.elementTypeIsCodishOrQuantity(el) && this.codeNotConstrained(profile, el, rEl);
  }

  elementTypeIsCodishOrQuantity(el) {
    return el.type && el.type.some(t => this.typeCodeIsCodishOrQuantity(t.code));
  }

  typeCodeIsCodishOrQuantity(typeCode) {
    return typeCode && ['code', 'Coding', 'CodeableConcept', 'Quantity'].indexOf(typeCode) >= 0;
  }

  codeNotConstrained(profile, el, rEl) {
    let rootNotConstrained = rEl && simpleJSONEqual(el.binding, rEl.binding) &&
      simpleJSONEqual(el.fixedCode, rEl.fixedCode) &&
      simpleJSONEqual(el.fixedCoding, rEl.fixedCoding) &&
      simpleJSONEqual(el.fixedCodeableConcept, rEl.fixedCodeableConcept) &&
      simpleJSONEqual(el.fixedQuantity, rEl.fixedQuantity) &&
      simpleJSONEqual(el.patternCode, rEl.patternCode) &&
      simpleJSONEqual(el.patternCoding, rEl.patternCoding) &&
      simpleJSONEqual(el.patternCodeableConcept, rEl.patternCodeableConcept) &&
      simpleJSONEqual(el.patternQuantity, rEl.patternQuantity);
    if (rootNotConstrained) {
      // Now we need to check for possible constraints on the nested elements (e.g., fixed code and system)
      if (el.type && el.type.some(t => t.code === 'Coding' || t.code === 'Quantity')) {
        const [systemEl, codeEl] = this.findSystemAndCodeElements(profile, el, null, false);
        if (systemEl && systemEl.fixedUri) {
          const rSystemEl = this.getOriginalElement(systemEl);
          if (!rSystemEl || systemEl.fixedUri !== rSystemEl.fixedUri) {
            return false;
          }
        }
        if (codeEl && codeEl.fixedCode) {
          const rCodeEl = this.getOriginalElement(codeEl);
          if (!rCodeEl || codeEl.fixedCode !== rCodeEl.fixedCode) {
            return false;
          }
        }
      }
      if (el.type && el.type.some(t => t.code === 'CodeableConcept')) {
        const codings = profile.snapshot.element.filter(pEl => pEl.id.startsWith(el.id) && pEl.path === `${el.path}.coding`);
        const noneConstrained = codings.every(cEl => this.codeNotConstrained(profile, cEl, this.getOriginalElement(cEl)));
        if (!noneConstrained) {
          return false;
        }
      }
    }
    return rootNotConstrained;
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

  isUnitConceptPathOnQuantityBasedProfile(profile, sourcePath) {
    if (sourcePath && sourcePath.length === 2 && sourcePath[0].name === 'Units' && sourcePath[1].name === 'concept') {
      let types = common.getFHIRTypeHierarchy(this._fhir, profile.id);
      if (types.length === 0) {
        types = common.getFHIRTypeHierarchy(this._fhir, MVH.sdType(profile));
      }
      return types.indexOf('Quantity') !== -1;
    }
    return false;
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

function getAggregateFHIRElementCardinality(profile, element, cardOverride) {
  const cards = [];
  const parts = element.id.split('.');
  for (let i=1; i < parts.length; i++) {
    const el = common.getSnapshotElementById(profile, parts.slice(0, i+1).join('.'));
    const card = getFHIRElementCardinality(el);
    const override = cardOverride[el.path.substr(el.path.indexOf('.')+1)];
    if (override) {
      // This happens in slicing, when the cardinality of the slice effectively replaces the cardinality of the array
      cards.push(override);
    } else {
      cards.push(card);
    }
  }
  return aggregateCardinality(...cards);
}

function getFHIRElementCardinality(element) {
  if (typeof element.min != 'undefined' && typeof element.max != 'undefined') {
    // If this is a choice type, any given option actually has lower cardinality 0, since it might not be chosen
    const min = element.type.length > 1 ? 0 : element.min;
    if (element.max == '*') {
      return new mdls.Cardinality(min);
    }
    return new mdls.Cardinality(min, parseInt(element.max, 10));
  }
}

function setCardinalityOnFHIRElements(card, snapshotEl, differentialEl, skipIfEqual=true) {
  const ssCard = getFHIRElementCardinality(snapshotEl);
  if (!skipIfEqual || !ssCard.equals(card)) {
    const originalProperties = { min: snapshotEl.min, max: snapshotEl.max };
    snapshotEl.min = card.min;
    snapshotEl.max = typeof card.max !== 'undefined' ? card.max.toString() : '*';
    if (typeof differentialEl !== 'undefined') {
      // We need to keep track of what the original min/max was and only put something in the diff if it is different.
      // We can't just check against current snapshotEl values because they may have already been changed from the
      // base via a different codepath.
      if (typeof differentialEl._originalProperties === 'undefined') {
        differentialEl._originalProperties = originalProperties;
      }
      if (!skipIfEqual || snapshotEl.min !== differentialEl._originalProperties.min || snapshotEl.max !== differentialEl._originalProperties.max) {
        differentialEl.min = snapshotEl.min;
        differentialEl.max = snapshotEl.max;
      } else {
        delete(differentialEl.min);
        delete(differentialEl.max);
      }
    }
    if (!snapshotEl.base) {
      snapshotEl.base = {
        path: snapshotEl.path,
        min: originalProperties.min,
        max: originalProperties.max
      };
      if (differentialEl != null) {
        differentialEl.base = snapshotEl.base;
      }
    }
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
  let text = `${map.identifier.fqn} maps to ${common.TargetItem.parse(map.targetItem).target}:\n`;
  for (const rule of map.rules) {
    text += `  ${rule.toString()}\n`;
  }
  return text;
}

function typesToString(types) {
  const ts = types.map(t => {
    if (MVH.typeProfile(t)) {
      return `${t.code}<${MVH.typeProfile(t).join(' | ')}>`;
    } else if (MVH.typeTargetProfile(t)) {
      return `${t.code}<ref:${MVH.typeTargetProfile(t).join(' | ')}>`;
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

// Determine if a target is based on (or inherits from) another target.  For example, FHIR's vital signs profile
// (http://hl7.org/fhir/StructureDefinition/vitalsigns) is based on Observation.
//
// NOTE: This function is used by shr-expand to properly allow inheritance of mappings.  For example, if
// A is based on B, and A maps to X and B maps to Y -- then A inherits B's mappings IFF X has Y as a parent
function isTargetBasedOn(target, baseTarget, targetSpec) {
  if (typeof target === 'undefined' || typeof baseTarget === 'undefined') {
    return false;
  } else if (target === baseTarget) {
    // They're the same, so return true (for our purposes 'Foo' is based on 'Foo')
    return true;
  }

  const defs = load(targetSpec);

  // The target has two possible identifiers: the id and the url -- so we need to test against them both.
  // It also has two possible fields identifying its based on: type and baseDefinition, so we need those too.
  const tDef = defs.find(target);
  if (typeof tDef === 'undefined') {
    // Without a definition, we can't tell, so return false
    return false;
  }
  const [tID, tURL, tType, tBaseDef] = [tDef.id, tDef.url, MVH.sdType(tDef), MVH.sdBaseDefinition(tDef)];

  // We need only the identifiers (ID/URL) of the base type we're checking against.
  const bDef = defs.find(baseTarget);
  let bID, bURL;
  if (typeof bDef !== 'undefined') {
    [bID, bURL] = [bDef.id, bDef.url];
  } else {
    // We don't have a definition, so we can't get its inheritance info, but we can use the string passed in as id/url
    bID = bURL = baseTarget;
  }

  // First check if the target is that same as the base
  if (tID === bID || tURL == bURL) {
    return true;
  }
  // Next check if the target based on is the based on
  else if (tType === bID || tBaseDef === bURL) {
    return true;
  }
  else if ((tID !== tType && isTargetBasedOn(tType, bID, targetSpec)) || (tURL !== tBaseDef && isTargetBasedOn(tBaseDef, bURL, targetSpec))) {
    return true;
  }

  return false;
}

function typesHaveSameCodesProfilesAndTargetProfiles(t1, t2) {
  if (t1.length !== t2.length) {
    return false;
  }
  const sameProfiles = (p1, p2) => {
    if (p1 == null) {
      return p2 == null;
    } else if (p2 == null) {
      return false; // we know p1 != null
    } else if (p1.length != p2.length) {
      return false;
    }
    for (let i=0; i < p1.length; i++) {
      if (p1[i] != p2[i]) {
        return false;
      }
    }
    return true;
  };
  for (let i=0; i < t1.length; i++) {
    if (t1[i].code !== t2[i].code || !sameProfiles(MVH.typeProfile(t1[i]), MVH.typeProfile(t2[i])) || !sameProfiles(MVH.typeTargetProfile(t1[i]), MVH.typeTargetProfile(t2[i]))) {
      return false;
    }
  }
  return true;
}

/**
 * Pushes an SHR mapping value (used for toFHIR/fromFHIR serialization) to the mapping property of one or more elements
 * @param {string} shrMap - the string to store in the `map` value of the mapping object
 * @param  {...Object} elements - the elements containing mappings to push the SHR maps onto
 */
function pushShrMapToElementMappings(shrMap, ...elements) {
  for (const element of elements) {
    if (element.mapping == null) {
      element.mapping = [{ identity: 'shr', map: shrMap }];
    }
    // Else if mapping array exists, only add SHR map if it doesn't already exist (no duplicates allowed)
    else if (element.mapping.every(em => em.identity !== 'shr' || em.map !== shrMap)) {
      element.mapping.push({ identity: 'shr', map: shrMap });
    }
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

  clone() {
    const clone = new Stack();
    clone._a = this._a.slice();
    return clone;
  }
}

function errorFilePath() {
  return require('path').join(__dirname, '..', 'errorMessages.txt');
}

module.exports = {exportToFHIR, FHIRExporter, exportIG, setLogger, TARGETS, isTargetBasedOn, MODELS_INFO: mdls.MODELS_INFO, errorFilePath};
