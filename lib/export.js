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
    this._errors = [];
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
    profile.url = `http://standardhealthrecord.org/fhir/StructureDefinition/${fhirID(map.identifier)}`;
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
    this.processFieldMappings(map, profile);

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
    profile.differential = { element: [] };
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
    for (const value of [def.value, ...def.fields]) {
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

function fhirID(identifier) {
  return `${identifier.namespace.replace('.', '-')}-${identifier.name.toLowerCase()}`;
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