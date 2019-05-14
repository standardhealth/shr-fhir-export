const common = require('./common');
const MVH = require('./multiVersionHelper');

class CodeSystemExporter {
  constructor(specifications, fhir, configuration) {
    this._specs = specifications;
    this._fhir = fhir;
    this._config = configuration;
    this._target = common.getTarget(this._config, this._specs);
    this._codeSystemsMap = new Map();
  }

  get codeSystems() {
    const systems = Array.from(this._codeSystemsMap.values());
    if (this._basicResourceTypeCodeSystem != null) {
      systems.push(this._basicResourceTypeCodeSystem);
    }
    return systems;
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
    MVH.setCsIdentifier(fhirCS, [{ system: this._config.projectURL, value: codeSystem.identifier.fqn}], this._target);
    fhirCS.name = common.tokenize(codeSystem.identifier.name);
    fhirCS.title = codeSystem.identifier.name;
    fhirCS.date = this._config.publishDate || common.todayString();
    fhirCS.publisher = this._config.publisher;
    fhirCS.contact = this._config.contact;
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

  addTypeToBasicResourceTypeCodeSystem(typeCode, typeDescription) {
    if (this._basicResourceTypeCodeSystem == null) {
      const fhirCS = this._fhir.codeSystemTemplate;
      fhirCS.id = `${this._config.projectShorthand}-basic-resource-type`;
      fhirCS.text.div = `<div xmlns="http://www.w3.org/1999/xhtml">
<p><b>${common.escapeHTML(this._config.projectShorthand)} Basic Resource Type CodeSystem</b></p>
<p>Codes representing profiles on the Basic resource.</p>
</div>`;
      fhirCS.url = `${this._config.fhirURL}/CodeSystem/${this._config.projectShorthand}-basic-resource-type`;
      MVH.setCsIdentifier(fhirCS, [{ system: this._config.projectURL, value: `${this._config.projectShorthand}-basic-resource-type`}], this._target);
      fhirCS.name = 'BasicResourceType';
      fhirCS.title = `${this._config.projectShorthand} Basic Resource Type CodeSystem`;
      fhirCS.date = this._config.publishDate || common.todayString();
      fhirCS.publisher = this._config.publisher;
      fhirCS.contact = this._config.contact;
      fhirCS.description = 'Codes representing profiles on the Basic resource.';
      fhirCS.count = 0;
      this._basicResourceTypeCodeSystem = fhirCS;
    }
    const fhirCode = { code: typeCode };
    if (typeDescription != null) {
      fhirCode.display = typeDescription.trim();
    }
    this._basicResourceTypeCodeSystem.concept.push(fhirCode);
    this._basicResourceTypeCodeSystem.count = this._basicResourceTypeCodeSystem.concept.length;
  }
}

function getTextDiv(codeSystem) {
  return `<div xmlns="http://www.w3.org/1999/xhtml">
<p><b>${common.escapeHTML(codeSystem.identifier.name)} CodeSystem</b></p>
<p>${common.escapeHTML(codeSystem.description)}</p>
</div>`;
}

module.exports = {CodeSystemExporter};