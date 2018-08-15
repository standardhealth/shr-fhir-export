const cloneDeep = require('lodash/cloneDeep');
const ElementDefinition = require('./ElementDefinition');

/**
 * A class representing a FHIR StructureDefinition.  For the most part, each allowable property in a StructureDefinition
 * is represented via a get/set in this class, and the value is expected to be the FHIR-compliant JSON that would go
 * in the StructureDefinition JSON file.
 *
 * The snapshot and differential, however, do not have their own properties, but rather are represented as an
 * `elements` get/set property, whose value is a list of `ElementDefinition` instances.
 *
 * @see {@link http://hl7.org/fhir/STU3/structuredefinition.html|FHIR StructureDefinition}
 */
class StructureDefinition {
  /**
   * Constructs a StructureDefinition with a root element.
   */
  constructor() {
    // Every structure definition needs a root element
    const root = new ElementDefinition('');
    root.structDef = this;
    root.min = 0;
    root.max = '*';
    root.mustSupport = false;
    root.isModifier = false;
    root.isSummary = false;
    this._elements = [root];
  }

  /**
   * @returns {string} id
   */
  get id() { return this._id; }
  /**
   * Sets the id of the StructureDefinition.  This also iterates the elements, updating each element id to reflect
   * the new StructureDefinition ID.
   * @param {string} id - the StructureDefinition id
   */
  set id(id) {
    this._id = id;
    // Setting the id affects the root of every element id!
    this._elements.forEach(e => e.id = e.id.replace(/^[^:\.]*/, id) );
  }

  /**
   * @returns {Object} meta
   */
  get meta() { return this._meta; }
  /**
   * @param {Object} meta
   */
  set meta(meta) { this._meta = meta; }

  /**
   * @returns {string} implicitRules
   */
  get implicitRules() { return this._implicitRules; }
  /**
   * @param {string} implicitRules
   */
  set implicitRules(implicitRules) { this._implicitRules = implicitRules; }

  /**
   * @returns {string} language
   */
  get language() { return this._language; }
  /**
   * @param {string} language
   */
  set language(language) { this._language = language; }

  /**
   * @returns {Object} text
   */
  get text() { return this._text; }
  /**
   * @param {Object} text
   */
  set text(text) { this._text = text; }

  /**
   * @returns {Object[]} contained
   */
  get contained() { return this._contained; }
  /**
   * @param {Object[]} contained
   */
  set contained(contained) { this._contained = contained; }

  /**
   * @returns {Object[]} extension
   */
  get extension() { return this._extension; }
  /**
   * @param {Object[]} extension
   */
  set extension(extension) { this._extension = extension; }

  /**
   * @returns {Object[]} modifierExtension
   */
  get modifierExtension() { return this._modifierExtension; }
  /**
   * @param {Object[]} modifierExtension
   */
  set modifierExtension(modifierExtension) { this._modifierExtension = modifierExtension; }

  /**
   * @returns {string} url
   */
  get url() { return this._url; }
  /**
   * @param {string} url
   */
  set url(url) { this._url = url; }

  /**
   * @returns {Object[]} array of identifiers
   */
  get identifier() { return this._identifier; }
  /**
   * @param {Object[]} identifier - array of identifiers
   */
  set identifier(identifier) { this._identifier = identifier; }

  /**
   * @returns {string} version
   */
  get version() { return this._version; }
  /**
   * @param {string} version
   */
  set version(version) { this._version = version; }

  /**
   * @returns {string} name
   */
  get name() { return this._name; }
  /**
   * @param {string} name
   */
  set name(name) { this._name = name; }

  /**
   * @returns {string} title
   */
  get title() { return this._title; }
  /**
   * @param {string} title
   */
  set title(title) { this._title = title; }

  /**
   * @returns {string} status
   */
  get status() { return this._status; }
  /**
   * @param {string} status
   */
  set status(status) { this._status = status; }

  /**
   * @returns {boolean} experimental
   */
  get experimental() { return this._experimental; }
  /**
   * @param {boolean} experimental
   */
  set experimental(experimental) { this._experimental = experimental; }

  /**
   * @returns {string} date
   */
  get date() { return this._date; }
  /**
   * @param {string} date
   */
  set date(date) { this._date = date; }

  /**
   * @returns {string} publisher
   */
  get publisher() { return this._publisher; }
  /**
   * @param {string} publisher
   */
  set publisher(publisher) { this._publisher = publisher; }

  /**
   * @returns {Object[]} contact
   */
  get contact() { return this._contact; }
  /**
   * @param {Object[]} contact
   */
  set contact(contact) { this._contact = contact; }

  /**
   * @returns {string} description
   */
  get description() { return this._description; }
  /**
   * Sets the StructureDefinitions's description.  This also updates the definition in the root element.
   * @param {string} description - the markdown-formatted description of the StructureDefinition
   */
  set description(description) {
    this._description = description;
    // Also reflect the description in the root element
    this._elements[0].definition = description;
  }

  /**
   * @returns {Object[]} useContext
   */
  get useContext() { return this._useContext; }
  /**
   * @param {Object[]} useContext
   */
  set useContext(useContext) { this._useContext = useContext; }

  /**
   * @returns {Object[]} jurisdiction
   */
  get jurisdiction() { return this._jurisdiction; }
  /**
   * @param {Object[]} jurisdiction
   */
  set jurisdiction(jurisdiction) { this._jurisdiction = jurisdiction; }

  /**
   * @returns {string} purpose
   */
  get purpose() { return this._purpose; }
  /**
   * @param {string} purpose
   */
  set purpose(purpose) { this._purpose = purpose; }

  /**
   * @returns {string} copyright
   */
  get copyright() { return this._copyright; }
  /**
   * @param {string} copyright
   */
  set copyright(copyright) { this._copyright = copyright; }

  /**
   * @returns {Object[]} keyword
   */
  get keyword() { return this._keyword; }
  /**
   * @param {Object[]} keyword
   */
  set keyword(keyword) { this._keyword = keyword; }

  /**
   * @returns {string} fhirVersion
   */
  get fhirVersion() { return this._fhirVersion; }
  /**
   * @param {string} fhirVersion
   */
  set fhirVersion(fhirVersion) { this._fhirVersion = fhirVersion; }

  /**
   * @returns {{identity: string, uri?: string, name?: string, comment?: string}[]} mapping
   */
  get mapping() { return this._mapping; }
  /**
   * @param {{identity: string, uri?: string, name?: string, comment?: string}[]} mapping
   */
  set mapping(mapping) { this._mapping = mapping; }

  /**
   * @returns {string} kind
   */
  get kind() { return this._kind; }
  /**
   * @param {string} kind
   */
  set kind(kind) { this._kind = kind; }

  /**
   * @returns {boolean} abstract
   */
  get abstract() { return this._abstract; }
  /**
   * @param {boolean} abstract
   */
  set abstract(abstract) { this._abstract = abstract; }

  /**
   * @returns {string} contextType
   */
  get contextType() { return this._contextType; }
  /**
   * @param {string} contextType
   */
  set contextType(contextType) { this._contextType = contextType; }

  /**
   * @returns {string[]} context
   */
  get context() { return this._context; }
  /**
   * @param {string[]} context
   */
  set context(context) { this._context = context; }

  /**
   * @returns {string[]} contextInvariant
   */
  get contextInvariant() { return this._contextInvariant; }
  /**
   * @param {string[]} contextInvariant
   */
  set contextInvariant(contextInvariant) { this._contextInvariant = contextInvariant; }

  /**
   * @returns {string} type
   */
  get type() { return this._type; }
  /**
   * @param {string} type
   */
  set type(type) { this._type = type; }

  /**
   * @returns {string} baseDefinition
   */
  get baseDefinition() { return this._baseDefinition; }
  /**
   * @param {string} baseDefinition
   */
  set baseDefinition(baseDefinition) { this._baseDefinition = baseDefinition; }

  /**
   * @returns {string} derivation
   */
  get derivation() { return this._derivation; }
  /**
   * @param {string} derivation
   */
  set derivation(derivation) { this._derivation = derivation; }

  /**
   * Gets the StructureDefinition's elements.  The returned array should not be pushed to directly.  Instead, use
   * the {@link addElement} or {@link addElements} function.
   * @returns {ElementDefinition[]} the StructureDefinition's elements
   *
   */
  get elements() { return this._elements; }
  set elements(elements) { this._elements = elements; }

  /**
   * Adds an ElementDefinition to the StructureDefinition's elements, inserting it into the proper location based
   * on its ID.  This should be used rather than pushing directly to the elements array.
   * @param {ElementDefinition} element - the ElementDefinition to add
   */
  addElement(element) {
    let i = 0;
    let lastMatchId = '';
    for (; i < this.elements.length; i++) {
      const currentId = this.elements[i].id;
      if (element.id.startsWith(currentId)) {
        lastMatchId = currentId;
      } else if (currentId.endsWith('[x]') && element.id.startsWith(currentId.slice(0, -3))) {
        // Above condition is special handling to ensure that `valueFoo` gets properly grouped with `value[x]`
        lastMatchId = currentId;
      } else if (!currentId.startsWith(lastMatchId)) {
        break;
      }
    }
    this.elements.splice(i, 0, element);
  }

  /**
   * Adds an array of ElementDefinitions to the StructureDefinition, inserting each one into the proper location based
   * on its ID.  This should be used rather than pushing directly to the elements array.
   * @param {ElementDefinition[]} elements - the array of ElementDefinitions to add
   */
  addElements(elements = []) {
    elements.forEach(e => this.addElement(e));
  }

  /**
   * Finds an element by its id.
   * @param {string} id
   * @returns {ElementDefinition} the found element (or undefined if it is not found)
   */
  findElement(id) {
    if (!id) {
      return;
    }
    return this.elements.find(e => e.id === id);
  }

  /**
   * Creates a new element and adds it to the StructureDefinition elements.
   * @param {string} name - the name of the element to create (which will be appended to the element ID)
   * @returns {ElementDefinition} the new ElementDefinition
   */
  newElement(name='$UNKNOWN') {
    const el = this._elements[0].newChildElement(name);
    this.addElement(el);
    return el;
  }

  /**
   * Exports the StructureDefinition to a properly formatted FHIR JSON representation.
   * @returns {Object} the FHIR JSON representation of the StructureDefinition
   */
  toJSON() {
    const j = { resourceType: 'StructureDefinition' };
    // First handle properties that are just straight translations to JSON
    for (const prop of PROPS) {
      if (this[prop] !== undefined) {
        j[prop] = cloneDeep(this[prop]);
      }
    }
    // Now handle snapshot and differential
    j.snapshot = { element: this._elements.map(e => e.toJSON() ) };
    j.differential = { element: this._elements.filter(e => e.hasDiff()).map(e => e.calculateDiff().toJSON())};
    return j;
  }

  /**
   * Constructs a new StructureDefinition representing the passed in JSON.  The JSON that is passed in must be a
   * properly formatted FHIR 3.0.1 StructureDefinition JSON.
   * @param {Object} json - the FHIR 3.0.1 JSON representation of a StructureDefinition to construct
   * @returns {StructureDefinition} a new StructureDefinition instance representing the passed in JSON
   */
  static fromJSON(json) {
    const sd = new StructureDefinition();
    // First handle properties that are just straight translations from JSON
    for (const prop of PROPS) {
      if (json[prop] !== undefined) {
        sd[prop] = cloneDeep(json[prop]);
      }
    }
    // Now handle the snapshots and (for now) just throw away the differential
    sd.elements.length = 0;
    if (json.snapshot && json.snapshot.element) {
      for (const el of json.snapshot.element) {
        const ed = ElementDefinition.fromJSON(el);
        // @ts-ignore
        ed.structDef = this;
        sd.elements.push(ed);
      }
    }
    return sd;
  }
}

/**
 * The list of StructureDefinition properties used when importing/exporting FHIR JSON.
 */
const PROPS = [ 'id', 'meta', 'implicitRules', 'language', 'text', 'contained', 'extension',
  'modifierExtension', 'url', 'identifier', 'version', 'name', 'title', 'status', 'experimental', 'date',
  'publisher', 'contact', 'description', 'useContext', 'jurisdiction', 'purpose', 'copyright', 'keyword',
  'fhirVersion', 'mapping', 'kind', 'abstract', 'contextType', 'context', 'contextInvariant', 'type',
  'baseDefinition', 'derivation'];

module.exports = StructureDefinition;