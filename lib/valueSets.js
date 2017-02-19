const common = require('./common');

class ValueSetExporter {
  constructor(specifications, fhir) {
    this._specs = specifications;
    this._fhir = fhir;
    this._valueSetsMap = new Map();
  }

  get valueSets() {
    return Array.from(this._valueSetsMap.values());
  }

  lookupValueSetByURL(url) {
    return this._valueSetsMap.get(url);
  }

  export() {
    for (const vs of this._specs.valueSets.all) {
      this.exportValueSet(vs);
    }
  }

  exportValueSet(valueSet) {
    const fhirVS = this._fhir.valueSetTemplate;
    fhirVS.id = common.fhirID(valueSet.identifier/*, 'valueset'*/);
    fhirVS.text.div = getTextDiv(valueSet);
    fhirVS.url = valueSet.url;
    fhirVS.identifier[0].value = valueSet.identifier.fqn;
    fhirVS.name = fhirVS.title = `SHR ${valueSet.identifier.name} ValueSet`;
    fhirVS.date = new Date().toISOString();
    if (valueSet.description) {
      fhirVS.description = valueSet.description;
    } else {
      delete(fhirVS.description);
    }
    this.exportIncludesDescendentsRules(valueSet, fhirVS);
    this.exportIncludesFromCodeRules(valueSet, fhirVS);
    this.exportIncludesCodeRules(valueSet, fhirVS);
    this.exportExcludesDescendentsRules(valueSet, fhirVS);

    if (fhirVS.compose.include.length == 0) {
      delete(fhirVS.compose.include);
    }
    if (fhirVS.compose.exclude.length == 0) {
      delete(fhirVS.compose.exclude);
    }

    this._valueSetsMap.set(valueSet.url, fhirVS);
  }

  exportIncludesDescendentsRules(valueSet, fhirVS) {
    for (const rule of valueSet.rulesFilter.includesDescendents.rules) {
      fhirVS.compose.include.push({
        system: rule.code.system,
        filter: [{ property: 'concept', op: 'is-a', value: rule.code.code }]
      });
    }
  }

  exportExcludesDescendentsRules(valueSet, fhirVS) {
    for (const rule of valueSet.rulesFilter.excludesDescendents.rules) {
      fhirVS.compose.exclude.push({
        system: rule.code.system,
        filter: [{ property: 'concept', op: 'is-a', value: rule.code.code }]
      });
    }
  }

  exportIncludesFromCodeRules(valueSet, fhirVS) {
    for (const rule of valueSet.rulesFilter.includesFromCode.rules) {
      // TODO: is-a is probably not right here
      fhirVS.compose.include.push({
        system: rule.code.system,
        filter: [{ property: 'concept', op: 'is-a', value: rule.code.code }]
      });
    }
  }

  exportIncludesCodeRules(valueSet, fhirVS) {
    for (const rule of valueSet.rulesFilter.includesCode.rules) {
      let incl = fhirVS.compose.include.find(incl => incl.system == rule.code.system && Array.isArray(incl.concept));
      if (typeof incl === 'undefined') {
        incl = { system: rule.code.system, concept: [] };
        fhirVS.compose.include.push(incl);
      }
      if (typeof rule.code.display !== 'undefined') {
        incl.concept.push({ code: rule.code.code, display: rule.code.display });
      } else {
        incl.concept.push({ code: rule.code.code });
      }
    }
  }
}

function getTextDiv(valueSet) {
  return `<div xmlns="http://www.w3.org/1999/xhtml">
<p><b>SHR ${common.escapeHTML(valueSet.identifier.name)} ValueSet</b></p>
<p>${common.escapeHTML(valueSet.description)}</p>
</div>`;
}

module.exports = {ValueSetExporter};