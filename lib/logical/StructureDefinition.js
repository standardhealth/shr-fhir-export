const cloneDeep = require('lodash/cloneDeep');
const TrackingElementDefinition = require('./TrackingElementDefinition');

module.exports = class StructureDefinition {
  constructor() {
    // Every structure definition needs a root element
    const root = new TrackingElementDefinition('');
    root.structDef = this;
    root.mustSupport = false;
    root.isModifier = false;
    root.isSummary = false;
    this._elements = [root];
  }
  get id() { return this._id; }
  set id(id) {
    this._id = id;
    // Setting the id affects the root of every element id!
    this._elements.forEach(e => e.id = e.id.replace(/^[^:\.]*/, id) );
  }

  get meta() { return this._meta; }
  set meta(meta) { this._meta = meta; }

  get implicitRules() { return this._implicitRules; }
  set implicitRules(implicitRules) { this._implicitRules = implicitRules; }

  get language() { return this._language; }
  set language(language) { this._language = language; }

  get text() { return this._text; }
  set text(text) { this._text = text; }

  get contained() { return this._contained; }
  set contained(contained) { this._contained = contained; }

  get extension() { return this._extension; }
  set extension(extension) { this._extension = extension; }

  get modifierExtension() { return this._modifierExtension; }
  set modifierExtension(modifierExtension) { this._modifierExtension = modifierExtension; }

  get url() { return this._url; }
  set url(url) { this._url = url; }

  get identifier() { return this._identifier; }
  set identifier(identifier) { this._identifier = identifier; }

  get version() { return this._version; }
  set version(version) { this._version = version; }

  get name() { return this._name; }
  set name(name) { this._name = name; }

  get title() { return this._title; }
  set title(title) { this._title = title; }

  get status() { return this._status; }
  set status(status) { this._status = status; }

  get experimental() { return this._experimental; }
  set experimental(experimental) { this._experimental = experimental; }

  get date() { return this._date; }
  set date(date) { this._date = date; }

  get publisher() { return this._publisher; }
  set publisher(publisher) { this._publisher = publisher; }

  get contact() { return this._contact; }
  set contact(contact) { this._contact = contact; }

  get description() { return this._description; }
  set description(description) {
    this._description = description;
    // Also reflect the description in the root element
    this._elements[0].definition = description;
  }

  get useContext() { return this._useContext; }
  set useContext(useContext) { this._useContext = useContext; }

  get jurisdiction() { return this._jurisdiction; }
  set jurisdiction(jurisdiction) { this._jurisdiction = jurisdiction; }

  get purpose() { return this._purpose; }
  set purpose(purpose) { this._purpose = purpose; }

  get copyright() { return this._copyright; }
  set copyright(copyright) { this._copyright = copyright; }

  get keyword() { return this._keyword; }
  set keyword(keyword) { this._keyword = keyword; }

  get fhirVersion() { return this._fhirVersion; }
  set fhirVersion(fhirVersion) { this._fhirVersion = fhirVersion; }

  get mapping() { return this._mapping; }
  set mapping(mapping) { this._mapping = mapping; }

  get kind() { return this._kind; }
  set kind(kind) { this._kind = kind; }

  get abstract() { return this._abstract; }
  set abstract(abstract) { this._abstract = abstract; }

  get contextType() { return this._contextType; }
  set contextType(contextType) { this._contextType = contextType; }

  get context() { return this._context; }
  set context(context) { this._context = context; }

  get contextInvariant() { return this._contextInvariant; }
  set contextInvariant(contextInvariant) { this._contextInvariant = contextInvariant; }

  get type() { return this._type; }
  set type(type) { this._type = type; }

  get baseDefinition() { return this._baseDefinition; }
  set baseDefinition(baseDefinition) { this._baseDefinition = baseDefinition; }

  get derivation() { return this._derivation; }
  set derivation(derivation) { this._derivation = derivation; }

  get elements() { return this._elements; }
  set elements(elements) { this._elements = elements; }

  newElement(name='$UNKNOWN') {
    const el = this._elements[0].newChildElement(name);
    this._elements.push(el);
    return el;
  }

  toJSON() {
    const j = { resourceType: 'StructureDefinition' };
    // First handle properties that are just straight translations to JSON
    const PROPS = [ '_id', '_meta', '_implicitRules', '_language', '_text', '_contained', '_extension',
      '_modifierExtension', '_url', '_identifier', '_version', '_name', '_title', '_status', '_experimental', '_date',
      '_publisher', '_contact', '_description', '_useContext', '_jurisdiction', '_purpose', '_copyright', '_keyword',
      '_fhirVersion', '_mapping', '_kind', '_abstract', '_contextType', '_context', '_contextInvariant', '_type',
      '_baseDefinition', '_derivation'];
    for (const prop of PROPS) {
      if (this[prop] !== undefined) {
        j[prop.slice(1)] = cloneDeep(this[prop]);
      }
    }
    // Now handle snapshot and differential
    j.snapshot = { element: this._elements.map(e => e.toJSON() ) };
    j.differential = { element: this._elements.filter(e => e.hasDiff()).map(e => e.calculateDiff().toJSON())};
    return j;
  }
};