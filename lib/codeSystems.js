const common = require('./common');

class CodeSystemExporter {
  constructor(specifications, fhir, configuration) {
    this._specs = specifications;
    this._fhir = fhir;
    this._config = configuration;
    this._codeSystemsMap = new Map();
  }

  get codeSystems() {
    return Array.from(this._codeSystemsMap.values());
  }

  lookupCodeSystemByURL(url) {
    return this._codeSystemsMap.get(url);
  }

  export(profiles, valueSets) {
    let usedCodeSystems = [];
    // get all code systems from profile differentials
    // not all fixedUri are necessarily code systems,
    // and not all are relevant, but this is fine for
    // our filtering purposes
    for (const profile of profiles) {
      if (profile.differential.element != null) {
        for (const element of profile.differential.element) {
          if (element.fixedUri) {
            usedCodeSystems.push(element.fixedUri);
          }
        }
      }
    }

    // get all code systems from value sets
    // not all systems are relevant, but this
    // is fine for our filtering purposes
    for (const valueSet of valueSets) {
      if (valueSet.compose.include != null) {
        for (const include of valueSet.compose.include) {
          if (include.system) {
            usedCodeSystems.push(include.system);
          }
        }
      }
    }

    // if filtering, only export used code systems
    let filter = false;
    if (this._config.igPrimarySelectionStrategy != null) {
      filter = this._config.igPrimarySelectionStrategy.filter;
    }
    for (const cs of this._specs.codeSystems.all) {
      if ((!filter)
      || (usedCodeSystems.includes(cs.url))) {
        this.exportCodeSystem(cs);
      }
    }
  }

  exportCodeSystem(codeSystem) {
    const fhirCS = this._fhir.codeSystemTemplate;
    fhirCS.id = common.fhirID(codeSystem.identifier);
    fhirCS.text.div = getTextDiv(codeSystem, this._config.projectShorthand);
    fhirCS.url = codeSystem.url;
    fhirCS.identifier.value = codeSystem.identifier.fqn;
    fhirCS.name = codeSystem.identifier.name;
    fhirCS.title = `${this._config.projectShorthand} ${codeSystem.identifier.name} CodeSystem`;
    fhirCS.date = this._config.publishDate || common.todayString();
    fhirCS.publisher = this._config.publisher;
    fhirCS.contact = this._config.contact;
    fhirCS.identifier.system = this._config.projectURL;
    if (codeSystem.description) {
      fhirCS.description = codeSystem.description.trim();
    } else {
      delete(fhirCS.description);
    }
    fhirCS.count = codeSystem.codes.length;

    for (const code of codeSystem.codes) {
      if (code.system == 'urn:tbd') {
        continue;
      }
      const fhirCode = { code: code.code };
      if (typeof code.display !== 'undefined') {
        fhirCode.display = fhirCode.definition = code.display.trim();
      }
      fhirCS.concept.push(fhirCode);
    }

    this._codeSystemsMap.set(codeSystem.url, fhirCS);
  }
}

function getTextDiv(codeSystem, projectShorthand) {
  return `<div xmlns="http://www.w3.org/1999/xhtml">
<p><b>${common.escapeHTML(projectShorthand + ' ' + codeSystem.identifier.name)} CodeSystem</b></p>
<p>${common.escapeHTML(codeSystem.description)}</p>
</div>`;
}

module.exports = {CodeSystemExporter};
