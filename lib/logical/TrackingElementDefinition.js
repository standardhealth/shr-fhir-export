const isEqual = require('lodash/isEqual');
const cloneDeep = require('lodash/cloneDeep');
const ElementDefinition = require('./ElementDefinition');

module.exports = class TrackingElementDefinition extends ElementDefinition {
  constructor(id) {
    super(id);
    this._original = new ElementDefinition();
  }

  newChildElement(name='$UNKNOWN') {
    return new TrackingElementDefinition(`${this.id}.${name}`);
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
};