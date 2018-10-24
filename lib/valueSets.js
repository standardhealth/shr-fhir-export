const common = require('./common');
const MVH = require('./multiVersionHelper');

class ValueSetExporter {
  constructor(specifications, fhir, configuration) {
    this._specs = specifications;
    this._fhir = fhir;
    this._config = configuration;
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
    fhirVS.text.div = getTextDiv(valueSet, this._config.projectShorthand);
    fhirVS.url = valueSet.url;
    MVH.setVsIdentifier(fhirVS, [{ system: this._config.projectURL, value: valueSet.identifier.fqn}]);
    fhirVS.name = `${valueSet.identifier.name}`;
    MVH.setVsTitle(fhirVS, `${this._config.projectShorthand} ${valueSet.identifier.name} ValueSet`);
    fhirVS.date = this._config.publishDate || common.todayString();
    fhirVS.publisher = this._config.publisher;
    fhirVS.contact = this._config.contact;
    if (valueSet.description) {
      fhirVS.description = valueSet.description.trim();
    } else {
      delete(fhirVS.description);
    }
    this.exportIncludesDescendentsRules(valueSet, fhirVS);
    this.exportIncludesFromCodeSystemRules(valueSet, fhirVS);
    this.exportIncludesFromCodeRules(valueSet, fhirVS);
    this.exportIncludesCodeRules(valueSet, fhirVS);
    this.exportExcludesDescendentsRules(valueSet, fhirVS);

    if (fhirVS.compose.include.length == 0) {
      delete(fhirVS.compose.include);
    }
    if (fhirVS.compose.exclude.length == 0) {
      delete(fhirVS.compose.exclude);
    }

    if (fhirVS.codeSystem) {
      if (fhirVS.codeSystem.system === '') {
        delete(fhirVS.codeSystem);
      } else if (Object.keys(fhirVS.compose).length === 0) {
        delete(fhirVS.compose);
      }
    }

    this._valueSetsMap.set(valueSet.url, fhirVS);
  }

  exportIncludesDescendentsRules(valueSet, fhirVS) {
    for (const rule of valueSet.rulesFilter.includesDescendents.rules) {
      if (rule.code.system == 'urn:tbd') {
        continue;
      }
      fhirVS.compose.include.push({
        system: rule.code.system,
        filter: [{ property: 'concept', op: 'is-a', value: rule.code.code }]
      });
    }
  }

  exportExcludesDescendentsRules(valueSet, fhirVS) {
    for (const rule of valueSet.rulesFilter.excludesDescendents.rules) {
      if (rule.code.system == 'urn:tbd') {
        continue;
      }
      fhirVS.compose.exclude.push({
        system: rule.code.system,
        filter: [{ property: 'concept', op: 'is-a', value: rule.code.code }]
      });
    }
  }

  exportIncludesFromCodeSystemRules(valueSet, fhirVS) {
    for (const rule of valueSet.rulesFilter.includesFromCodeSystem.rules) {
      if (rule.system == 'urn:tbd') {
        continue;
      }
      fhirVS.compose.include.push({
        system: rule.system
      });
    }
  }

  exportIncludesFromCodeRules(valueSet, fhirVS) {
    for (const rule of valueSet.rulesFilter.includesFromCode.rules) {
      if (rule.code.system == 'urn:tbd') {
        continue;
      }
      // TODO: is-a is probably not right here
      fhirVS.compose.include.push({
        system: rule.code.system,
        filter: [{ property: 'concept', op: 'is-a', value: rule.code.code }]
      });
    }
  }

  exportIncludesCodeRules(valueSet, fhirVS) {
    // If this is FHIR DSTU2, set up the corresponding inline code system if applicable
    if (fhirVS.codeSystem) {
      const inlineCS = this._specs.codeSystems.find(valueSet.identifier.namespace, valueSet.identifier.name.replace(/VS$/, 'CS'));
      if (inlineCS) {
        fhirVS.codeSystem.system = inlineCS.url;
      }
    }
    for (const rule of valueSet.rulesFilter.includesCode.rules) {
      if (rule.code.system == 'urn:tbd') {
        continue;
      } else if (fhirVS.codeSystem && rule.code.system === fhirVS.codeSystem.system) {
        // DSTU2 inline code system code
        const concept = { code: rule.code.code };
        if (rule.code.display != null) {
          concept.display = concept.definition = rule.code.display.trim();
        }
        fhirVS.codeSystem.concept.push(concept);
      } else {
        let incl = fhirVS.compose.include.find(incl => incl.system == rule.code.system && Array.isArray(incl.concept));
        if (typeof incl === 'undefined') {
          incl = { system: rule.code.system, concept: [] };
          fhirVS.compose.include.push(incl);
        }
        if (typeof rule.code.display !== 'undefined') {
          incl.concept.push({ code: rule.code.code, display: rule.code.display.trim() });
        } else {
          incl.concept.push({ code: rule.code.code });
        }
      }
    }
  }
}

function getTextDiv(valueSet, projectShorthand) {
  return `<div xmlns="http://www.w3.org/1999/xhtml">
<p><b>${common.escapeHTML(projectShorthand + ' ' + valueSet.identifier.name)} ValueSet</b></p>
<p>${common.escapeHTML(valueSet.description)}</p>
</div>`;
}

module.exports = {ValueSetExporter};