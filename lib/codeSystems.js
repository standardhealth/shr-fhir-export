const common = require('./common');

class CodeSystemExporter {
  constructor(specifications, fhir) {
    this._specs = specifications;
    this._fhir = fhir;
    this._codeSystemsMap = new Map();
  }

  get codeSystems() {
    return Array.from(this._codeSystemsMap.values());
  }

  lookupCodeSystemByURL(url) {
    return this._codeSystemsMap.get(url);
  }

  export() {
    for (const cs of this._specs.codeSystems.all) {
      this.exportCodeSystem(cs);
    }
  }

  exportCodeSystem(codeSystem) {
    const fhirCS = this._fhir.codeSystemTemplate;
    fhirCS.id = common.fhirID(codeSystem.identifier);
    fhirCS.text.div = getTextDiv(codeSystem);
    fhirCS.url = codeSystem.url;
    fhirCS.identifier.value = codeSystem.identifier.fqn;
    fhirCS.name = fhirCS.title = `SHR ${codeSystem.identifier.name} CodeSystem`;
    fhirCS.date = new Date().toISOString();
    if (codeSystem.description) {
      fhirCS.description = codeSystem.description;
    } else {
      delete(fhirCS.description);
    }
    fhirCS.count = codeSystem.codes.length;

    for (const code of codeSystem.codes) {
      const fhirCode = { code: code.code };
      if (typeof code.display !== 'undefined') {
        fhirCode.display = fhirCode.definition = code.display;
      }
      fhirCS.concept.push(fhirCode);
    }

    this._codeSystemsMap.set(codeSystem.url, fhirCS);
  }
}

function getTextDiv(codeSystem) {
  return `<div xmlns="http://www.w3.org/1999/xhtml">
<p><b>SHR ${common.escapeHTML(codeSystem.identifier.name)} CodeSystem</b></p>
<p>${common.escapeHTML(codeSystem.description)}</p>
</div>`;
}

module.exports = {CodeSystemExporter};