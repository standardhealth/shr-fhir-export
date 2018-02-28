const isEqual = require('lodash/isEqual');
const cloneDeep = require('lodash/cloneDeep');
const ElementDefinition = require('./ElementDefinition');

module.exports = class TrackingElementDefinition extends ElementDefinition {
  constructor(id) {
    super(id);
    this._original = new ElementDefinition();
  }

  get structDef() { return this._structDef; }
  set structDef(structDef) { this._structDef = structDef; }

  newChildElement(name='$UNKNOWN') {
    const el = new TrackingElementDefinition(`${this.id}.${name}`);
    el.structDef = this.structDef;
    return el;
  }

  captureOriginal() {
    this._original = cloneDeep(this);
  }

  hasDiff() {
    return ElementDefinition._PROPS.some(prop => !isEqual(this[prop], this._original[prop]));
  }

  calculateDiff() {
    const diff = new ElementDefinition();
    for (const prop of ElementDefinition._PROPS) {
      if (!isEqual(this[prop], this._original[prop])) diff[prop] = cloneDeep(this[prop]);
    }
    return diff;
  }

  applyBinding(vsURI, strength) {
    // TODO: Add error checking such as (1) if this is a code-ish element, (2) if there already is a binding.
    // But this is not needed now since these are used for standalone, "greenfield" models.
    this.binding = {
      strength,
      valueSetReference: {
        reference: vsURI
      }
    };
  }
};